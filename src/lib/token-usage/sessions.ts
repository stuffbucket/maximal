import type { InFlight } from "./in-flight"
import type { SessionsResponse, SessionView } from "./sessions-schema"
import type { SessionRow } from "./store"

import { STREAM_BYTES_PER_TOKEN } from "./in-flight"
import { addToRecentMinutes, emptyRecentMinutes } from "./minutes"

type CacheConfidence = SessionView["cache"]["confidence"]

/** The default prompt-cache lifetime, and the floor a resume must clear to
 *  prove anything longer. */
const FIVE_MINUTES_S = 300
/** `rate_per_min` is the mean of this many trailing one-minute buckets. */
const RATE_MINUTES = 5
const FLOW_WINDOW_MS = 60_000

/** A session's next request after a gap, as evidence about its cache. */
export interface Resume {
  model: string
  gapMs: number
  /** The cache lifetime the resuming request asked for, in seconds. */
  requestedTtlS: number
  cacheReadTokens: number
  /** Names the pair of requests, so a resume seen again is not recounted. */
  key?: string
}

/**
 * What the proxy has seen of each model's prompt cache, kept in memory.
 *
 * A session that resumes after more than 5 minutes but within its requested
 * lifetime shows whether the upstream honored that lifetime: cached tokens
 * read means it did, none means it didn't. A model seen failing is treated as
 * 5 minutes from then on, so a countdown never claims more than was seen.
 */
export class CacheObservations {
  readonly #honored = new Set<string>()
  readonly #failed = new Set<string>()
  readonly #recorded = new Set<string>()

  /**
   * Record one resume. `key` names the pair of requests it came from; a key
   * already recorded is ignored, so feeding the same rows on every poll
   * counts each resume once.
   */
  record(resume: Resume): void {
    const { model, gapMs, requestedTtlS, cacheReadTokens, key } = resume
    if (key !== undefined) {
      if (this.#recorded.has(key)) return
      this.#recorded.add(key)
    }
    if (gapMs <= FIVE_MINUTES_S * 1000 || gapMs > requestedTtlS * 1000) return
    if (cacheReadTokens > 0) this.#honored.add(model)
    else this.#failed.add(model)
  }

  /** The lifetime to count down from: 5 minutes for a longer lifetime on a
   *  model seen not to honor it, otherwise the lifetime itself. */
  effectiveTtlS(model: string, ttlS: number): number {
    return this.#failed.has(model) && ttlS > FIVE_MINUTES_S ?
        FIVE_MINUTES_S
      : ttlS
  }

  confidence(model: string, ttlS: number, requested: boolean): CacheConfidence {
    if (ttlS <= 0) return "estimated"
    // Seen failing: the 5 minutes in its place is the default, not a fact.
    if (this.effectiveTtlS(model, ttlS) !== ttlS) return "estimated"
    if (this.#honored.has(model)) return "observed"
    return requested ? "requested" : "estimated"
  }
}

/** Requests with no session fold into one group per client. */
function sessionKey(row: SessionRow): string {
  return row.session_id || `other:${row.client}`
}

function byCreatedAt(a: SessionRow, b: SessionRow): number {
  return a.created_at_ms - b.created_at_ms || a.id - b.id
}

/** Feed each resume (consecutive requests of one session more than 5 minutes
 *  apart) to the observations, keyed by the pair of row ids. */
function feedObservations(
  group: Array<SessionRow>,
  observations: CacheObservations,
): void {
  for (let i = 1; i < group.length; i++) {
    const previous = group[i - 1]
    const row = group[i]
    const gapMs = row.created_at_ms - previous.created_at_ms
    if (gapMs <= FIVE_MINUTES_S * 1000) continue
    observations.record({
      model: row.model,
      gapMs,
      requestedTtlS: row.cache_ttl_s,
      cacheReadTokens: row.cache_read_input_tokens,
      key: `${previous.id}>${row.id}`,
    })
  }
}

/** In flight wins; otherwise warm until the cache lifetime runs out. */
function sessionState(streaming: boolean, warm: boolean): SessionView["state"] {
  if (streaming) return "streaming"
  return warm ? "warm" : "cold"
}

function buildSession(
  id: string,
  group: Array<SessionRow>,
  context: {
    nowMs: number
    streaming: Set<string>
    observations: CacheObservations
  },
): SessionView {
  const { nowMs, streaming, observations } = context
  const first = group[0]
  const latest = group.at(-1) ?? first

  const minutes = emptyRecentMinutes(nowMs)
  let totalTokens = 0
  let compactedAtMs: number | null = null
  for (const row of group) {
    addToRecentMinutes(minutes, row.created_at_ms, row.total_tokens)
    totalTokens += row.total_tokens
    if (row.is_compact === 1) compactedAtMs = row.created_at_ms
  }
  const ratePerMin =
    minutes
      .slice(-RATE_MINUTES)
      .reduce((sum, bucket) => sum + bucket.total_tokens, 0) / RATE_MINUTES

  const ttlS = observations.effectiveTtlS(latest.model, latest.cache_ttl_s)
  const expiresAtMs = ttlS > 0 ? latest.created_at_ms + ttlS * 1000 : null
  const warm = expiresAtMs !== null && nowMs < expiresAtMs

  return {
    id,
    client: latest.client,
    client_label: latest.client_label,
    model: latest.model,
    started_at_ms: first.created_at_ms,
    last_request_at_ms: latest.created_at_ms,
    state: sessionState(streaming.has(id), warm),
    rate_per_min: ratePerMin,
    minutes,
    total_tokens: totalTokens,
    request_count: group.length,
    cache: {
      ttl_s: ttlS,
      expires_at_ms: expiresAtMs,
      confidence: observations.confidence(
        latest.model,
        latest.cache_ttl_s,
        latest.cache_ttl_requested === 1,
      ),
      last_cache_read_tokens: latest.cache_read_input_tokens,
    },
    context: {
      used_tokens:
        latest.input_tokens
        + latest.cache_read_input_tokens
        + latest.cache_creation_input_tokens,
      window_tokens: latest.context_window_tokens,
      ceiling_tokens: latest.context_ceiling_tokens,
      compact_at_tokens: latest.compact_at_tokens,
      // Rows from before the window was recorded: the listed window.
      window_source: latest.window_source ?? "model-listing",
      compacted_at_ms: compactedAtMs,
    },
  }
}

/** Tokens in the trailing minute, plus those streamed so far by every
 *  request in flight, with or without a session. */
function flowPerMin(
  rows: Array<SessionRow>,
  inFlight: Array<InFlight>,
  nowMs: number,
): number {
  let tokens = 0
  for (const row of rows) {
    if (row.created_at_ms > nowMs - FLOW_WINDOW_MS) tokens += row.total_tokens
  }
  for (const entry of inFlight) {
    tokens += Math.floor(entry.streamedBytes / STREAM_BYTES_PER_TOKEN)
  }
  return tokens
}

/**
 * Per-session rate, cache state and context fill from the recorded requests
 * and the requests in flight. Sessions come out newest activity first; the
 * Dashboard does its own sorting.
 */
export function buildSessionsView(input: {
  rows: Array<SessionRow>
  inFlight: Array<InFlight>
  nowMs: number
  observations: CacheObservations
}): SessionsResponse {
  const { rows, inFlight, nowMs, observations } = input

  const groups = new Map<string, Array<SessionRow>>()
  for (const row of [...rows].sort(byCreatedAt)) {
    const key = sessionKey(row)
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  // Every resume is fed before any state is read, so one build sees them all.
  for (const group of groups.values()) feedObservations(group, observations)

  // An entry with no session id counts toward the flow but marks nothing.
  const streaming = new Set(
    inFlight.map((entry) => entry.sessionId).filter((id) => id !== ""),
  )
  const sessions = [...groups].map(([id, group]) =>
    buildSession(id, group, { nowMs, streaming, observations }),
  )
  sessions.sort((a, b) => b.last_request_at_ms - a.last_request_at_ms)

  return { flow_per_min: flowPerMin(rows, inFlight, nowMs), sessions }
}
