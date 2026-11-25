/**
 * The replay ledger the timeline and the simulation share: periods start
 * over, a rolling window ages spend out exactly one window later.
 */

import { describe, expect, test } from "bun:test"

import type { BudgetPeriod } from "~/lib/budget/periods"

import { createLedger, isRolling } from "~/lib/budget/reports/ledger"

const HOUR = 3_600_000

const period = (startMs: number, endMs: number | null): BudgetPeriod => ({
  startMs,
  endMs,
  basis: "fixed",
  estimated: false,
})

const rolling = (windowMs: number): BudgetPeriod => ({
  ...period(0, null),
  rollingMs: windowMs,
})

describe("a ledger over periods", () => {
  const periods = [period(0, 100), period(100, 200), period(200, 300)]

  test("spend accumulates inside a period and starts over in the next", () => {
    const ledger = createLedger(periods)
    ledger.advance(10)
    ledger.add(5)
    ledger.advance(99)
    ledger.add(7)
    expect(ledger.used).toBe(12)
    expect(ledger.periodIndex).toBe(0)
    ledger.advance(100)
    expect(ledger.used).toBe(0)
    expect(ledger.periodIndex).toBe(1)
    ledger.add(3)
    ledger.advance(250)
    expect(ledger.periodIndex).toBe(2)
    expect(ledger.used).toBe(0)
  })

  test("a skipped period is skipped, not replayed", () => {
    const ledger = createLedger(periods)
    ledger.advance(0)
    ledger.add(4)
    ledger.advance(250)
    expect(ledger.periodIndex).toBe(2)
    expect(ledger.used).toBe(0)
  })

  test("the baseline counts in the first period only", () => {
    const ledger = createLedger(periods, 40)
    ledger.advance(1)
    expect(ledger.used).toBe(40)
    ledger.advance(150)
    expect(ledger.used).toBe(0)
  })

  test("a clock before the first period is in the first period", () => {
    const ledger = createLedger([period(50, 100)])
    ledger.advance(10)
    expect(ledger.periodIndex).toBe(0)
  })

  test("past the last period it stays in the last", () => {
    const ledger = createLedger(periods)
    ledger.advance(10_000)
    expect(ledger.periodIndex).toBe(2)
  })

  test("a lifetime period never starts over", () => {
    const ledger = createLedger([period(0, null)])
    ledger.advance(0)
    ledger.add(1)
    ledger.advance(Number.MAX_SAFE_INTEGER)
    expect(ledger.used).toBe(1)
  })
})

describe("a rolling ledger", () => {
  test("a cost counts for exactly one window", () => {
    const ledger = createLedger([rolling(5 * HOUR)])
    ledger.advance(0)
    ledger.add(10)
    ledger.advance(5 * HOUR - 1)
    expect(ledger.used).toBe(10)
    ledger.advance(5 * HOUR)
    expect(ledger.used).toBe(0)
  })

  test("costs age out in the order they were recorded", () => {
    const ledger = createLedger([rolling(HOUR)])
    ledger.advance(0)
    ledger.add(1)
    ledger.advance(HOUR / 2)
    ledger.add(2)
    ledger.advance(HOUR)
    expect(ledger.used).toBe(2)
    ledger.advance(1.5 * HOUR)
    expect(ledger.used).toBe(0)
  })

  test("the clock never runs backwards", () => {
    const ledger = createLedger([rolling(HOUR)])
    ledger.advance(10 * HOUR)
    ledger.add(5)
    ledger.advance(0)
    expect(ledger.used).toBe(5)
    ledger.add(1)
    ledger.advance(10 * HOUR + HOUR - 1)
    expect(ledger.used).toBe(6)
  })

  test("it knows a rolling set of periods from a fixed one", () => {
    expect(isRolling([rolling(HOUR)])).toBe(true)
    expect(isRolling([period(0, 10)])).toBe(false)
    expect(isRolling([])).toBe(false)
  })
})
