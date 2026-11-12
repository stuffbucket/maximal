/**
 * When a limit's current period started and when it resets. Pure: every
 * function takes the clock and the provider window it follows.
 *
 * - `daily` and `weekly` reset at 00:00 UTC (weeks start on Monday); `never`
 *   is a lifetime cap.
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
  return followedPeriod(findWindow(reset.follow), nowMs)
}
