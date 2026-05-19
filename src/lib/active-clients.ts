/**
 * Tracks which clients have hit the proxy recently.
 *
 * Used by the menu-bar shell to show "N apps are using Maximal" at
 * quit time. Lives entirely in memory: every successful auth check
 * records `(apiKeyId, userAgent)` with a `lastSeenAt` timestamp; the
 * read side filters by age window.
 *
 * Bounded growth: entries older than {@link MAX_AGE_MS} are pruned by
 * a single background interval. The map is keyed by `${id}|${ua}` so
 * the same client doesn't accumulate duplicate rows on repeat calls.
 *
 * No DI / singletons module — this mirrors `src/lib/state.ts` style.
 */

interface ActiveClientRecord {
  userAgent: string
  apiKeyId: string | null
  apiKeyLabel: string | null
  lastSeenAt: number
}

export interface ActiveClient {
  key: string
  label: string
  userAgent: string
  ageSeconds: number
}

const MAX_AGE_MS = 5 * 60 * 1000

const clients = new Map<string, ActiveClientRecord>()

function entryKey(apiKeyId: string | null, userAgent: string): string {
  return `${apiKeyId ?? "*"}|${userAgent}`
}

export function recordClient(input: {
  apiKeyId: string | null
  apiKeyLabel: string | null
  userAgent: string
}): void {
  const ua = input.userAgent.trim()
  if (ua.length === 0) return
  const key = entryKey(input.apiKeyId, ua)
  clients.set(key, {
    userAgent: ua,
    apiKeyId: input.apiKeyId,
    apiKeyLabel: input.apiKeyLabel,
    lastSeenAt: Date.now(),
  })
}

export function listActiveClients(maxAgeSeconds = 60): Array<ActiveClient> {
  const now = Date.now()
  const cutoff = now - maxAgeSeconds * 1000
  const out: Array<ActiveClient> = []
  for (const [key, record] of clients.entries()) {
    if (record.lastSeenAt < cutoff) continue
    out.push({
      key,
      label: record.apiKeyLabel ?? humanizeUserAgent(record.userAgent),
      userAgent: record.userAgent,
      ageSeconds: Math.max(0, Math.floor((now - record.lastSeenAt) / 1000)),
    })
  }
  // Stable ordering: most-recent first.
  out.sort((a, b) => a.ageSeconds - b.ageSeconds)
  return out
}

/** Test-only: wipe the tracker between cases. */
export function __resetActiveClientsForTests(): void {
  clients.clear()
}

/**
 * Best-effort friendly name from a User-Agent string. Pattern table is
 * deliberately small — the field is informational, not load-bearing.
 */
export function humanizeUserAgent(userAgent: string): string {
  const ua = userAgent.trim()
  if (ua.length === 0) return "Unknown client"

  const patterns: Array<[RegExp, string]> = [
    [/^claude-code\b/i, "Claude Code"],
    [/^cline\b/i, "Cline"],
    [/^openai\/python\b/i, "OpenAI Python SDK"],
    [/^openai\/js\b/i, "OpenAI JS SDK"],
    [/^anthropic\/python\b/i, "Anthropic Python SDK"],
    [/^anthropic\/js\b/i, "Anthropic JS SDK"],
    [/^opencode\b/i, "Opencode"],
    [/^curl\b/i, "curl"],
    [/^wget\b/i, "wget"],
    [/^httpie\b/i, "HTTPie"],
  ]
  for (const [re, label] of patterns) {
    if (re.test(ua)) return label
  }

  // Fallback: first token before "/" or whole string, truncated.
  const head = ua.split(/[/\s]/, 1)[0] || ua
  return head.length > 40 ? `${head.slice(0, 37)}...` : head
}

// Single shared prune loop. `unref()` so it doesn't keep the process
// alive on its own under bun/node test runners.
const pruneTimer = setInterval(() => {
  const cutoff = Date.now() - MAX_AGE_MS
  for (const [key, record] of clients.entries()) {
    if (record.lastSeenAt < cutoff) clients.delete(key)
  }
}, 60_000)
if (typeof pruneTimer === "object" && "unref" in pruneTimer) {
  ;(pruneTimer as { unref: () => void }).unref()
}
