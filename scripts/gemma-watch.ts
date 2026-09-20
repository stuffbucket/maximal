#!/usr/bin/env bun
// Tails .claude/logs/checks.jsonl and asks a small Ollama model to do
// meta-analysis on each diagnostic event with at least one failing channel.
//
// Goals:
//   - Observation only — never blocks codegen, never edits files.
//   - See whether a small local model can spot patterns across runs:
//     repeated mistakes, drift between channels, signs of model thrash, etc.
//
// Run alongside Claude Code in a separate terminal:
//   OLLAMA_MODEL=gemma3:9b bun run analyze
// (gemma4:e2b works but its analytical ceiling is low — bigger models
// cross the threshold from "thrashing detector" to "actual reviewer.")
//
// Env knobs:
//   OLLAMA_URL    default http://localhost:11434
//   OLLAMA_MODEL  default gemma4:e2b
//   POLL_MS       default 1000
//   FROM_START    if set, replays existing log; default tails new lines only
//   DIFF_BUDGET   max chars of `git diff` to include per event (default 3000)
//   TOOL_BUDGET   max chars per failing tool's output (default 4000)
//   CONTEXT_FILE  override the project-conventions file. Default
//                 ./scripts/gemma-watch.context.md (relative to repo root)

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const REPO = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const LOG = join(REPO, ".claude/logs/checks.jsonl")
const URL = process.env.OLLAMA_URL ?? "http://localhost:11434"
const MODEL = process.env.OLLAMA_MODEL ?? "gemma4:e2b"
const POLL_MS = Number(process.env.POLL_MS ?? 1000)
const FROM_START = Boolean(process.env.FROM_START)
const DIFF_BUDGET = Number(process.env.DIFF_BUDGET ?? 3000)
const TOOL_BUDGET = Number(process.env.TOOL_BUDGET ?? 4000)
const CONTEXT_FILE = resolve(
  REPO,
  process.env.CONTEXT_FILE ?? "scripts/gemma-watch.context.md",
)

interface ToolResult {
  exit: number
  output: string
}
interface Entry {
  ts: string
  trigger: "edit" | "stop"
  file: string | null
  duration_ms: number
  results: Record<string, ToolResult>
}

let pos = FROM_START || !existsSync(LOG) ? 0 : statSync(LOG).size
const recent: Array<Entry> = []
const RECENT_MAX = 8

const projectConventions = loadProjectConventions()

console.error(
  `[gemma-watch] tailing ${LOG}\n[gemma-watch] model=${MODEL} url=${URL} poll=${POLL_MS}ms from_start=${FROM_START}\n[gemma-watch] context=${projectConventions ? CONTEXT_FILE : "<none>"} diff_budget=${DIFF_BUDGET} tool_budget=${TOOL_BUDGET}`,
)

while (true) {
  await tick()
  await Bun.sleep(POLL_MS)
}

async function tick(): Promise<void> {
  if (!existsSync(LOG)) return
  const size = statSync(LOG).size
  if (size <= pos) return
  const file = Bun.file(LOG)
  const chunk = await file.slice(pos, size).text()
  pos = size
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: Entry
    try {
      entry = JSON.parse(trimmed) as Entry
    } catch {
      continue
    }
    recent.push(entry)
    if (recent.length > RECENT_MAX) recent.shift()
    if (hasFailure(entry)) await analyze(entry)
  }
}

function hasFailure(e: Entry): boolean {
  return Object.values(e.results).some((r) => r.exit !== 0)
}

async function analyze(entry: Entry): Promise<void> {
  const prompt = buildPrompt(entry, recent)
  const banner = `\n=== ${entry.ts} ${entry.trigger}${entry.file ? " " + entry.file : ""} (${entry.duration_ms}ms) ===\n`
  process.stdout.write(banner)
  try {
    const res = await fetch(`${URL}/api/generate`, {
      method: "POST",
      // codeql[js/file-access-to-http] -- by design: dev-only watcher, not shipped, not on the runtime path. Reads local model state from disk and posts to a local Ollama instance. See ADR-0001.
      body: JSON.stringify({ model: MODEL, prompt, stream: true }),
    })
    if (!res.ok || !res.body) {
      process.stdout.write(`[gemma-watch] ollama ${res.status}\n`)
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line) as { response?: string; done?: boolean }
          if (obj.response) process.stdout.write(obj.response)
        } catch {
          // ignore malformed line
        }
      }
    }
    process.stdout.write("\n")
  } catch (err) {
    process.stdout.write(`[gemma-watch] error: ${(err as Error).message}\n`)
  }
}

function buildPrompt(current: Entry, history: Array<Entry>): string {
  const summary = history
    .map((e) => {
      const failed = Object.entries(e.results)
        .filter(([, r]) => r.exit !== 0)
        .map(([k, r]) => `${k}:${topRule(r.output) ?? "?"}`)
        .join(", ")
      return `${e.ts} ${e.trigger} ${e.file ?? ""} fail=[${failed || "none"}]`
    })
    .join("\n")

  const detail = Object.entries(current.results)
    .filter(([, r]) => r.exit !== 0)
    .map(
      ([k, r]) =>
        `## ${k} (exit ${r.exit})\n${truncateLineAware(stripAnsi(r.output), TOOL_BUDGET)}`,
    )
    .join("\n\n")

  const diff = current.file ? captureDiff(current.file, DIFF_BUDGET) : ""

  const conventionsSection = projectConventions
    ? `Project conventions (constant; same every event):\n${projectConventions}\n\n`
    : ""

  const diffSection = diff
    ? `Recent uncommitted changes to ${current.file}:\n\`\`\`diff\n${diff}\n\`\`\`\n\n`
    : ""

  return `You are a quiet observer of an LLM-driven coding session. You see diagnostic results from oxlint, eslint, tsc, and bun test as the agent edits files. Your job is meta-analysis, not code review: spot patterns across the session, flag thrashing, repeated mistakes, drift between tools, or signs the agent is fixing surface symptoms instead of root causes. Be brief — 2 to 4 sentences. If nothing notable, say "no notable pattern" and stop.

${conventionsSection}Recent events (oldest first):
${summary}

${diffSection}Current event details:
${detail}

Meta-analysis:`
}

// ────────────────────────────────────────────────────────────────────
// Helpers (dev-only; this script is never compiled into the binary).
// ────────────────────────────────────────────────────────────────────

function loadProjectConventions(): string | null {
  if (!existsSync(CONTEXT_FILE)) return null
  try {
    const raw = readFileSync(CONTEXT_FILE, "utf8")
    // Strip lines starting with "# " (h1/h2 noise — kept for human readers,
    // not useful as model context) and trim. Keep "## " for structure.
    return raw.trim()
  } catch {
    return null
  }
}

function captureDiff(file: string, budget: number): string {
  // Working-tree diff vs. last commit: shows what the agent changed but
  // hasn't yet committed. If this returns empty (clean tree), fall back
  // to the last committed diff for context.
  const live = runGit(["diff", "HEAD", "--", file])
  if (live.trim()) return truncateLineAware(live, budget)

  const lastCommitted = runGit(["log", "-1", "-p", "--", file])
  if (lastCommitted.trim()) return truncateLineAware(lastCommitted, budget)

  return ""
}

function runGit(args: Array<string>): string {
  try {
    const r = spawnSync("git", args, {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (r.status !== 0) return ""
    return r.stdout
  } catch {
    return ""
  }
}

function stripAnsi(s: string): string {
  // ANSI CSI sequences (color codes from oxlint/eslint/tsc when piped to
  // a TTY emulator). Strip so the model sees plain text.
  // eslint-disable-next-line no-control-regex
  return s.replaceAll(/\[[\d;]*[A-Za-z]/gu, "")
}

function truncateLineAware(s: string, budget: number): string {
  if (s.length <= budget) return s
  const lines = s.split("\n")
  let acc = ""
  for (const line of lines) {
    if (acc.length + line.length + 1 > budget) break
    acc += (acc ? "\n" : "") + line
  }
  return acc + `\n…(${s.length - acc.length} more chars elided)`
}

function topRule(output: string): string | null {
  // Heuristic: most ESLint/oxlint output puts a rule name in parentheses
  // or as the trailing token on the error line. Surface the most common
  // one so history summaries carry rule-level signal.
  const cleaned = stripAnsi(output)
  const matches = cleaned.match(/\b(?:[a-z][\w-]*\/)?[a-z][\w-]+(?=\s*$|\))/gmu)
  if (!matches || matches.length === 0) return null
  const counts = new Map<string, number>()
  for (const m of matches) counts.set(m, (counts.get(m) ?? 0) + 1)
  let best: string | null = null
  let bestN = 0
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k
      bestN = n
    }
  }
  return best
}
