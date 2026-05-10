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
//   OLLAMA_MODEL=gemma4:e2b bun run analyze
//
// Env knobs:
//   OLLAMA_URL    default http://localhost:11434
//   OLLAMA_MODEL  default gemma4:e2b
//   POLL_MS       default 1000
//   FROM_START    if set, replays existing log; default tails new lines only

import { existsSync, statSync } from "node:fs"
import { join } from "node:path"

const REPO = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const LOG = join(REPO, ".claude/logs/checks.jsonl")
const URL = process.env.OLLAMA_URL ?? "http://localhost:11434"
const MODEL = process.env.OLLAMA_MODEL ?? "gemma4:e2b"
const POLL_MS = Number(process.env.POLL_MS ?? 1000)
const FROM_START = Boolean(process.env.FROM_START)

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

console.error(
  `[gemma-watch] tailing ${LOG}\n[gemma-watch] model=${MODEL} url=${URL} poll=${POLL_MS}ms from_start=${FROM_START}`,
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
        .map(([k]) => k)
        .join(",")
      return `${e.ts} ${e.trigger} ${e.file ?? ""} fail=[${failed || "none"}]`
    })
    .join("\n")

  const detail = Object.entries(current.results)
    .filter(([, r]) => r.exit !== 0)
    .map(([k, r]) => `## ${k} (exit ${r.exit})\n${r.output.slice(0, 1500)}`)
    .join("\n\n")

  return `You are a quiet observer of an LLM-driven coding session. You see diagnostic results from oxlint, eslint, tsc, and bun test as the agent edits files. Your job is meta-analysis, not code review: spot patterns across the session, flag thrashing, repeated mistakes, drift between tools, or signs the agent is fixing surface symptoms instead of root causes. Be brief — 2 to 4 sentences. If nothing notable, say "no notable pattern" and stop.

Recent events (oldest first):
${summary}

Current event details:
${detail}

Meta-analysis:`
}
