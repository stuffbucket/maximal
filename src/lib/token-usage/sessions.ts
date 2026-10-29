import type { InFlight } from "./in-flight"
import type { SessionsResponse, SessionView } from "./sessions-schema"
import type { SessionRow } from "./store"

import { customKeyLabel } from "./client"
import { STREAM_CHARS_PER_TOKEN } from "./in-flight"
import { addToRecentMinutes, emptyRecentMinutes } from "./minutes"

type CacheConfidence = SessionView["cache"]["confidence"]
type TokenRates = NonNullable<SessionView["rates"]>
type ModelRates = NonNullable<SessionView["model_rates"]>[number]

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
  /** From the earlier request's completion to the resuming request's start:
   *  how old the cache was when the resume read it. */
  gapMs: number
  /** The cache lifetime the resuming request asked for, in seconds. */
  requestedTtlS: number
  cacheReadTokens: number
  /** The earlier request's whole context (input, cache read and cache
   *  creation), which a surviving cache would mostly cover. */
  previousContextTokens: number
  /** Names the pair of requests, so a resume seen again is not recounted. */
  key?: string
}

/** Consecutive misses after which a model's longer lifetime is not trusted. */
const MISSES_TO_DOWNGRADE = 2

/**
 * What the proxy has seen of each model's prompt cache, kept in memory.
 *
 * A session that resumes after more than 5 minutes but within its requested
 * lifetime shows whether the upstream honored that lifetime. Reading back at
 * least half of the previous request's context is a hit; less is a miss,
 * because a shared prefix (tools, system prompt) can stay cached while the
 * conversation's own cache is gone. Two misses in a row downgrade the model
 * to 5 minutes, so a countdown never claims more than was seen; one miss can
 * be a plain eviction. A later hit restores the model.
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
    const {
      model,
      gapMs,
      requestedTtlS,
      cacheReadTokens,
      previousContextTokens,
      key,
    } = resume
    if (key !== undefined) {
      if (this.#recorded.has(key)) return
      this.#recorded.add(key)
    }
    if (gapMs <= FIVE_MINUTES_S * 1000 || gapMs > requestedTtlS * 1000) return
    if (cacheReadTokens > 0 && cacheReadTokens * 2 >= previousContextTokens) {
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

/** Input, cache-read and cache-creation tokens: the request's whole context. */
function contextTokens(row: SessionRow): number {
  return (
    row.input_tokens
    + row.cache_read_input_tokens
    + row.cache_creation_input_tokens
  )
}

function tokenRates(rows: Array<SessionRow>): TokenRates {
  const totals = rows.reduce(
    (sum, row) => ({
      input: sum.input + row.input_tokens,
      output: sum.output + row.output_tokens,
      cacheRead: sum.cacheRead + row.cache_read_input_tokens,
      cacheWrite: sum.cacheWrite + row.cache_creation_input_tokens,
      total: sum.total + row.total_tokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  )
  return {
    input_per_min: totals.input / RATE_MINUTES,
    output_per_min: totals.output / RATE_MINUTES,
    cache_read_per_min: totals.cacheRead / RATE_MINUTES,
    cache_write_per_min: totals.cacheWrite / RATE_MINUTES,
    total_per_min: totals.total / RATE_MINUTES,
  }
}

/**
 * Each resume in a session: a request that started more than 5 minutes after
 * the previous request on the same model completed. Requests on other models
 * in between (Claude Code subagents share their parent's session id) neither
 * break nor make a resume. A request with no recorded start proves nothing.
 */
function sessionResumes(group: Array<SessionRow>): Array<TimedResume> {
  const previousByModel = new Map<string, SessionRow>()
  const resumes: Array<TimedResume> = []
  for (const row of group) {
    const previous = previousByModel.get(row.model)
    previousByModel.set(row.model, row)
    if (!previous || row.request_started_at_ms === null) continue
    // created_at_ms is stamped when a request completes: the cache was this
    // old when the resuming request reached it.
    const gapMs = row.request_started_at_ms - previous.created_at_ms
    if (gapMs <= FIVE_MINUTES_S * 1000) continue
    resumes.push({
      row,
      resume: {
        model: row.model,
        gapMs,
        requestedTtlS: row.cache_ttl_s,
        cacheReadTokens: row.cache_read_input_tokens,
        previousContextTokens: contextTokens(previous),
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
    rates: tokenRates([]),
    model_rates: [],
    minutes: emptyRecentMinutes(nowMs),
    total_tokens: 0,
    request_count: 0,
    cache: {
      ttl_s: 0,
      expires_at_ms: null,
      confidence: "estimated",
      downgraded: false,
      downgraded_from_s: null,
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

/** One model's part of a session: its latest request and its tokens. */
interface ModelPart {
  latest: SessionRow
  tokens: number
}

/** Each model's latest request and token total, in order of latest use. */
function modelParts(group: Array<SessionRow>): Array<ModelPart> {
  const parts = new Map<string, ModelPart>()
  for (const row of group) {
    const part = parts.get(row.model)
    // Re-insert, so the map's order is each model's latest use.
    parts.delete(row.model)
    parts.set(row.model, {
      latest: row,
      tokens: (part?.tokens ?? 0) + row.total_tokens,
    })
  }
  return [...parts.values()]
}

/** The cache of one model's latest request, as the session shows it. */
function modelCache(
  row: SessionRow,
  observations: CacheObservations,
): SessionView["cache"] {
  const ttlS = observations.effectiveTtlS(row.model, row.cache_ttl_s)
  const downgraded = observations.isDowngraded(row.model, row.cache_ttl_s)
  return {
    ttl_s: ttlS,
    expires_at_ms: ttlS > 0 ? row.created_at_ms + ttlS * 1000 : null,
    confidence: observations.confidence(
      row.model,
      row.cache_ttl_s,
      row.cache_ttl_requested === 1,
    ),
    downgraded,
    downgraded_from_s: downgraded ? row.cache_ttl_s : null,
    last_cache_read_tokens: row.cache_read_input_tokens,
  }
}

/**
 * The cache that lasts longest among the models' latest requests, so a side
 * request (a Claude Code subagent on Haiku, often with no cache marker) can't
 * turn a session cold while its main model's cache is warm. With nothing
 * cached, the main model's.
 */
function sessionCache(
  parts: Array<ModelPart>,
  main: ModelPart,
  observations: CacheObservations,
): SessionView["cache"] {
  let best = modelCache(main.latest, observations)
  for (const part of parts) {
    const cache = modelCache(part.latest, observations)
    if (
      cache.expires_at_ms !== null
      && (best.expires_at_ms === null
        || cache.expires_at_ms > best.expires_at_ms)
    ) {
      best = cache
    }
  }
  return best
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
  const rateStartMs = minutes.at(-RATE_MINUTES)?.start_ms ?? nowMs
  const rateRows = group.filter((row) => row.created_at_ms >= rateStartMs)
  const rates = tokenRates(rateRows)
  const rateRowsByModel = new Map<string, Array<SessionRow>>()
  for (const row of rateRows) {
    const modelRows = rateRowsByModel.get(row.model)
    if (modelRows) modelRows.push(row)
    else rateRowsByModel.set(row.model, [row])
  }
  const modelRates: Array<ModelRates> = [...rateRowsByModel].map(
    ([model, rows]) => ({
      model,
      ...tokenRates(rows),
    }),
  )

  // The main model has the most tokens in the session; on a tie, the one
  // used last. Its latest request supplies the model and the context.
  const parts = modelParts(group)
  const main = parts.reduce((a, b) => (b.tokens >= a.tokens ? b : a))
  const cache = sessionCache(parts, main, observations)
  const warm = cache.expires_at_ms !== null && nowMs < cache.expires_at_ms
  const shown = main.latest

  return {
    id,
    client: latest.client,
    client_label: customKeyLabel(latest.client_label),
    model: shown.model,
    started_at_ms: first.created_at_ms,
    last_request_at_ms: latest.created_at_ms,
    state: sessionState(streaming.has(id), warm),
    rate_per_min: ratePerMin,
    rates,
    model_rates: modelRates,
    minutes,
    total_tokens: totalTokens,
    request_count: group.length,
    cache,
    context: {
      used_tokens: contextTokens(shown),
      window_tokens: shown.context_window_tokens,
      ceiling_tokens: shown.context_ceiling_tokens,
      compact_at_tokens: shown.compact_at_tokens,
      // Rows from before the window was recorded: the listed window.
      window_source: shown.window_source ?? "model-listing",
      compacted_at_ms: compactedAtMs,
    },
  }
}

/**
 * Tokens in the trailing minute that weren't read from a cache (input, output
 * and cache creation), plus an estimate of those streamed so far by every
 * request in flight, with or without a session. Cache reads are left out: a
 * turn that resends 100k of cached context isn't 100k tokens of work.
 */
function flowPerMin(
  rows: Array<SessionRow>,
  inFlight: Array<InFlight>,
  nowMs: number,
): number {
  let tokens = 0
  for (const row of rows) {
    if (row.created_at_ms > nowMs - FLOW_WINDOW_MS) {
      tokens +=
        row.input_tokens + row.output_tokens + row.cache_creation_input_tokens
    }
  }
  for (const entry of inFlight) {
    tokens += Math.floor(entry.streamedChars / STREAM_CHARS_PER_TOKEN)
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
