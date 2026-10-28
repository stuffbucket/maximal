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

/** A session's next request on the same model after a gap, as evidence
 *  about that model's prompt cache. */
export interface Resume {
  model: string
  /** From the earlier request's completion to the resuming request's
   *  completion (both rows' `created_at_ms`). */
  gapMs: number
  /** The cache lifetime the resuming request asked for, in seconds. */
  requestedTtlS: number
  cacheReadTokens: number
  /** Names the pair of requests, so a resume seen again is not recounted. */
  key?: string
}

/** Consecutive misses after which a model's longer lifetime is not trusted. */
const MISSES_TO_DOWNGRADE = 2

/**
 * What the proxy has seen of each model's prompt cache, kept in memory.
 *
 * A session that resumes after more than 5 minutes but within its requested
 * lifetime shows whether the upstream honored that lifetime: cached tokens
 * read is a hit, none is a miss. Two misses in a row downgrade the model to 5
 * minutes, so a countdown never claims more than was seen; one miss can be a
 * plain eviction. A later hit restores the model.
 */
export class CacheObservations {
  readonly #honored = new Set<string>()
  readonly #misses = new Map<string, number>()
  #recorded = new Set<string>()

  /**
   * Record one resume. Feed resumes oldest first, so "in a row" holds.
   * `key` names the pair of requests it came from; a key already recorded is
   * ignored, so feeding the same rows on every poll counts each resume once.
   */
  record(resume: Resume): void {
    const { model, gapMs, requestedTtlS, cacheReadTokens, key } = resume
    if (key !== undefined) {
      if (this.#recorded.has(key)) return
      this.#recorded.add(key)
    }
    if (gapMs <= FIVE_MINUTES_S * 1000 || gapMs > requestedTtlS * 1000) return
    if (cacheReadTokens > 0) {
      this.#honored.add(model)
      this.#misses.set(model, 0)
    } else {
      this.#misses.set(model, (this.#misses.get(model) ?? 0) + 1)
    }
  }

  /** Forget every recorded key not in `keys`. A build passes the keys of all
   *  the resumes in its rows; rows only age out, so a dropped key never
   *  comes back and the set stays the size of one window. */
  retainKeys(keys: ReadonlySet<string>): void {
    this.#recorded = new Set([...this.#recorded].filter((key) => keys.has(key)))
  }

  /** Whether a lifetime of `ttlS` on this model is cut to 5 minutes. */
  isDowngraded(model: string, ttlS: number): boolean {
    return (
      ttlS > FIVE_MINUTES_S
      && (this.#misses.get(model) ?? 0) >= MISSES_TO_DOWNGRADE
    )
  }

  /** The lifetime to count down from: 5 minutes for a longer lifetime on a
   *  downgraded model, otherwise the lifetime itself. */
  effectiveTtlS(model: string, ttlS: number): number {
    return this.isDowngraded(model, ttlS) ? FIVE_MINUTES_S : ttlS
  }

  confidence(model: string, ttlS: number, requested: boolean): CacheConfidence {
    if (ttlS <= 0) return "estimated"
    // Downgraded: the 5 minutes in its place is the default, not a fact.
    if (this.isDowngraded(model, ttlS)) return "estimated"
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

interface TimedResume {
  row: SessionRow
  resume: Resume & { key: string }
}

/**
 * Each resume in a session: a request more than 5 minutes after the previous
 * request on the same model. Requests on other models in between (Claude Code
 * subagents share their parent's session id) neither break nor make a resume.
 */
function sessionResumes(group: Array<SessionRow>): Array<TimedResume> {
  const previousByModel = new Map<string, SessionRow>()
  const resumes: Array<TimedResume> = []
  for (const row of group) {
    const previous = previousByModel.get(row.model)
    previousByModel.set(row.model, row)
    if (!previous) continue
    // created_at_ms is stamped when a request completes, so the gap runs
    // from completion to completion.
    const gapMs = row.created_at_ms - previous.created_at_ms
    if (gapMs <= FIVE_MINUTES_S * 1000) continue
    resumes.push({
      row,
      resume: {
        model: row.model,
        gapMs,
        requestedTtlS: row.cache_ttl_s,
        cacheReadTokens: row.cache_read_input_tokens,
        key: `${previous.id}>${row.id}`,
      },
    })
  }
  return resumes
}

/** Feed every session's resumes in one time order across sessions, so
 *  "consecutive misses" means consecutive for the model, then drop the keys
 *  of resumes no longer in the rows. */
function feedObservations(
  groups: Iterable<Array<SessionRow>>,
  observations: CacheObservations,
): void {
  const resumes = [...groups].flatMap((group) => sessionResumes(group))
  resumes.sort((a, b) => byCreatedAt(a.row, b.row))
  for (const { resume } of resumes) observations.record(resume)
  observations.retainKeys(new Set(resumes.map(({ resume }) => resume.key)))
}

/** A session whose first reply is still streaming: nothing recorded yet. */
function streamingOnlySession(entry: InFlight, nowMs: number): SessionView {
  return {
    id: entry.sessionId,
    client: entry.client,
    client_label: null,
    model: entry.model,
    started_at_ms: entry.startedAtMs,
    last_request_at_ms: entry.startedAtMs,
    state: "streaming",
    rate_per_min: 0,
    minutes: emptyRecentMinutes(nowMs),
    total_tokens: 0,
    request_count: 0,
    cache: {
      ttl_s: 0,
      expires_at_ms: null,
      confidence: "estimated",
      downgraded: false,
      last_cache_read_tokens: 0,
    },
    context: {
      used_tokens: 0,
      window_tokens: null,
      ceiling_tokens: null,
      compact_at_tokens: null,
      window_source: "model-listing",
      compacted_at_ms: null,
    },
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
      downgraded: observations.isDowngraded(latest.model, latest.cache_ttl_s),
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
  feedObservations(groups.values(), observations)

  // An entry with no session id counts toward the flow but marks nothing.
  const withSession = inFlight
    .filter((entry) => entry.sessionId !== "")
    .sort((a, b) => a.startedAtMs - b.startedAtMs)
  const streaming = new Set(withSession.map((entry) => entry.sessionId))
  const sessions = [...groups].map(([id, group]) =>
    buildSession(id, group, { nowMs, streaming, observations }),
  )
  // A session still streaming its first reply shows from its earliest entry.
  const seen = new Set(groups.keys())
  for (const entry of withSession) {
    if (seen.has(entry.sessionId)) continue
    seen.add(entry.sessionId)
    sessions.push(streamingOnlySession(entry, nowMs))
  }
  sessions.sort((a, b) => b.last_request_at_ms - a.last_request_at_ms)

  return { flow_per_min: flowPerMin(rows, inFlight, nowMs), sessions }
}
