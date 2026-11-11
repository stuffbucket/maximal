import { describe, expect, test } from "bun:test"

import {
  fixedPeriod,
  followedPeriod,
  resolvePeriod,
  type FollowedWindow,
} from "~/lib/budget/periods"
import {
  advanceProviderWindow,
  type ProviderQuotaWindow,
} from "~/lib/budget/provider-windows"
import {
  DEFAULT_CREDIT_USD,
  displayToNanoAiu,
  nanoAiuToDisplay,
  resolveBudgetDisplay,
} from "~/lib/budget/units"

const ms = (iso: string): number => Date.parse(iso)
const iso = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString()

describe("fixed periods", () => {
  test("daily runs from 00:00 UTC to the next 00:00 UTC", () => {
    const period = fixedPeriod("daily", ms("2026-11-10T23:59:59.999Z"))
    expect(iso(period.startMs)).toBe("2026-11-10T00:00:00.000Z")
    expect(iso(period.endMs)).toBe("2026-11-11T00:00:00.000Z")
    expect(period).toMatchObject({ basis: "fixed", estimated: false })
  })

  test("weekly starts on Monday 00:00 UTC", () => {
    // 2026-11-10 is a Tuesday; 2026-11-15 a Sunday; 2026-11-16 a Monday.
    for (const now of ["2026-11-10T12:00:00Z", "2026-11-15T23:59:59Z"]) {
      const period = fixedPeriod("weekly", ms(now))
      expect(iso(period.startMs)).toBe("2026-11-09T00:00:00.000Z")
      expect(iso(period.endMs)).toBe("2026-11-16T00:00:00.000Z")
    }
    const monday = fixedPeriod("weekly", ms("2026-11-16T00:00:00Z"))
    expect(iso(monday.startMs)).toBe("2026-11-16T00:00:00.000Z")
  })

  test("never is a lifetime period with no reset", () => {
    expect(fixedPeriod("never", ms("2026-11-10T12:00:00Z"))).toEqual({
      startMs: 0,
      endMs: null,
      basis: "fixed",
      estimated: false,
    })
  })
})

describe("periods that follow a provider window", () => {
  const now = ms("2026-11-10T12:00:00Z")

  test("runs from the previous reset to the reported one", () => {
    const period = followedPeriod(
      {
        resetsAt: "2026-12-01T00:00:00Z",
        previousResetsAt: "2026-11-01T00:00:00Z",
      },
      now,
    )
    expect(iso(period.startMs)).toBe("2026-11-01T00:00:00.000Z")
    expect(iso(period.endMs)).toBe("2026-12-01T00:00:00.000Z")
    expect(period).toMatchObject({ basis: "provider", estimated: false })
  })

  test("with no earlier reset, starts one calendar month back, estimated", () => {
    const period = followedPeriod({ resetsAt: "2026-12-01T00:00:00Z" }, now)
    expect(iso(period.startMs)).toBe("2026-11-01T00:00:00.000Z")
    expect(period).toMatchObject({ basis: "provider", estimated: true })

    const clamped = followedPeriod(
      { resetsAt: "2027-03-31T00:00:00Z" },
      ms("2027-03-10T00:00:00Z"),
    )
    expect(iso(clamped.startMs)).toBe("2027-02-28T00:00:00.000Z")
  })

  test("a rolling window runs its duration back from the reset", () => {
    const period = followedPeriod(
      {
        resetsAt: "2026-11-10T15:00:00Z",
        // Ignored for a rolling window.
        previousResetsAt: "2026-11-10T09:00:00Z",
        kind: "rolling",
        durationMs: 5 * 3_600_000,
      },
      now,
    )
    expect(iso(period.startMs)).toBe("2026-11-10T10:00:00.000Z")
    expect(iso(period.endMs)).toBe("2026-11-10T15:00:00.000Z")
    expect(period.estimated).toBe(false)
  })

  test("a reset that moves forward starts a new period", () => {
    const base: Omit<ProviderQuotaWindow, "resetsAt" | "observedAt"> = {
      provider: "copilot",
      id: "premium_interactions",
      label: "Copilot premium allowance",
      unit: "credits",
      source: "header",
    }
    const november = advanceProviderWindow(undefined, {
      ...base,
      resetsAt: "2026-12-01T00:00:00.000Z",
      observedAt: "2026-11-10T00:00:00.000Z",
    })
    const sameCycle = advanceProviderWindow(november, {
      ...base,
      resetsAt: "2026-12-01T00:00:00.000Z",
      observedAt: "2026-11-20T00:00:00.000Z",
    })
    expect(sameCycle.previousResetsAt).toBeUndefined()

    const december = advanceProviderWindow(sameCycle, {
      ...base,
      resetsAt: "2027-01-01T00:00:00.000Z",
      observedAt: "2026-12-01T00:05:00.000Z",
    })
    expect(december.previousResetsAt).toBe("2026-12-01T00:00:00.000Z")

    const period = followedPeriod(december, ms("2026-12-02T00:00:00Z"))
    expect(iso(period.startMs)).toBe("2026-12-01T00:00:00.000Z")
    expect(iso(period.endMs)).toBe("2027-01-01T00:00:00.000Z")
    expect(period.estimated).toBe(false)

    // The same report again keeps the previous reset.
    const repeat = advanceProviderWindow(december, {
      ...base,
      resetsAt: "2027-01-01T00:00:00.000Z",
      observedAt: "2026-12-02T00:00:00.000Z",
    })
    expect(repeat.previousResetsAt).toBe("2026-12-01T00:00:00.000Z")

    // A reset that moves back (another account) drops history it can't use.
    const back = advanceProviderWindow(repeat, {
      ...base,
      resetsAt: "2026-11-15T00:00:00.000Z",
      observedAt: "2026-12-03T00:00:00.000Z",
    })
    expect(back.previousResetsAt).toBeUndefined()
  })

  test("a passed reset with no newer report rolls forward by the last cycle", () => {
    const window: FollowedWindow = {
      resetsAt: "2026-12-01T00:00:00Z",
      previousResetsAt: "2026-11-01T00:00:00Z",
    }
    // Cycle is 30 days: Dec 1 → Dec 31 → Jan 30.
    const period = followedPeriod(window, ms("2027-01-05T00:00:00Z"))
    expect(iso(period.startMs)).toBe("2026-12-31T00:00:00.000Z")
    expect(iso(period.endMs)).toBe("2027-01-30T00:00:00.000Z")
    expect(period).toMatchObject({ basis: "provider", estimated: true })

    const boundary = followedPeriod(window, ms("2026-12-01T00:00:00Z"))
    expect(iso(boundary.startMs)).toBe("2026-12-01T00:00:00.000Z")
  })

  test("falls back to daily with no cycle, no reset, or no window", () => {
    const daily = fixedPeriod("daily", now)
    for (const window of [
      { resetsAt: "2026-11-01T00:00:00Z" },
      {},
      { resetsAt: "not a date" },
      undefined,
    ]) {
      const period = followedPeriod(window, now)
      expect(period).toEqual({
        startMs: daily.startMs,
        endMs: daily.endMs,
        basis: "fallback",
        estimated: true,
      })
    }
  })

  test("resolvePeriod looks the followed window up by reference", () => {
    const seen: Array<string> = []
    const period = resolvePeriod(
      { follow: "copilot:premium_interactions" },
      now,
      (ref) => {
        seen.push(ref)
        return { resetsAt: "2026-12-01T00:00:00Z" }
      },
    )
    expect(seen).toEqual(["copilot:premium_interactions"])
    expect(period.basis).toBe("provider")
    expect(resolvePeriod("weekly", now, () => undefined)).toEqual(
      fixedPeriod("weekly", now),
    )
  })
})

describe("display units", () => {
  test("defaults to USD at $0.01 per AI credit", () => {
    const display = resolveBudgetDisplay(undefined)
    expect(display).toEqual({ unit: "usd", creditUsd: DEFAULT_CREDIT_USD })
    // 0.6 AI credit, a low-quality 1024² image.
    expect(nanoAiuToDisplay(600_000_000, display)).toBeCloseTo(0.006, 12)
    expect(displayToNanoAiu(3, display)).toBe(300_000_000_000)
  })

  test("AI credits show the credit count", () => {
    const display = resolveBudgetDisplay({ display: { unit: "credits" } })
    expect(nanoAiuToDisplay(2_500_000_000, display)).toBe(2.5)
    expect(displayToNanoAiu(2.5, display)).toBe(2_500_000_000)
  })

  test("the creditUsd override changes the dollar figure only", () => {
    const display = resolveBudgetDisplay({ display: { creditUsd: 0.02 } })
    expect(display.unit).toBe("usd")
    expect(nanoAiuToDisplay(1_000_000_000, display)).toBeCloseTo(0.02, 12)
    expect(displayToNanoAiu(0.02, display)).toBe(1_000_000_000)
    const credits = resolveBudgetDisplay({
      display: { unit: "credits", creditUsd: 0.02 },
    })
    expect(nanoAiuToDisplay(1_000_000_000, credits)).toBe(1)
  })

  test("entered amounts round to whole nano-AIU", () => {
    const display = resolveBudgetDisplay(undefined)
    expect(Number.isInteger(displayToNanoAiu(0.1234567891234, display))).toBe(
      true,
    )
  })
})
