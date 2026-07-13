#!/usr/bin/env bun
/**
 * External-surface drift watcher — deterministic, no LLM, no secrets.
 *
 * `maximal` impersonates several third-party clients and mirrors an
 * external API spec. Those upstreams live outside this repo and move on
 * their own schedule; when they do, a hardcoded pin here silently goes
 * stale (see docs/architecture.md → external surfaces). This watcher
 * compares each pin against its authoritative upstream and flags drift so
 * a human can file/reconcile. Every check is a plain GitHub-API fetch plus
 * a string/semver compare — reproducible and offline-testable (the pure
 * functions are exported; the network lives in the fetch helpers).
 *
 * What it watches (1:1 with the pins in src/):
 *   - copilotChat  COPILOT_VERSION        vs microsoft/vscode-copilot-chat release
 *                  (doubles as the /models schema signal: a schema change
 *                   only ships when the Copilot client itself changes)
 *   - claudeCode   CLAUDE_AGENT_USER_AGENT vs anthropics/claude-code release
 *   - opencode     OPENCODE_VERSION        vs sst/opencode release
 *   - anthropicSdk .stats.yml blob SHA      vs anthropics/anthropic-sdk-typescript
 *                  (that file is generated from Anthropic's OpenAPI spec, so a
 *                   SHA change ~= a /v1/messages wire-contract change)
 *
 * The runtime Copilot /models *values* sit behind an authed token and have
 * no public source, so this watcher does NOT hit that endpoint. Diff the
 * live schema locally with the maintainer's own credentials when the
 * copilotChat watch fires.
 *
 * Usage:
 *   bun run scripts/ops/watch-external-drift.ts [--body-file <path>]
 *
 * Emits (for the daily workflow):
 *   - `drift=true|false` to $GITHUB_OUTPUT
 *   - a Markdown issue body to --body-file (default external-drift-report.md)
 *     when any watch is drifted. The body is scoped so a PR can be derived from
 *     it directly: the workflow files ONE labelled issue — actionable by a
 *     maintainer, or by `repoman`'s issue triage where that is wired. The
 *     workflow itself never opens a PR.
 * This watcher DETECTS and reports only; it never rewrites the pins. A version
 * value is often duplicated in a coupled string (e.g. OPENCODE_VERSION also
 * appears verbatim in the opencode User-Agent we send), so a mechanical
 * single-pin rewrite would half-update the source — reconciling the bump by
 * hand, guided by the issue body, is the correct and reviewable gate.
 * Always exits 0 (a failed *check* is reported as drift, not a crash) so the
 * workflow can decide what to do.
 */

import fs from "node:fs/promises"
import path from "node:path"

// Resolve paths from this file, not the cwd, so the watcher runs identically
// from the repo root (workflow), from scripts/ops (its own `bun test`), or
// anywhere else. `scripts/ops` → repo root is two levels up.
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")
/** Absolute path to a repo-relative source file (e.g. a pin's `file`). */
export const repoPath = (rel: string): string => path.join(REPO_ROOT, rel)
/** Absolute path to the committed drift baseline (colocated with this script). */
export const BASELINE_PATH = path.join(
  import.meta.dir,
  "external-drift-baseline.json",
)

// --- pins: the repo is the source of truth; read them, don't duplicate ---

export interface PinSpec {
  id: string
  file: string
  /** Must capture the version in group 1. */
  pattern: RegExp
  /** Upstream `owner/repo` whose latest release tag is the authority. */
  repo: string
  describe: string
}

/** Version pins we impersonate, each checked against an upstream release. */
export const VERSION_PINS: ReadonlyArray<PinSpec> = [
  {
    id: "copilotChat",
    file: "src/lib/config/api-config.ts",
    pattern: /const COPILOT_VERSION = "([\d.]+)"/u,
    repo: "microsoft/vscode-copilot-chat",
    describe:
      "Copilot Chat client version we impersonate (COPILOT_VERSION / User-Agent). Also our proxy for /models schema drift.",
  },
  {
    id: "claudeCode",
    file: "src/lib/config/api-config.ts",
    pattern: /vscode_claude_code\/([\d.]+)/u,
    repo: "anthropics/claude-code",
    describe:
      "Claude Code agent version we impersonate (CLAUDE_AGENT_USER_AGENT).",
  },
  {
    id: "opencode",
    file: "src/lib/config/api-config.ts",
    pattern: /const OPENCODE_VERSION = "opencode\/([\d.]+)"/u,
    repo: "sst/opencode",
    describe: "opencode client version we impersonate (OPENCODE_VERSION).",
  },
]

/** Extract a pin's current value from its source file text. Pure. */
export function extractPin(spec: PinSpec, source: string): string {
  const m = source.match(spec.pattern)
  if (!m?.[1]) {
    throw new Error(
      `pin ${spec.id}: ${String(spec.pattern)} did not match ${spec.file} — did the constant get renamed?`,
    )
  }
  return m[1]
}

// --- semver compare (tolerates `v` / `sdk-v` tag prefixes) ---

export function parseSemver(v: string): [number, number, number] {
  const clean = v
    .trim()
    .replace(/^sdk-v/u, "")
    .replace(/^v/u, "")
  const [a, b, c] = clean.split(".").map((p) => Number.parseInt(p, 10))
  return [a || 0, b || 0, c || 0]
}

/** True when `a` is a strictly newer semver than `b`. */
export function semverGt(a: string, b: string): boolean {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i]
  }
  return false
}

/** Strip a release-tag prefix (`v1.2.3`, `sdk-v1.2.3`) down to bare semver. */
export function normalizeTag(tag: string): string {
  return tag
    .trim()
    .replace(/^sdk-v/u, "")
    .replace(/^v/u, "")
}

// --- GitHub API (the only network) ---

const GH_API = "https://api.github.com"

function ghHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "maximal-external-drift-watch",
    "x-github-api-version": "2022-11-28",
  }
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

async function ghJson(path: string): Promise<unknown> {
  const res = await fetch(`${GH_API}${path}`, { headers: ghHeaders() })
  if (!res.ok) {
    throw new Error(`GitHub ${path} → ${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function latestReleaseVersion(repo: string): Promise<string> {
  const data = await ghJson(`/repos/${repo}/releases/latest`)
  const tag = (data as { tag_name?: unknown }).tag_name
  if (typeof tag !== "string") {
    throw new Error(`${repo}: release has no tag_name`)
  }
  return tag
}

async function fileBlobSha(repo: string, filePath: string): Promise<string> {
  const data = await ghJson(`/repos/${repo}/contents/${filePath}`)
  const sha = (data as { sha?: unknown }).sha
  if (typeof sha !== "string") {
    throw new Error(`${repo}/${filePath}: no blob sha`)
  }
  return sha
}

// --- watch evaluation ---

export interface WatchResult {
  id: string
  describe: string
  drift: boolean
  /** Our current pin / baseline. */
  local: string
  /** The authoritative upstream value. */
  upstream: string
  /** Repo-relative file a reconciliation edits (undefined for a failed check). */
  file?: string
  /** Upstream URL to review before reconciling (release notes / spec history). */
  upstreamUrl?: string
  /** Status line / concrete reconcile step, rendered into the issue body. */
  note: string
}

interface Baseline {
  anthropicSdkStatsSha: string
}

export async function runAllWatches(): Promise<Array<WatchResult>> {
  const results: Array<WatchResult> = []

  // Version pins → upstream release tag.
  for (const spec of VERSION_PINS) {
    try {
      const source = await fs.readFile(repoPath(spec.file), "utf8")
      const local = extractPin(spec, source)
      const upstream = await latestReleaseVersion(spec.repo)
      const drift = semverGt(upstream, local)
      results.push({
        id: spec.id,
        describe: spec.describe,
        drift,
        local,
        upstream,
        file: spec.file,
        upstreamUrl: drift
          ? `https://github.com/${spec.repo}/releases/tag/${upstream}`
          : undefined,
        note: drift
          ? `Review \`${spec.repo}\`'s release for behavioural changes, then bump \`${spec.file}\` from \`${local}\` to \`${normalizeTag(upstream)}\` — reconcile every occurrence, as the version can also appear verbatim in a coupled User-Agent string.`
          : `matches (upstream release ${upstream}; a Marketplace build may lead the GitHub release tag).`,
      })
    } catch (err) {
      results.push(failed(spec.id, spec.describe, err))
    }
  }

  // Anthropic OpenAPI-spec proxy → .stats.yml blob SHA vs committed baseline.
  try {
    const baseline = JSON.parse(
      await fs.readFile(BASELINE_PATH, "utf8"),
    ) as Baseline
    const repo = "anthropics/anthropic-sdk-typescript"
    const upstream = await fileBlobSha(repo, ".stats.yml")
    const drift = baseline.anthropicSdkStatsSha !== upstream
    results.push({
      id: "anthropicSdk",
      describe:
        "Anthropic /v1/messages wire contract (via anthropic-sdk-typescript/.stats.yml, generated from their OpenAPI spec).",
      drift,
      local: baseline.anthropicSdkStatsSha,
      upstream,
      file: "scripts/ops/external-drift-baseline.json",
      upstreamUrl: drift
        ? "https://github.com/anthropics/anthropic-sdk-typescript/commits/main/.stats.yml"
        : undefined,
      note: drift
        ? `The spec-generated stats file moved (\`${baseline.anthropicSdkStatsSha.slice(0, 12)}\` → \`${upstream.slice(0, 12)}\`). Review the \`.stats.yml\` history for new/changed message params, content blocks, or stream events; reconcile \`src/lib/models/anthropic-types.ts\` if affected; then bump \`anthropicSdkStatsSha\` in \`scripts/ops/external-drift-baseline.json\` to \`${upstream}\`.`
        : "matches the committed baseline.",
    })
  } catch (err) {
    results.push(
      failed("anthropicSdk", "Anthropic /v1/messages wire contract", err),
    )
  }

  return results
}

/** A check that could not complete is surfaced as drift, never swallowed. */
function failed(id: string, describe: string, err: unknown): WatchResult {
  const msg = err instanceof Error ? err.message : String(err)
  return {
    id,
    describe,
    drift: true,
    local: "?",
    upstream: "?",
    note: `⚠️ check failed (treated as drift so it isn't silently green): ${msg}`,
  }
}

// --- reporting ---

export function renderReport(results: ReadonlyArray<WatchResult>): string {
  const drifted = results.filter((r) => r.drift)
  const lines: Array<string> = [
    "## External-surface drift detected",
    "",
    "The daily watcher (deterministic, no LLM) found upstream changes to sources `maximal` mirrors or impersonates. Each item below is scoped so a reconciliation PR can be derived from it directly.",
    "",
  ]
  for (const r of drifted) {
    lines.push(`### \`${r.id}\` — ${r.describe}`)
    if (r.file) lines.push(`- **file to change:** \`${r.file}\``)
    lines.push(`- **ours:** \`${r.local}\``)
    lines.push(
      r.upstreamUrl
        ? `- **upstream:** \`${r.upstream}\` · [review the change](${r.upstreamUrl})`
        : `- **upstream:** \`${r.upstream}\``,
    )
    lines.push(`- **to reconcile:** ${r.note}`, "")
  }
  lines.push(
    "---",
    "_Generated by `scripts/ops/watch-external-drift.ts` (deterministic, no LLM). Reused while drift persists; auto-closes on the next clean run. A maintainer — or `repoman`'s issue triage, where wired — derives the reconciliation PR from this issue._",
  )
  return lines.join("\n")
}

// --- entry point ---

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

async function main(): Promise<number> {
  const results = await runAllWatches()

  for (const r of results) {
    console.error(
      `${r.drift ? "DRIFT" : "ok   "}  ${r.id.padEnd(13)} ours=${r.local} upstream=${r.upstream}`,
    )
  }

  const anyDrift = results.some((r) => r.drift)

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `drift=${anyDrift}\n`)
  }

  if (anyDrift) {
    const bodyFile = flag("--body-file") ?? "external-drift-report.md"
    await fs.writeFile(bodyFile, renderReport(results))
    console.error(
      `\n${results.filter((r) => r.drift).length} drift(s). Report → ${bodyFile}`,
    )
  } else {
    console.error("\nNo drift. Every watched upstream matches our pins.")
  }
  return 0
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(`watch-external-drift: ${err.message}`)
      process.exit(1)
    },
  )
}
