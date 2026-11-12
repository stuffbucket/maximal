/**
 * The time range a usage report covers, from the query string the activity,
 * timeline and session endpoints share: `from`/`to` (ISO instants),
 * `range=24h|7d|30d|90d|all`, or the original activity `period=day|week|month`
 * (since 00:00 UTC today, on Monday or on the 1st). Pure: the clock is a
 * parameter.
 *
 * A range is half-open, `[fromMs, toMs)`. A trailing range ends just after the moment
 * of the request, so a row recorded this millisecond is in it; `all` starts
 * at the epoch.
 */

import { DAY_MS, startOfUtcDay, startOfUtcWeek } from "../periods"

export const TRAILING_RANGES = ["24h", "7d", "30d", "90d", "all"] as const
export type TrailingRange = (typeof TRAILING_RANGES)[number]

export const PERIOD_RANGES = ["day", "week", "month"] as const
export type PeriodRange = (typeof PERIOD_RANGES)[number]

export type RangeLabel = TrailingRange | PeriodRange | "custom"

export interface UsageRange {
  fromMs: number
  /** Exclusive. */
  toMs: number
  label: RangeLabel
}

export type ParsedRange =
  | { ok: true; range: UsageRange }
  | { ok: false; message: string }

export interface RangeQuery {
  range?: string | undefined
  from?: string | undefined
  to?: string | undefined
  period?: string | undefined
}

const TRAILING_MS: Record<Exclude<TrailingRange, "all">, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
}

function isTrailing(value: string): value is TrailingRange {
  return (TRAILING_RANGES as ReadonlyArray<string>).includes(value)
}

function isPeriod(value: string): value is PeriodRange {
  return (PERIOD_RANGES as ReadonlyArray<string>).includes(value)
}

/** Midnight UTC today, on Monday, or on the 1st. */
export function periodStartMs(period: PeriodRange, nowMs: number): number {
  if (period === "day") return startOfUtcDay(nowMs)
  if (period === "week") return startOfUtcWeek(nowMs)
  const now = new Date(nowMs)
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
}

/** A named range as of `nowMs`. */
export function namedRange(
  name: TrailingRange | PeriodRange,
  nowMs: number,
): UsageRange {
  if (name === "all") return { fromMs: 0, toMs: nowMs + 1, label: name }
  if (isPeriod(name)) {
    return { fromMs: periodStartMs(name, nowMs), toMs: nowMs + 1, label: name }
  }
  return { fromMs: nowMs - TRAILING_MS[name], toMs: nowMs + 1, label: name }
}

function parseInstant(value: string): number | undefined {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

const RANGE_MESSAGE =
  "range must be 24h, 7d, 30d, 90d or all; period must be day, week or month; from and to must be ISO dates"

/** Resolve the query to a range: `from`/`to`, else `range`, else `period`,
 *  else `fallback`. Giving `from` or `to` together with `range` is an error,
 *  as is a range that ends before it starts. */
export function parseUsageRange(
  query: RangeQuery,
  nowMs: number,
  fallback: TrailingRange | PeriodRange,
): ParsedRange {
  const { range, from, to, period } = query
  if (from !== undefined || to !== undefined) {
    if (range !== undefined) {
      return { ok: false, message: "give from and to, or range, not both" }
    }
    if (from === undefined) {
      return { ok: false, message: "to needs a from" }
    }
    const fromMs = parseInstant(from)
    const toMs = to === undefined ? nowMs + 1 : parseInstant(to)
    if (fromMs === undefined || toMs === undefined) {
      return { ok: false, message: RANGE_MESSAGE }
    }
    if (fromMs >= toMs) {
      return { ok: false, message: "from must be before to" }
    }
    return { ok: true, range: { fromMs, toMs, label: "custom" } }
  }
  if (range !== undefined) {
    if (!isTrailing(range)) return { ok: false, message: RANGE_MESSAGE }
    return { ok: true, range: namedRange(range, nowMs) }
  }
  if (period !== undefined) {
    if (!isPeriod(period)) return { ok: false, message: RANGE_MESSAGE }
    return { ok: true, range: namedRange(period, nowMs) }
  }
  return { ok: true, range: namedRange(fallback, nowMs) }
}
