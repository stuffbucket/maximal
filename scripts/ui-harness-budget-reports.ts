/**
 * The mock sidecar's reports over the made-up spend ledger: a rule's timeline,
 * what-if replays of draft rules, and (with the sessions and suggestions) the
 * rest of what `/settings/api/budget` reports. They follow the real ones
 * (`src/lib/budget/reports/`) step for step, reusing the pieces that are pure
 * (periods, the replay ledger, buckets, scopes), so the harness and Storybook
 * show believable figures. The real timeline and simulation modules read the
 * usage database, so they can't be bundled for a browser; tests/ui-harness-
 * budget-reports.test.ts checks that this agrees with them on the same rows.
 *
 * Browser-safe like its host: web-standard APIs only.
 */
import type {
  BudgetLimitStatus,
  BudgetSimulateRequest,
  BudgetSimulateResponse,
  BudgetSimulationResult,
  BudgetTimelineResponse,
} from "../src/lib/config/settings-types"

import {
  type BudgetPeriod,
  type FollowedWindow,
  DAY_MS,
  HOUR_MS,
  everyDurationMs,
  followedPeriod,
  resolvePeriod,
} from "../src/lib/budget/periods"
import { bucketStart, defaultBucket, nextBucketStart } from "../src/lib/budget/reports/buckets"
import { type BucketSize, isBucketSize } from "../src/lib/budget/reports/buckets"
import { createLedger } from "../src/lib/budget/reports/ledger"
import { type RangeQuery, parseUsageRange } from "../src/lib/budget/reports/range"
import { globMatches } from "../src/lib/budget/glob"
import { nanoAiuToDisplay } from "../src/lib/budget/units"

type Scope = BudgetLimitStatus["scope"]
type LimitReset = BudgetLimitStatus["limit_reset"]
type Display = { unit: "usd" | "credits"; creditUsd: number }

/** One recorded batch of requests, as the mock ledger keeps it. */
export interface ReportRow {
  atMs: number
  model: string
  plugin: string | null
  key: string
  provider: string
  nanoAiu: number
  requests: number
}

/** A rule as the replays take it: the shape the service enforces. */
export interface ReportLimit {
  id: string
  label?: string
  scope: Scope
  /** nano-AIU */
  limit: number
  limitReset: LimitReset
  warnAt: number
  action: "block" | "warn" | "ask"
}

/** A reusable filter, as the status lists it. */
export interface ReportFilter {
  id: string
  kind: "models" | "clients" | "plugins"
  members: ReadonlyArray<string>
}

/**
 * Whether a recorded request is in a rule's scope (the real `scopeMatches`): everything, one client
 * key, plugin or provider, or a filter's members, matched as globs against the model, key or plugin
 * the filter's kind names. A filter that no longer exists selects nothing.
 */
export function rowInScope(row: ReportRow, scope: Scope, filters: ReadonlyArray<ReportFilter>): boolean {
  switch (scope.kind) {
    case "global":
      return true
    case "key":
      return row.key === scope.id
    case "plugin":
      return row.plugin === scope.id
    case "provider":
      return row.provider === scope.id
    case "filter": {
      const filter = filters.find((candidate) => candidate.id === scope.id)
      if (!filter) return false
      const value = filter.kind === "models" ? row.model : filter.kind === "clients" ? row.key : (row.plugin ?? undefined)
      return value !== undefined && filter.members.some((member) => globMatches(member, value))
    }
  }
}

export interface ReportContext {
  rows: ReadonlyArray<ReportRow>
  filters: ReadonlyArray<ReportFilter>
  nowMs: number
  findWindow: (ref: string) => FollowedWindow | undefined
  display: Display
}

/** One request: a ledger row of N requests is N requests that share its cost. */
export interface UsageEvent {
  atMs: number
  nanoAiu: number
  key: string
  plugin: string | undefined
  provider: string
  model: string
}

const iso = (ms: number): string => new Date(ms).toISOString()
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms))

/**
 * The requests a scope covers in `[fromMs, toMs)`, oldest first. A row of N
 * requests becomes N events a second apart that split its cost without losing
 * a nano-AIU, which is how the real ledger sees them (one row each).
 */
export function eventsFor(
  context: Pick<ReportContext, "rows" | "nowMs" | "filters">,
  scope: Scope,
  fromMs: number,
  toMs: number,
): Array<UsageEvent> {
  const events: Array<UsageEvent> = []
  for (const row of context.rows) {
    if (row.atMs >= toMs) continue
    if (!rowInScope(row, scope, context.filters)) continue
    const count = Math.max(1, row.requests)
    const base = Math.floor(row.nanoAiu / count)
    const extra = row.nanoAiu - base * count
    for (let index = 0; index < count; index += 1) {
      const atMs = Math.min(row.atMs + index * 1000, context.nowMs - 1)
      if (atMs < fromMs || atMs >= toMs) continue
      events.push({
        atMs,
        nanoAiu: base + (index < extra ? 1 : 0),
        key: row.key,
        plugin: row.plugin ?? undefined,
        provider: row.provider,
        model: row.model,
      })
    }
  }
  return events.sort((a, b) => a.atMs - b.atMs)
}

/**
 * The periods of a rule that overlap `[fromMs, toMs)`, oldest first (the real
 * `periodsInRange`): fixed periods step through `resolvePeriod`, a followed
 * window repeats its current length (earlier cycles estimated), a rolling
 * window is one open period.
 */
export function periodsInRange(
  reset: LimitReset,
  findWindow: (ref: string) => FollowedWindow | undefined,
  range: { fromMs: number; toMs: number; nowMs: number },
): Array<BudgetPeriod> {
  const { fromMs, toMs, nowMs } = range
  if (typeof reset !== "string" && "every" in reset) {
    return [{ startMs: fromMs, endMs: null, basis: "fixed", estimated: false, rollingMs: everyDurationMs(reset.every) }]
  }
  const followed = typeof reset !== "string" && "follow" in reset ? followedPeriod(findWindow(reset.follow), nowMs) : undefined
  if (followed?.basis === "provider" && followed.endMs !== null) {
    const length = followed.endMs - followed.startMs
    const first = Math.floor((fromMs - followed.startMs) / length)
    const last = Math.ceil((toMs - followed.startMs) / length) - 1
    const periods: Array<BudgetPeriod> = []
    for (let k = first; k <= last; k += 1) {
      const startMs = followed.startMs + k * length
      periods.push({ startMs, endMs: startMs + length, basis: "provider", estimated: followed.estimated || k !== 0 })
    }
    return periods
  }
  const stepReset: LimitReset = followed === undefined ? reset : "daily"
  const periods: Array<BudgetPeriod> = []
  let period = resolvePeriod(stepReset, fromMs, () => undefined)
  while (period.startMs < toMs) {
    periods.push(followed === undefined ? period : { ...period, basis: "fallback", estimated: true })
    if (period.endMs === null) break
    period = resolvePeriod(stepReset, period.endMs, () => undefined)
  }
  return periods
}

// ---- the timeline ----------------------------------------------------------

interface Bucket {
  startMs: number
  endMs: number
  nanoAiu: number
  requests: number
  cumulativeNanoAiu: number
  refused: number
  periodStartMs: number
}

interface PeriodTally {
  startMs: number
  endMs: number | null
  estimated: boolean
  spendNanoAiu: number
  warnedAtMs: number | null
  crossedAtMs: number | null
  refused: number
}

/** Why a report couldn't be made, as the route would answer it. */
export type ReportFailure = { status: 400 | 404; message: string }

const MAX_BUCKETS = 2000

function periodIndexAt(periods: ReadonlyArray<BudgetPeriod>, ms: number): number {
  return periods.findIndex((period) => ms >= period.startMs && (period.endMs === null || ms < period.endMs))
}

/** Buckets across the range, cut where a period resets so one never straddles it. */
function cutBuckets(size: BucketSize, fromMs: number, toMs: number, periods: ReadonlyArray<BudgetPeriod>): Array<Bucket> {
  const buckets: Array<Bucket> = []
  let cursor = bucketStart(size, fromMs)
  while (cursor < toMs) {
    const period = periods[Math.max(0, periodIndexAt(periods, cursor))]
    const regularEnd = nextBucketStart(size, bucketStart(size, cursor))
    const periodEnd = period?.endMs ?? Number.POSITIVE_INFINITY
    const endMs = Math.min(regularEnd, periodEnd > cursor ? periodEnd : regularEnd)
    buckets.push({
      startMs: cursor,
      endMs,
      nanoAiu: 0,
      requests: 0,
      cumulativeNanoAiu: 0,
      refused: 0,
      periodStartMs: period?.startMs ?? cursor,
    })
    cursor = endMs
  }
  return buckets
}

/**
 * How one rule performed over a range (`GET .../limits/:id/timeline`). The
 * refusals are what the rule's own replay refuses (the mock ledger records
 * every request, none was actually turned away), so a spent rule shows
 * refusals from the moment it was reached, as it would have in life.
 */
export function buildTimeline(
  context: ReportContext,
  limit: ReportLimit,
  query: RangeQuery & { bucket?: string | undefined },
): BudgetTimelineResponse | ReportFailure {
  const parsed = parseUsageRange(query, context.nowMs, "7d")
  if (!parsed.ok) return { status: 400, message: parsed.message }
  const range = { ...parsed.range }
  const firstRowMs = context.rows.reduce((first, row) => Math.min(first, row.atMs), context.nowMs)
  if (range.label === "all") range.fromMs = Math.min(firstRowMs, context.nowMs - 1)
  if (query.bucket !== undefined && !isBucketSize(query.bucket)) {
    return { status: 400, message: "bucket must be hour, day or week" }
  }
  const bucket: BucketSize = isBucketSize(query.bucket) ? query.bucket : defaultBucket(range.toMs - range.fromMs)
  const alignedFromMs = bucketStart(bucket, range.fromMs)
  if ((range.toMs - alignedFromMs) / (bucket === "hour" ? HOUR_MS : bucket === "day" ? DAY_MS : 7 * DAY_MS) > MAX_BUCKETS) {
    return { status: 400, message: "that range has too many buckets; choose a coarser bucket" }
  }

  const periods = periodsInRange(limit.limitReset, context.findWindow, { fromMs: alignedFromMs, toMs: range.toMs, nowMs: context.nowMs })
  const first = periods[0]
  const rolling = first?.rollingMs !== undefined
  const bounded = first !== undefined && first.endMs !== null
  const rowsFromMs = rolling ? alignedFromMs - (first?.rollingMs ?? 0) : bounded ? Math.min(alignedFromMs, first.startMs) : alignedFromMs
  const events = eventsFor(context, limit.scope, rowsFromMs, range.toMs)
  // A lifetime rule has no period start to read from: what came before the range is its baseline.
  const summed = !bounded && !rolling && first !== undefined && first.startMs < alignedFromMs
  const baseline = summed ? eventsFor(context, limit.scope, first.startMs, alignedFromMs).reduce((sum, e) => sum + e.nanoAiu, 0) : 0

  const buckets = cutBuckets(bucket, range.fromMs, range.toMs, periods)
  const ledger = createLedger(periods, baseline)
  const warnLine = Math.ceil(limit.limit * limit.warnAt)
  const tallies = new Map<number, PeriodTally>()
  const refusals: Array<{ atMs: number; nanoAiu: number; periodStartMs: number }> = []
  const open = (source: BudgetPeriod): PeriodTally => {
    const found = tallies.get(source.startMs)
    if (found) return found
    const tally: PeriodTally = {
      startMs: source.startMs,
      endMs: source.endMs,
      estimated: source.estimated,
      spendNanoAiu: 0,
      warnedAtMs: null,
      crossedAtMs: null,
      refused: 0,
    }
    tallies.set(source.startMs, tally)
    return tally
  }
  const note = (tally: PeriodTally, atMs: number, before: number, after: number): void => {
    if (tally.warnedAtMs === null && before < warnLine && after >= warnLine) tally.warnedAtMs = atMs
    if (tally.crossedAtMs === null && before < limit.limit && after >= limit.limit) tally.crossedAtMs = atMs
  }
  const firstStartMs = buckets[0]?.startMs ?? range.toMs
  let index = 0
  /** Count a request, or turn it away: a blocking rule refuses once the period has reached the limit. */
  const absorb = (event: UsageEvent): boolean => {
    ledger.advance(event.atMs)
    const tally = open(periods[ledger.periodIndex] as BudgetPeriod)
    const before = ledger.used
    if (limit.action === "block" && before >= limit.limit && event.atMs >= firstStartMs) {
      refusals.push({ atMs: event.atMs, nanoAiu: event.nanoAiu, periodStartMs: tally.startMs })
      return false
    }
    ledger.add(event.nanoAiu)
    note(tally, Math.max(event.atMs, firstStartMs), before, ledger.used)
    return true
  }
  while (index < events.length && (events[index] as UsageEvent).atMs < firstStartMs) absorb(events[index++] as UsageEvent)
  const opened = new Set<number>()
  for (const b of buckets) {
    ledger.advance(b.startMs)
    const tally = open(periods[ledger.periodIndex] as BudgetPeriod)
    if (!opened.has(ledger.periodIndex)) {
      opened.add(ledger.periodIndex)
      note(tally, b.startMs, -1, ledger.used)
    }
    while (index < events.length && (events[index] as UsageEvent).atMs < b.endMs) {
      const event = events[index++] as UsageEvent
      if (absorb(event)) {
        b.nanoAiu += event.nanoAiu
        b.requests += 1
      } else {
        b.refused += 1
        tally.refused += 1
      }
    }
    ledger.advance(b.endMs - 1)
    b.cumulativeNanoAiu = ledger.used
    tally.spendNanoAiu = ledger.used
  }

  // One refused marker per bucket that had any.
  const markers: BudgetTimelineResponse["markers"] = []
  let current: { bucket: Bucket; marker: BudgetTimelineResponse["markers"][number] } | undefined
  for (const refusal of refusals) {
    const owner = buckets.find((b) => refusal.atMs >= b.startMs && refusal.atMs < b.endMs)
    if (!owner) continue
    if (current?.bucket !== owner) {
      current = {
        bucket: owner,
        marker: { kind: "refused", at: iso(refusal.atMs), period_start: iso(owner.periodStartMs), count: 0, estimate_nano_aiu: 0 },
      }
      markers.push(current.marker)
    }
    current.marker.count = (current.marker.count ?? 0) + 1
    current.marker.estimate_nano_aiu = (current.marker.estimate_nano_aiu ?? 0) + refusal.nanoAiu
  }
  const sortedTallies = [...tallies.values()].sort((a, b) => a.startMs - b.startMs)
  for (const tally of sortedTallies) {
    if (tally.warnedAtMs !== null) markers.push({ kind: "warned", at: iso(tally.warnedAtMs), period_start: iso(tally.startMs) })
    if (tally.crossedAtMs !== null) markers.push({ kind: "crossed", at: iso(tally.crossedAtMs), period_start: iso(tally.startMs) })
  }
  markers.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  const amount = (nano: number): number => nanoAiuToDisplay(nano, context.display)
  const sum = (pick: (b: Bucket) => number): number => buckets.reduce((total, b) => total + pick(b), 0)
  return {
    limit: {
      id: limit.id,
      label: limit.label ?? null,
      scope: limit.scope,
      action: limit.action,
      limit_reset: limit.limitReset,
      warn_at: limit.warnAt,
      limit: limit.limit,
      warn_line: warnLine,
      display: { limit: amount(limit.limit), warn_line: amount(warnLine) },
    },
    display: { unit: context.display.unit, credit_usd: context.display.creditUsd },
    range: {
      from: iso(alignedFromMs),
      to: iso(range.toMs),
      label: range.label === "day" || range.label === "week" || range.label === "month" ? "custom" : range.label,
      bucket,
    },
    buckets: buckets.map((b) => ({
      start: iso(b.startMs),
      end: iso(b.endMs),
      nano_aiu: b.nanoAiu,
      requests: b.requests,
      cumulative_nano_aiu: b.cumulativeNanoAiu,
      refused: b.refused,
      period_start: iso(b.periodStartMs),
      amount: amount(b.nanoAiu),
      cumulative_amount: amount(b.cumulativeNanoAiu),
    })),
    periods: sortedTallies.map((p) => ({
      start: iso(p.startMs),
      end: isoOrNull(p.endMs),
      estimated: p.estimated,
      spend_nano_aiu: p.spendNanoAiu,
      warned_at: isoOrNull(p.warnedAtMs),
      crossed_at: isoOrNull(p.crossedAtMs),
      refused: p.refused,
    })),
    markers,
    totals: {
      nano_aiu: sum((b) => b.nanoAiu),
      requests: sum((b) => b.requests),
      refused: sum((b) => b.refused),
      refused_estimate_nano_aiu: markers.reduce((total, m) => total + (m.estimate_nano_aiu ?? 0), 0),
      periods_crossed: sortedTallies.filter((p) => p.crossedAtMs !== null).length,
    },
  }
}

// ---- what-if ---------------------------------------------------------------

/** The value at rank `ceil(p * n)` of the sorted samples. */
function percentile(sorted: ReadonlyArray<number>, p: number): number | undefined {
  if (sorted.length === 0) return undefined
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1]
}

interface SimPeriod {
  startMs: number
  endMs: number | null
  estimated: boolean
  spendNanoAiu: number
  refusedRequests: number
  refusedNanoAiu: number
  warnedAtMs: number | null
  trippedAtMs: number | null
}

/** Replay a draft over the ledger, as the real `simulateDraft` does: the chat gate's decision per request, nothing billed once refused. */
export function simulateDraft(
  context: ReportContext,
  draft: ReportLimit,
  window: { fromMs: number; toMs: number },
): BudgetSimulationResult {
  const { fromMs, toMs } = window
  const source = periodsInRange(draft.limitReset, context.findWindow, { fromMs, toMs, nowMs: context.nowMs })
  const rollingMs = source[0]?.rollingMs
  const rolling = rollingMs !== undefined && rollingMs > 0
  const readFromMs =
    source[0] === undefined ? fromMs
    : rolling ? fromMs - (rollingMs ?? 0)
    : source[0].endMs === null ? fromMs
    : Math.min(fromMs, source[0].startMs)
  const events = eventsFor(context, draft.scope, readFromMs, toMs)
  const ledger = createLedger(source)
  const periods: Array<SimPeriod> = rolling ?
      []
    : source.map((p) => ({
        startMs: p.startMs,
        endMs: p.endMs,
        estimated: p.estimated,
        spendNanoAiu: 0,
        refusedRequests: 0,
        refusedNanoAiu: 0,
        warnedAtMs: null,
        trippedAtMs: null,
      }))
  const firstStartMs = periods[0]?.startMs ?? Number.NEGATIVE_INFINITY
  const tally = { matchedRequests: 0, matchedNanoAiu: 0, refusedRequests: 0, refusedNanoAiu: 0, warnedAtMs: null as number | null, trippedAtMs: null as number | null }
  const free = rolling ? createLedger([{ startMs: 0, endMs: null, basis: "fixed", estimated: false, rollingMs: rollingMs ?? 0 }]) : undefined
  const peak = { nanoAiu: 0, atMs: null as number | null }
  const matched: Array<UsageEvent> = []
  for (const event of events) {
    if (!rolling && event.atMs < firstStartMs) continue
    matched.push(event)
    ledger.advance(event.atMs)
    const used = ledger.used
    const tripped = used >= draft.limit
    const warned = used >= draft.limit * draft.warnAt
    const refused = draft.action === "block" && tripped
    const inWindow = event.atMs >= fromMs && event.atMs < toMs
    const period = rolling ? undefined : periods[ledger.periodIndex]
    if (inWindow) {
      tally.matchedRequests += 1
      tally.matchedNanoAiu += event.nanoAiu
      if (warned) {
        tally.warnedAtMs ??= event.atMs
        if (period) period.warnedAtMs ??= event.atMs
      }
      if (tripped) {
        tally.trippedAtMs ??= event.atMs
        if (period) period.trippedAtMs ??= event.atMs
      }
      if (refused) {
        tally.refusedRequests += 1
        tally.refusedNanoAiu += event.nanoAiu
        if (period) {
          period.refusedRequests += 1
          period.refusedNanoAiu += event.nanoAiu
        }
      }
    }
    if (!refused) ledger.add(event.nanoAiu)
    if (period) period.spendNanoAiu += event.nanoAiu
    if (free) {
      free.advance(event.atMs)
      free.add(event.nanoAiu)
      if (inWindow && free.used > peak.nanoAiu) {
        peak.nanoAiu = free.used
        peak.atMs = event.atMs
      }
    }
  }

  let samples: Array<number>
  if (rolling) {
    const sampler = createLedger([{ startMs: 0, endMs: null, basis: "fixed", estimated: false, rollingMs: rollingMs ?? 0 }])
    samples = []
    let at = 0
    for (let hourEnd = Math.floor(fromMs / HOUR_MS) * HOUR_MS + HOUR_MS; hourEnd - HOUR_MS < toMs; hourEnd += HOUR_MS) {
      for (; at < matched.length && (matched[at] as UsageEvent).atMs < hourEnd; at += 1) {
        sampler.advance((matched[at] as UsageEvent).atMs)
        sampler.add((matched[at] as UsageEvent).nanoAiu)
      }
      sampler.advance(hourEnd - 1)
      samples.push(sampler.used)
    }
  } else {
    for (const period of periods) {
      if (period.spendNanoAiu > peak.nanoAiu) {
        peak.nanoAiu = period.spendNanoAiu
        peak.atMs = period.startMs
      }
    }
    // A period still open at the window's end is left out when an earlier one is complete.
    const complete = periods.filter((p) => !(p.endMs !== null && p.endMs > toMs))
    samples = (complete.length > 0 ? complete : periods).map((p) => p.spendNanoAiu)
  }
  const p90 = percentile(samples.sort((a, b) => a - b), 0.9)
  const suggested = p90 === undefined || p90 === 0 ? null : p90
  const amount = (nano: number): number => nanoAiuToDisplay(nano, context.display)
  const count = (pick: (p: SimPeriod) => number | null): number | null => (rolling ? null : periods.filter((p) => pick(p) !== null).length)
  return {
    id: draft.id,
    label: draft.label ?? null,
    scope: draft.scope,
    limit: draft.limit,
    limit_reset: draft.limitReset,
    warn_at: draft.warnAt,
    action: draft.action,
    mode: rolling ? "rolling" : "periods",
    matched_requests: tally.matchedRequests,
    matched_nano_aiu: tally.matchedNanoAiu,
    admitted_nano_aiu: tally.matchedNanoAiu - tally.refusedNanoAiu,
    refused_requests: tally.refusedRequests,
    refused_nano_aiu: tally.refusedNanoAiu,
    warned_at: isoOrNull(tally.warnedAtMs),
    tripped_at: isoOrNull(tally.trippedAtMs),
    peak: { nano_aiu: peak.nanoAiu, at: isoOrNull(peak.atMs) },
    periods_total: rolling ? null : periods.length,
    periods_warned: count((p) => p.warnedAtMs),
    periods_tripped: count((p) => p.trippedAtMs),
    suggested_nano_aiu: suggested,
    display: {
      limit: amount(draft.limit),
      matched: amount(tally.matchedNanoAiu),
      refused: amount(tally.refusedNanoAiu),
      peak: amount(peak.nanoAiu),
      suggested: suggested === null ? null : amount(suggested),
    },
    periods: periods.map((p) => ({
      start: iso(p.startMs),
      end: isoOrNull(p.endMs),
      estimated: p.estimated,
      spend_nano_aiu: p.spendNanoAiu,
      refused_requests: p.refusedRequests,
      refused_nano_aiu: p.refusedNanoAiu,
      warned_at: isoOrNull(p.warnedAtMs),
      tripped_at: isoOrNull(p.trippedAtMs),
    })),
  }
}

/** The window a simulation covers: a named trailing range, or `from` (to now) / `{ from, to }`. `all` starts at the first recorded request. */
export function simulationWindow(
  context: ReportContext,
  range: BudgetSimulateRequest["range"],
): { fromMs: number; toMs: number; label: string } | ReportFailure {
  const query: RangeQuery = range === undefined ? {} : typeof range === "string" ? { range } : range
  const parsed = parseUsageRange(query, context.nowMs, "30d")
  if (!parsed.ok) return { status: 400, message: parsed.message }
  const { range: resolved } = parsed
  if (resolved.label !== "all") return { fromMs: resolved.fromMs, toMs: resolved.toMs, label: resolved.label }
  const firstMs = context.rows.reduce((first, row) => Math.min(first, row.atMs), context.nowMs)
  return { fromMs: Math.min(firstMs, context.nowMs - 1), toMs: resolved.toMs, label: "all" }
}

/** `POST /settings/api/budget/simulate`: each draft replayed on its own. */
export function simulate(context: ReportContext, request: BudgetSimulateRequest, drafts: Array<ReportLimit>): BudgetSimulateResponse | ReportFailure {
  const window = simulationWindow(context, request.range)
  if ("status" in window) return window
  const label = window.label === "day" || window.label === "week" || window.label === "month" ? "custom" : window.label
  return {
    range: { from: iso(window.fromMs), to: iso(window.toMs), label: label as BudgetSimulateResponse["range"]["label"] },
    display: { unit: context.display.unit, credit_usd: context.display.creditUsd },
    requests_replayed: drafts.reduce((most, draft) => Math.max(most, eventsFor(context, draft.scope, 0, window.toMs).length), 0),
    results: drafts.map((draft) => simulateDraft(context, draft, window)),
  }
}
