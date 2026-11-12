/**
 * The running spend of one limit as time moves forward, for replays: the
 * timeline reads rows through it, and the what-if simulation decides requests
 * with it. Two shapes, picked by the limit's periods:
 *
 * - **Periods** (daily, weekly, monthly, a followed window): spend starts
 *   over when the clock enters the next period.
 * - **Rolling** (`every N hours|days`): spend counts while it is younger than
 *   the window, so each cost leaves exactly one window after it was recorded
 *   (`now - t < window`, like the service's rolling ledger).
 *
 * Pure. The clock only moves forward.
 */

import type { BudgetPeriod } from "../periods"

export interface Ledger {
  /** Move the clock to `ms`: enter its period, or age out rolling spend. */
  advance(ms: number): void
  /** Count a cost at the current clock. */
  add(nanoAiu: number): void
  /** Spend counted now. */
  readonly used: number
  /** Which of the periods the clock is in (always 0 for a rolling window). */
  readonly periodIndex: number
}

export function isRolling(periods: ReadonlyArray<BudgetPeriod>): boolean {
  return periods.length > 0 && periods[0].rollingMs !== undefined
}

/** `baselineNanoAiu` is spend already counted in the first period (a
 *  lifetime limit's spend before the first row read). */
export function createLedger(
  periods: ReadonlyArray<BudgetPeriod>,
  baselineNanoAiu = 0,
): Ledger {
  return isRolling(periods) ?
      createRollingLedger(periods[0].rollingMs ?? 0)
    : createPeriodLedger(periods, baselineNanoAiu)
}

function createPeriodLedger(
  periods: ReadonlyArray<BudgetPeriod>,
  baselineNanoAiu: number,
): Ledger {
  let index = -1
  let used = 0
  return {
    advance(ms) {
      let next = Math.max(0, index)
      while (next + 1 < periods.length && ms >= periods[next + 1].startMs) {
        next++
      }
      if (next !== index) {
        index = next
        used = next === 0 ? baselineNanoAiu : 0
      }
    },
    add(nanoAiu) {
      used += nanoAiu
    },
    get used() {
      return used
    },
    get periodIndex() {
      return Math.max(0, index)
    },
  }
}

function createRollingLedger(windowMs: number): Ledger {
  const costs: Array<{ atMs: number; nanoAiu: number }> = []
  let head = 0
  let used = 0
  let clockMs = Number.NEGATIVE_INFINITY
  return {
    advance(ms) {
      clockMs = Math.max(clockMs, ms)
      while (head < costs.length && clockMs - costs[head].atMs >= windowMs) {
        used -= costs[head].nanoAiu
        head++
      }
    },
    add(nanoAiu) {
      costs.push({ atMs: clockMs, nanoAiu })
      used += nanoAiu
    },
    get used() {
      return used
    },
    periodIndex: 0,
  }
}
