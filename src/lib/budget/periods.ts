/**
 * When a limit's current period started and when it resets. Pure: every
 * function takes the clock and the provider window it follows.
 *
 * - `daily` and `weekly` reset at 00:00 UTC (weeks start on Monday); `never`
 *   is a lifetime cap.
 * - `{ monthly: { day } }` is a calendar month starting at 00:00 UTC on that
 *   day (1 to 28, so every month has one).
 * - `{ every: { hours | days } }` is a rolling window: spend counts while it
 *   is younger than the window, so the oldest counted spend stops counting
 *   exactly `window` after it was recorded. The period's start moves with
 *   the clock and its end is that moment, known only from the spend
 *   (`rollingPeriodEnd`).
 * - `{ follow }` runs from the window's previous reset to the `resetsAt` the
 *   provider last reported, so a reported reset that moves forward starts a
 *   new period. A rolling window runs `durationMs` back from `resetsAt`.
 * - With no earlier reset on record, a fixed window's period starts one
 *   calendar month before `resetsAt` (Copilot's cycle today), marked
 *   estimated.
 * - A window whose `resetsAt` passed with no newer report rolls forward by its
 *   last cycle length, marked estimated; with no cycle known, or a window
 *   never reported, the limit falls back to `daily`.
 */

import type { BudgetLimitReset } from "./schema"

export const DAY_MS = 86_400_000
export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
const WEEK_MS = 7 * DAY_MS

/** A provider window as period math needs it. */
export interface FollowedWindow {
  resetsAt?: string
  previousResetsAt?: string
  kind?: "fixed" | "rolling"
  durationMs?: number
}

export interface BudgetPeriod {
  startMs: number
  /** Exclusive; null for a period that never ends. */
  endMs: number | null
  /** `provider`: the window's own reset; `fixed`: daily/weekly/never;
   *  `fallback`: `daily` standing in for a window with no usable reset. */
  basis: "fixed" | "provider" | "fallback"
  /** True when the boundaries are Maximal's guess, not the provider's. */
  estimated: boolean
  /** Set for a rolling window: its length. `startMs` is the first instant
   *  that still counts; `endMs` is null until `rollingPeriodEnd` sets it. */
  rollingMs?: number
}

export function startOfUtcDay(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS
}

export function startOfUtcWeek(nowMs: number): number {
  const day = startOfUtcDay(nowMs)
  const daysSinceMonday = (new Date(day).getUTCDay() + 6) % 7
  return day - daysSinceMonday * DAY_MS
}

export function fixedPeriod(
  reset: "daily" | "weekly" | "never",
  nowMs: number,
): BudgetPeriod {
  if (reset === "never") {
    return { startMs: 0, endMs: null, basis: "fixed", estimated: false }
  }
  const startMs =
    reset === "daily" ? startOfUtcDay(nowMs) : startOfUtcWeek(nowMs)
  const lengthMs = reset === "daily" ? DAY_MS : WEEK_MS
  return {
    startMs,
    endMs: startMs + lengthMs,
    basis: "fixed",
    estimated: false,
  }
}

/** The rolling window of `durationMs` ending now. Spend recorded at `t`
 *  counts while `nowMs - t < durationMs`. */
export function rollingPeriod(durationMs: number, nowMs: number): BudgetPeriod {
  return {
    startMs: nowMs - durationMs + 1,
    endMs: null,
    basis: "fixed",
    estimated: false,
    rollingMs: durationMs,
  }
}

/** When a rolling window's oldest counted spend stops counting; null with no
 *  spend in the window (nothing to age out). */
export function rollingPeriodEnd(
  oldestSpendMs: number | undefined,
  durationMs: number,
): number | null {
  return oldestSpendMs === undefined ? null : oldestSpendMs + durationMs
}

/** The length of an `every` reset, in ms. */
export function everyDurationMs(
  every: { minutes: number } | { hours: number } | { days: number },
): number {
  if ("minutes" in every) return every.minutes * MINUTE_MS
  return "hours" in every ? every.hours * HOUR_MS : every.days * DAY_MS
}

/** The calendar month that started at 00:00 UTC on `day` (1 to 28) of this
 *  or the previous month, whichever is the latest one that has begun. */
export function monthlyPeriod(day: number, nowMs: number): BudgetPeriod {
  const now = new Date(nowMs)
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const started = nowMs >= Date.UTC(year, month, day) ? month : month - 1
  return {
    startMs: Date.UTC(year, started, day),
    endMs: Date.UTC(year, started + 1, day),
    basis: "fixed",
    estimated: false,
  }
}

function parseMs(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : undefined
}

/** The same instant one calendar month earlier (UTC), clamped to the
 *  month's last day. */
function oneMonthBefore(ms: number): number {
  const date = new Date(ms)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() - 1
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return Date.UTC(
    year,
    month,
    Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  )
}

function dailyFallback(nowMs: number): BudgetPeriod {
  return { ...fixedPeriod("daily", nowMs), basis: "fallback", estimated: true }
}

export function followedPeriod(
  window: FollowedWindow | undefined,
  nowMs: number,
): BudgetPeriod {
  const resetMs = parseMs(window?.resetsAt)
  if (window === undefined || resetMs === undefined) return dailyFallback(nowMs)

  const rolling =
    window.kind === "rolling"
    && window.durationMs !== undefined
    && window.durationMs > 0
  const previousMs = rolling ? undefined : parseMs(window.previousResetsAt)
  const usablePrevious =
    previousMs !== undefined && previousMs < resetMs ? previousMs : undefined
  let cycleMs: number | undefined
  if (rolling) cycleMs = window.durationMs
  else if (usablePrevious !== undefined) cycleMs = resetMs - usablePrevious

  if (nowMs < resetMs) {
    if (cycleMs !== undefined) {
      return {
        startMs: resetMs - cycleMs,
        endMs: resetMs,
        basis: "provider",
        estimated: false,
      }
    }
    return {
      startMs: oneMonthBefore(resetMs),
      endMs: resetMs,
      basis: "provider",
      estimated: true,
    }
  }

  // The reported reset has passed with no newer report.
  if (cycleMs === undefined) return dailyFallback(nowMs)
  const cyclesPast = Math.floor((nowMs - resetMs) / cycleMs) + 1
  const endMs = resetMs + cyclesPast * cycleMs
  return {
    startMs: endMs - cycleMs,
    endMs,
    basis: "provider",
    estimated: true,
  }
}

export function resolvePeriod(
  reset: BudgetLimitReset,
  nowMs: number,
  findWindow: (ref: string) => FollowedWindow | undefined,
): BudgetPeriod {
  if (typeof reset === "string") return fixedPeriod(reset, nowMs)
  if ("follow" in reset) return followedPeriod(findWindow(reset.follow), nowMs)
  if ("every" in reset) {
    return rollingPeriod(everyDurationMs(reset.every), nowMs)
  }
  return monthlyPeriod(reset.monthly.day, nowMs)
}
