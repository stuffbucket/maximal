#!/usr/bin/env bun
/**
 * Reconcile CodeQL alert state against ADR frontmatter.
 *
 * Reads every `docs/decisions/*.md` in this repo, parses the YAML
 * frontmatter between the leading `---` markers, and collects
 * `codeql_dismissals` entries — each `{rule, path, line, reason,
 * rationale}`. Then walks the live CodeQL alert state via the GitHub
 * Code Scanning API and enforces:
 *
 *   - Open alert that matches an ADR entry  → dismiss it.
 *   - Dismissed alert with the wrong reason → fix the reason.
 *   - Dismissed alert NOT covered by any ADR → re-open it.
 *   - ADR entry with no matching alert       → log a warning.
 *
 * Local run (dry-run, requires `gh` logged in):
 *
 *   bun run scripts/reconcile-codeql.ts --dry-run
 *
 * Live run (in CI; uses GITHUB_TOKEN with security-events: write):
 *
 *   bun run scripts/reconcile-codeql.ts
 *
 * The URL used to hit the API is built from `process.env.GITHUB_REPOSITORY`
 * (or `git remote get-url origin` locally) plus literal endpoint paths.
 * The contents of the ADR files NEVER taint a URL — only the
 * (rule, path, line) tuple is consumed, never as a network input.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { parse as parseYaml } from "yaml"

interface AdrEntry {
  rule: string
  path: string
  line: number
  reason: string
  rationale: string
  sourceFile: string
}

interface AlertLocation {
  path: string
  start_line: number
}

interface AlertInstance {
  location: AlertLocation
}

interface AlertRule {
  id: string
}

interface CodeQlAlert {
  number: number
  state: "open" | "dismissed" | "fixed"
  dismissed_reason: string | null
  dismissed_comment: string | null
  rule: AlertRule
  most_recent_instance: AlertInstance
}

interface ReconcilePlan {
  dismiss: Array<{ alert: CodeQlAlert; entry: AdrEntry }>
  fixReason: Array<{ alert: CodeQlAlert; entry: AdrEntry }>
  reopen: Array<CodeQlAlert>
  inSync: Array<{ alert: CodeQlAlert; entry: AdrEntry }>
  orphanAdr: Array<AdrEntry>
}

const ALLOWED_DISMISS_REASONS = new Set([
  "false positive",
  "won't fix",
  "used in tests",
])

const decisionsDir = path.resolve("docs/decisions")

function key(rule: string, p: string, line: number): string {
  return `${rule}::${p}::${line}`
}

function isStringRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function parseFrontmatter(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith("---")) return null
  const end = raw.indexOf("\n---", 3)
  if (end === -1) return null
  const yamlBlock = raw.slice(3, end).replace(/^\r?\n/, "")
  const parsed: unknown = parseYaml(yamlBlock)
  return isStringRecord(parsed) ? parsed : null
}

function firstSentence(text: string, maxLen = 280): string {
  const flat = text.replace(/\s+/g, " ").trim()
  const dot = flat.indexOf(". ")
  const candidate = dot === -1 ? flat : flat.slice(0, dot + 1)
  return candidate.length > maxLen ? `${candidate.slice(0, maxLen - 1)}…` : candidate
}

async function loadAdrEntries(): Promise<Array<AdrEntry>> {
  let files: Array<string>
  try {
    files = await fs.readdir(decisionsDir)
  } catch {
    console.warn(`[reconcile] no docs/decisions/ directory; nothing to do.`)
    return []
  }
  const mdFiles = files.filter((f) => f.endsWith(".md")).sort()
  const seen = new Map<string, AdrEntry>()
  const out: Array<AdrEntry> = []

  for (const f of mdFiles) {
    const full = path.join(decisionsDir, f)
    const raw = await fs.readFile(full, "utf8")
    const fm = parseFrontmatter(raw)
    if (!fm) continue
    const dismissals = fm["codeql_dismissals"]
    if (dismissals === undefined) continue
    if (!Array.isArray(dismissals)) {
      throw new Error(`[reconcile] ${f}: codeql_dismissals must be an array`)
    }
    for (const item of dismissals) {
      if (!isStringRecord(item)) {
        throw new Error(`[reconcile] ${f}: codeql_dismissals entry must be an object`)
      }
      const rule = item["rule"]
      const p = item["path"]
      const line = item["line"]
      const reason = item["reason"]
      const rationale = item["rationale"]
      if (typeof rule !== "string" || typeof p !== "string" || typeof line !== "number"
        || typeof reason !== "string" || typeof rationale !== "string") {
        throw new Error(`[reconcile] ${f}: each entry needs string rule/path/reason/rationale and numeric line`)
      }
      if (!ALLOWED_DISMISS_REASONS.has(reason)) {
        throw new Error(
          `[reconcile] ${f}: reason ${JSON.stringify(reason)} is not one of `
          + `${[...ALLOWED_DISMISS_REASONS].map((r) => JSON.stringify(r)).join(", ")}`,
        )
      }
      const k = key(rule, p, line)
      const dup = seen.get(k)
      if (dup) {
        throw new Error(
          `[reconcile] duplicate codeql_dismissals entry for ${k}: `
          + `${dup.sourceFile} vs ${f}`,
        )
      }
      const entry: AdrEntry = { rule, path: p, line, reason, rationale, sourceFile: f }
      seen.set(k, entry)
      out.push(entry)
    }
  }
  return out
}

function parseLinkHeader(header: string | null): string | null {
  if (!header) return null
  const parts = header.split(",")
  for (const part of parts) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part)
    if (m) return m[1] ?? null
  }
  return null
}

async function resolveRepo(): Promise<{ owner: string; repo: string }> {
  const env = process.env["GITHUB_REPOSITORY"]
  if (env && env.includes("/")) {
    const [owner, repo] = env.split("/", 2)
    if (owner && repo) return { owner, repo }
  }
  const proc = Bun.spawn(["git", "remote", "get-url", "origin"], { stdout: "pipe", stderr: "pipe" })
  const text = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  const m = /github\.com[^:/]*[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(text)
  if (!m || !m[1] || !m[2]) {
    throw new Error(`[reconcile] cannot resolve owner/repo from git remote: ${text}`)
  }
  return { owner: m[1], repo: m[2] }
}

async function resolveToken(): Promise<string> {
  const env = process.env["GITHUB_TOKEN"]
  if (env) return env
  const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" })
  const text = (await new Response(proc.stdout).text()).trim()
  const code = await proc.exited
  if (code !== 0 || !text) {
    throw new Error(`[reconcile] GITHUB_TOKEN unset and 'gh auth token' failed`)
  }
  return text
}

async function fetchAlerts(
  owner: string,
  repo: string,
  state: "open" | "dismissed",
  token: string,
): Promise<Array<CodeQlAlert>> {
  let url: string | null =
    `https://api.github.com/repos/${owner}/${repo}/code-scanning/alerts?state=${state}&per_page=100`
  const all: Array<CodeQlAlert> = []
  while (url) {
    const res = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "maximal-reconcile-codeql",
      },
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`[reconcile] GET ${url} → ${res.status}: ${body}`)
    }
    const page = (await res.json()) as Array<CodeQlAlert>
    all.push(...page)
    url = parseLinkHeader(res.headers.get("link"))
  }
  return all
}

async function patchAlert(
  owner: string,
  repo: string,
  number: number,
  body: Record<string, unknown>,
  token: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/code-scanning/alerts/${number}`
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "maximal-reconcile-codeql",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`[reconcile] PATCH alert ${number} → ${res.status}: ${text}`)
  }
}

function buildPlan(entries: Array<AdrEntry>, alerts: Array<CodeQlAlert>): ReconcilePlan {
  const entryByKey = new Map<string, AdrEntry>()
  for (const e of entries) entryByKey.set(key(e.rule, e.path, e.line), e)

  const matchedEntryKeys = new Set<string>()
  const plan: ReconcilePlan = {
    dismiss: [],
    fixReason: [],
    reopen: [],
    inSync: [],
    orphanAdr: [],
  }

  for (const alert of alerts) {
    const k = key(
      alert.rule.id,
      alert.most_recent_instance.location.path,
      alert.most_recent_instance.location.start_line,
    )
    const entry = entryByKey.get(k)
    if (entry) {
      matchedEntryKeys.add(k)
      if (alert.state === "open") {
        plan.dismiss.push({ alert, entry })
      } else if (alert.state === "dismissed") {
        if (alert.dismissed_reason !== entry.reason) {
          plan.fixReason.push({ alert, entry })
        } else {
          plan.inSync.push({ alert, entry })
        }
      }
    } else if (alert.state === "dismissed") {
      plan.reopen.push(alert)
    }
  }

  for (const [k, entry] of entryByKey) {
    if (!matchedEntryKeys.has(k)) plan.orphanAdr.push(entry)
  }

  return plan
}

interface CliArgs { dryRun: boolean }

function parseArgs(argv: Array<string>): CliArgs {
  const args: CliArgs = { dryRun: false }
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true
    else if (a === "--help" || a === "-h") {
      console.log("Usage: bun run scripts/reconcile-codeql.ts [--dry-run]")
      process.exit(0)
    } else {
      console.warn(`[reconcile] ignoring unknown arg: ${a}`)
    }
  }
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const entries = await loadAdrEntries()
  console.log(`[reconcile] loaded ${entries.length} ADR dismissal entries from docs/decisions/`)

  const { owner, repo } = await resolveRepo()
  console.log(`[reconcile] repo: ${owner}/${repo}`)

  const token = await resolveToken()
  const [openAlerts, dismissedAlerts] = await Promise.all([
    fetchAlerts(owner, repo, "open", token),
    fetchAlerts(owner, repo, "dismissed", token),
  ])
  const all = [...openAlerts, ...dismissedAlerts]
  console.log(`[reconcile] fetched ${openAlerts.length} open + ${dismissedAlerts.length} dismissed alerts`)

  const plan = buildPlan(entries, all)

  for (const { alert, entry } of plan.inSync) {
    console.log(`[reconcile] in-sync: #${alert.number} ${entry.rule} ${entry.path}:${entry.line}`)
  }
  for (const entry of plan.orphanAdr) {
    console.warn(
      `[reconcile] WARN ADR entry has no matching alert: `
      + `${entry.rule} ${entry.path}:${entry.line} (from ${entry.sourceFile}). `
      + `Either the alert was auto-closed, or the ADR is stale.`,
    )
  }

  for (const { alert, entry } of plan.dismiss) {
    const comment = firstSentence(entry.rationale)
    if (args.dryRun) {
      console.log(`[reconcile] DRY-RUN would dismiss #${alert.number} ${entry.rule} ${entry.path}:${entry.line} reason=${JSON.stringify(entry.reason)}`)
    } else {
      console.log(`[reconcile] dismissing #${alert.number} ${entry.rule} ${entry.path}:${entry.line}`)
      await patchAlert(owner, repo, alert.number, {
        state: "dismissed",
        dismissed_reason: entry.reason,
        dismissed_comment: comment,
      }, token)
    }
  }
  for (const { alert, entry } of plan.fixReason) {
    const comment = firstSentence(entry.rationale)
    if (args.dryRun) {
      console.log(`[reconcile] DRY-RUN would fix reason on #${alert.number} ${entry.rule} ${entry.path}:${entry.line} (${alert.dismissed_reason ?? "null"} → ${entry.reason})`)
    } else {
      console.log(`[reconcile] fixing reason on #${alert.number} ${entry.rule} ${entry.path}:${entry.line}`)
      await patchAlert(owner, repo, alert.number, {
        state: "dismissed",
        dismissed_reason: entry.reason,
        dismissed_comment: comment,
      }, token)
    }
  }
  for (const alert of plan.reopen) {
    if (args.dryRun) {
      console.log(`[reconcile] DRY-RUN would re-open #${alert.number} ${alert.rule.id} ${alert.most_recent_instance.location.path}:${alert.most_recent_instance.location.start_line} (no ADR entry covers this dismissal)`)
    } else {
      console.log(`[reconcile] re-opening #${alert.number} ${alert.rule.id} ${alert.most_recent_instance.location.path}:${alert.most_recent_instance.location.start_line}`)
      // Re-open only. `dismissed_reason`/`dismissed_comment` are valid *only*
      // with state:"dismissed"; sending them (even as null) on a re-open makes
      // GitHub validate null against the reason enum and 422 with "nil is not a
      // string". Omit them entirely.
      await patchAlert(owner, repo, alert.number, { state: "open" }, token)
    }
  }

  const changes = plan.dismiss.length + plan.fixReason.length + plan.reopen.length
  if (changes === 0) {
    console.log(`[reconcile] Already in sync — ${plan.inSync.length} dismissals match ADRs; 0 changes needed.`)
  } else {
    console.log(
      `[reconcile] Summary: `
      + `${plan.dismiss.length} dismissed, `
      + `${plan.fixReason.length} reasons fixed, `
      + `${plan.reopen.length} re-opened, `
      + `${plan.inSync.length} already-in-sync`
      + (args.dryRun ? " (DRY-RUN — no changes applied)" : ""),
    )
  }
}

await main()
