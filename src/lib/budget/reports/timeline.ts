/**
 * How one limit performed over time: usage in buckets, the cumulative spend
 * inside each of its periods against the limit and warning lines, when it was
 * crossed, and how many requests it refused.
 *
 * `computeTimeline` is pure (rows, periods and events in; milliseconds out).
 * `buildLimitTimeline` reads the rows and the decision log and maps the
 * result to the wire contract.
 */

import type { BudgetTimelineResponse } from "~/lib/config/settings-types"

import { getNanoAiuSpend } from "~/lib/token-usage/spend"

import type { BudgetConfig, BudgetLimitConfig } from "../schema"
import type { UsageRange } from "./range"
import type { SpendRow } from "./usage"

import {
  everyDurationMs,
  followedPeriod,
  resolvePeriod,
  type BudgetPeriod,
  type FollowedWindow,
} from "../periods"
import { DEFAULT_WARN_AT, type BudgetLimitReset } from "../schema"
import { resolveScope } from "../scope"
import { nanoAiuToDisplay, resolveBudgetDisplay } from "../units"
import { bucketStart, nextBucketStart, type BucketSize } from "./buckets"
import { getBudgetEvents } from "./events"
import { createLedger } from "./ledger"
import { getSpendRows } from "./usage"

/** The periods of a reset rule that overlap `[fromMs, toMs)`, oldest first.
 *  Fixed rules (daily, weekly, monthly) step through `resolvePeriod`. A
 *  followed window only knows its current period, so the others are that
 *  period's length repeated, marked estimated. A rolling window has no periods
 *  to step through: one open period stands for it, with `rollingMs` set. */
export function periodsInRange(
  reset: BudgetLimitReset,
  findWindow: (ref: string) => FollowedWindow | undefined,
  range: { fromMs: number; toMs: number; nowMs: number },
): Array<BudgetPeriod> {
  const { fromMs, toMs, nowMs } = range
  if (typeof reset !== "string" && "every" in reset) {
    return [
      {
        startMs: fromMs,
        endMs: null,
        basis: "fixed",
        estimated: false,
        rollingMs: everyDurationMs(reset.every),
      },
    ]
  }
  const followed =
    typeof reset !== "string" && "follow" in reset ?
      followedPeriod(findWindow(reset.follow), nowMs)
    : undefined
  if (followed?.basis === "provider" && followed.endMs !== null) {
    const length = followed.endMs - followed.startMs
    const first = Math.floor((fromMs - followed.startMs) / length)
    const last = Math.ceil((toMs - followed.startMs) / length) - 1
    const periods: Array<BudgetPeriod> = []
    for (let k = first; k <= last; k++) {
      const startMs = followed.startMs + k * length
      periods.push({
        startMs,
        endMs: startMs + length,
        basis: "provider",
        estimated: followed.estimated || k !== 0,
      })
    }
    return periods
  }

  // A fixed rule, or a followed window that fell back to daily.
  const stepReset: BudgetLimitReset = followed === undefined ? reset : "daily"
  const periods: Array<BudgetPeriod> = []
  let period = resolvePeriod(stepReset, fromMs, () => undefined)
  while (period.startMs < toMs) {
    periods.push(
      followed === undefined ? period : (
        { ...period, basis: "fallback", estimated: true }
      ),
    )
    if (period.endMs === null) break
    period = resolvePeriod(stepReset, period.endMs, () => undefined)
  }
  return periods
}

export interface TimelineBucketMs {
  startMs: number
  /** Exclusive. */
  endMs: number
  nanoAiu: number
  requests: number
  cumulativeNanoAiu: number
  refused: number
  periodStartMs: number
}

export interface TimelinePeriodMs {
  startMs: number
  endMs: number | null
  estimated: boolean
  spendNanoAiu: number
  warnedAtMs: number | null
  crossedAtMs: number | null
  refused: number
}

export interface TimelineMarkerMs {
  kind: "crossed" | "refused" | "warned"
  atMs: number
  periodStartMs: number
  count?: number
  estimateNanoAiu?: number
}

export interface TimelineInput {
  limitNanoAiu: number
  warnAt: number
  bucket: BucketSize
  fromMs: number
  toMs: number
  periods: ReadonlyArray<BudgetPeriod>
  /** Rows in time order. They may start before `fromMs` (earlier in the
   *  first period, to count toward it); those fall in no bucket. */
  rows: ReadonlyArray<SpendRow>
  /** Spend in the first period before the first row, when the rows could not
   *  start at the period's start (a limit that never resets). */
  baselineNanoAiu?: number
  /** The limit's refusals, in time order. */
  refusals: ReadonlyArray<{ atMs: number; estimateNanoAiu: number }>
}

export interface Timeline {
  buckets: Array<TimelineBucketMs>
  periods: Array<TimelinePeriodMs>
  markers: Array<TimelineMarkerMs>
  warnLineNanoAiu: number
}

function periodIndexAt(
  periods: ReadonlyArray<BudgetPeriod>,
  ms: number,
): number {
  return periods.findIndex(
    (period) =>
      ms >= period.startMs && (period.endMs === null || ms < period.endMs),
  )
}

/** The cut-up timeline: buckets that never straddle a period's reset. */
function cutBuckets(input: TimelineInput): Array<TimelineBucketMs> {
  const buckets: Array<TimelineBucketMs> = []
  let cursor = bucketStart(input.bucket, input.fromMs)
  while (cursor < input.toMs) {
    const index = periodIndexAt(input.periods, cursor)
    const period = input.periods[Math.max(0, index)]
    const regularEnd = nextBucketStart(
      input.bucket,
      bucketStart(input.bucket, cursor),
    )
    const periodEnd = period.endMs ?? Number.POSITIVE_INFINITY
    // A cursor no period covers still moves on, to the bucket's end.
    const endMs = Math.min(
      regularEnd,
      periodEnd > cursor ? periodEnd : regularEnd,
    )
    buckets.push({
      startMs: cursor,
      endMs,
      nanoAiu: 0,
      requests: 0,
      cumulativeNanoAiu: 0,
      refused: 0,
      periodStartMs: period.startMs,
    })
    cursor = endMs
  }
  return buckets
}

const lineOf = (input: TimelineInput): number =>
  Math.ceil(input.limitNanoAiu * input.warnAt)

/** Note the first time a period's spend reached the warning line and the
 *  limit. `before` is -1 for a period that opens already carrying `after`. */
function noteCrossings(
  period: TimelinePeriodMs,
  input: TimelineInput,
  step: { atMs: number; before: number; after: number },
): void {
  const { atMs, before, after } = step
  if (
    period.warnedAtMs === null
    && before < lineOf(input)
    && after >= lineOf(input)
  ) {
    period.warnedAtMs = atMs
  }
  if (
    period.crossedAtMs === null
    && before < input.limitNanoAiu
    && after >= input.limitNanoAiu
  ) {
    period.crossedAtMs = atMs
  }
}

function openPeriod(source: BudgetPeriod): TimelinePeriodMs {
  return {
    startMs: source.startMs,
    endMs: source.endMs,
    estimated: source.estimated,
    spendNanoAiu: 0,
    warnedAtMs: null,
    crossedAtMs: null,
    refused: 0,
  }
}

/** Walk the buckets in order through a ledger of the limit's spend, consuming
 *  the rows as the buckets pass them. Fills each bucket's spend, requests and
 *  cumulative spend; returns the periods. A crossing before the range opened
 *  reads as the range's start. */
function walkBuckets(
  input: TimelineInput,
  buckets: ReadonlyArray<TimelineBucketMs>,
): Map<number, TimelinePeriodMs> {
  const periods = new Map<number, TimelinePeriodMs>()
  const ledger = createLedger(input.periods, input.baselineNanoAiu ?? 0)
  const firstStartMs = buckets.at(0)?.startMs ?? input.toMs
  const periodNow = (): TimelinePeriodMs => {
    const source = input.periods[ledger.periodIndex]
    const period = periods.get(source.startMs) ?? openPeriod(source)
    periods.set(source.startMs, period)
    return period
  }
  let rowIndex = 0
  const absorb = (row: SpendRow): void => {
    ledger.advance(row.createdAtMs)
    const before = ledger.used
    ledger.add(row.nanoAiu)
    noteCrossings(periodNow(), input, {
      atMs: Math.max(row.createdAtMs, firstStartMs),
      before,
      after: ledger.used,
    })
  }
  // Rows from before the range, in the first period (or the first window).
  while (
    rowIndex < input.rows.length
    && input.rows[rowIndex].createdAtMs < firstStartMs
  ) {
    absorb(input.rows[rowIndex++])
  }
  const opened = new Set<number>()
  for (const bucket of buckets) {
    ledger.advance(bucket.startMs)
    const period = periodNow()
    if (!opened.has(ledger.periodIndex)) {
      opened.add(ledger.periodIndex)
      // Already past a line when the period opened.
      noteCrossings(period, input, {
        atMs: bucket.startMs,
        before: -1,
        after: ledger.used,
      })
    }
    while (
      rowIndex < input.rows.length
      && input.rows[rowIndex].createdAtMs < bucket.endMs
    ) {
      const row = input.rows[rowIndex++]
      absorb(row)
      bucket.nanoAiu += row.nanoAiu
      bucket.requests += 1
    }
    ledger.advance(bucket.endMs - 1)
    bucket.cumulativeNanoAiu = ledger.used
    period.spendNanoAiu = ledger.used
  }
  return periods
}

/** Count refusals per bucket and period; one marker per bucket that had any. */
function addRefusals(
  input: TimelineInput,
  buckets: ReadonlyArray<TimelineBucketMs>,
  periods: ReadonlyMap<number, TimelinePeriodMs>,
): Array<TimelineMarkerMs> {
  const markers: Array<TimelineMarkerMs> = []
  let bucketIndex = 0
  let current: TimelineMarkerMs | undefined
  for (const refusal of input.refusals) {
    while (
      bucketIndex < buckets.length
      && refusal.atMs >= buckets[bucketIndex].endMs
    ) {
      bucketIndex++
      current = undefined
    }
    const bucket = buckets.at(bucketIndex)
    if (bucket === undefined || refusal.atMs < bucket.startMs) continue
    bucket.refused += 1
    const period = periods.get(bucket.periodStartMs)
    if (period) period.refused += 1
    if (current === undefined) {
      current = {
        kind: "refused",
        atMs: refusal.atMs,
        periodStartMs: bucket.periodStartMs,
        count: 0,
        estimateNanoAiu: 0,
      }
      markers.push(current)
    }
    current.count = (current.count ?? 0) + 1
    current.estimateNanoAiu =
      (current.estimateNanoAiu ?? 0) + refusal.estimateNanoAiu
  }
  return markers
}

export function computeTimeline(input: TimelineInput): Timeline {
  const buckets = cutBuckets(input)
  const periodMap = walkBuckets(input, buckets)
  const markers = addRefusals(input, buckets, periodMap)
  const periods = [...periodMap.values()].sort((a, b) => a.startMs - b.startMs)
  for (const period of periods) {
    if (period.warnedAtMs !== null) {
      markers.push({
        kind: "warned",
        atMs: period.warnedAtMs,
        periodStartMs: period.startMs,
      })
    }
    if (period.crossedAtMs !== null) {
      markers.push({
        kind: "crossed",
        atMs: period.crossedAtMs,
        periodStartMs: period.startMs,
      })
    }
  }
  markers.sort((a, b) => a.atMs - b.atMs)
  return { buckets, periods, markers, warnLineNanoAiu: lineOf(input) }
}

const iso = (ms: number): string => new Date(ms).toISOString()

export interface TimelineQuery {
  limit: BudgetLimitConfig
  config: BudgetConfig | undefined
  range: UsageRange
  bucket: BucketSize
  nowMs: number
  findWindow: (ref: string) => FollowedWindow | undefined
}

/** What the timeline reads: the rows that count toward its periods, the
 *  spend before them for a lifetime limit, and the limit's refusals. */
async function readTimelineData(
  query: TimelineQuery,
  periods: ReadonlyArray<BudgetPeriod>,
  alignedFromMs: number,
): Promise<{
  rows: Array<SpendRow>
  baselineNanoAiu: number
  refusals: Array<{ atMs: number; estimateNanoAiu: number }>
}> {
  const { limit, range } = query
  const scope = resolveScope(limit.scope, query.config?.filters)
  // The first period's earlier rows count toward it: a bounded period is read
  // from its start, a rolling window from one window back, and a lifetime
  // period is summed.
  const first = periods.at(0)
  const rollingMs = first?.rollingMs
  const bounded = first !== undefined && first.endMs !== null
  let rowsFromMs = alignedFromMs
  if (rollingMs !== undefined) rowsFromMs = alignedFromMs - rollingMs
  else if (bounded) rowsFromMs = Math.min(alignedFromMs, first.startMs)
  const summed =
    !bounded
    && rollingMs === undefined
    && first !== undefined
    && first.startMs < alignedFromMs
  const [rows, [baselineNanoAiu], refusals] = await Promise.all([
    getSpendRows(scope, rowsFromMs, range.toMs),
    summed ?
      getNanoAiuSpend(scope, [{ startMs: first.startMs, endMs: alignedFromMs }])
    : Promise.resolve([0]),
    getBudgetEvents({
      limitId: limit.id,
      kind: "refused",
      fromMs: alignedFromMs,
      toMs: range.toMs,
    }),
  ])
  return {
    rows,
    baselineNanoAiu,
    refusals: refusals.map((event) => ({
      atMs: event.atMs,
      estimateNanoAiu: event.estimateNanoAiu,
    })),
  }
}

/** Read what the timeline needs and shape it as the wire response. */
export async function buildLimitTimeline(
  query: TimelineQuery,
): Promise<BudgetTimelineResponse> {
  const { limit, config, range, bucket } = query
  const display = resolveBudgetDisplay(config)
  const warnAt = limit.warnAt ?? DEFAULT_WARN_AT
  const alignedFromMs = bucketStart(bucket, range.fromMs)
  const periods = periodsInRange(limit.limitReset, query.findWindow, {
    fromMs: alignedFromMs,
    toMs: range.toMs,
    nowMs: query.nowMs,
  })
  const data = await readTimelineData(query, periods, alignedFromMs)
  const timeline = computeTimeline({
    limitNanoAiu: limit.limit,
    warnAt,
    bucket,
    fromMs: range.fromMs,
    toMs: range.toMs,
    periods,
    ...data,
  })

  const amount = (nano: number): number => nanoAiuToDisplay(nano, display)
  const sum = (pick: (b: TimelineBucketMs) => number): number =>
    timeline.buckets.reduce((total, b) => total + pick(b), 0)
  return {
    limit: {
      id: limit.id,
      label: limit.label ?? null,
      scope: limit.scope,
      action: limit.action,
      limit_reset: limit.limitReset,
      warn_at: warnAt,
      limit: limit.limit,
      warn_line: timeline.warnLineNanoAiu,
      display: {
        limit: amount(limit.limit),
        warn_line: amount(timeline.warnLineNanoAiu),
      },
    },
    display: { unit: display.unit, credit_usd: display.creditUsd },
    range: {
      from: iso(alignedFromMs),
      to: iso(range.toMs),
      label: wireLabel(range.label),
      bucket,
    },
    buckets: timeline.buckets.map((b) => ({
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
    periods: timeline.periods.map((period) => ({
      start: iso(period.startMs),
      end: period.endMs === null ? null : iso(period.endMs),
      estimated: period.estimated,
      spend_nano_aiu: period.spendNanoAiu,
      warned_at: period.warnedAtMs === null ? null : iso(period.warnedAtMs),
      crossed_at: period.crossedAtMs === null ? null : iso(period.crossedAtMs),
      refused: period.refused,
    })),
    markers: timeline.markers.map((marker) => ({
      kind: marker.kind,
      at: iso(marker.atMs),
      period_start: iso(marker.periodStartMs),
      ...(marker.count === undefined ? {} : { count: marker.count }),
      ...(marker.estimateNanoAiu === undefined ?
        {}
      : { estimate_nano_aiu: marker.estimateNanoAiu }),
    })),
    totals: {
      nano_aiu: sum((b) => b.nanoAiu),
      requests: sum((b) => b.requests),
      refused: sum((b) => b.refused),
      refused_estimate_nano_aiu: timeline.markers.reduce(
        (total, m) => total + (m.estimateNanoAiu ?? 0),
        0,
      ),
      periods_crossed: timeline.periods.filter((p) => p.crossedAtMs !== null)
        .length,
    },
  }
}

/** The timeline's named ranges are trailing ones; a period name (`week`) can
 *  only arrive from a caller that took the original activity form. */
function wireLabel(
  label: UsageRange["label"],
): BudgetTimelineResponse["range"]["label"] {
  return label === "day" || label === "week" || label === "month" ?
      "custom"
    : label
}
