/**
 * The what-if replay: usage rows in time order through a draft limit, using
 * the real scope matching and period math. Pure, so every case builds its own
 * rows and clock.
 */

import { afterEach, describe, expect, test } from "bun:test"

import {
  percentile,
  replayStartMs,
  rollingSamples,
  simulateDraft,
  type DraftLimit,
  type SimulationContext,
  type UsageEventRow,
} from "~/lib/budget/reports/simulate"

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const at = (...parts: [number, number, number, number?, number?]): number =>
  Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] ?? 0, parts[4] ?? 0)
/** Wednesday 2026-11-11 12:00 UTC. */
const NOW = at(2026, 11, 11, 12)

const originalTz = process.env.TZ
afterEach(() => {
  if (originalTz === undefined) Reflect.deleteProperty(process.env, "TZ")
  else process.env.TZ = originalTz
})

function draft(overrides: Partial<DraftLimit> = {}): DraftLimit {
  return {
    id: "draft",
    scope: { kind: "global" },
    limit: 100,
    limitReset: "daily",
    warnAt: 0.8,
    action: "block",
    ...overrides,
  }
}

function row(
  createdAtMs: number,
  nanoAiu: number,
  subject: Partial<UsageEventRow> = {},
): UsageEventRow {
  return {
    createdAtMs,
    nanoAiu,
    key: "claude-code",
    provider: "copilot",
    ...subject,
  }
}

function context(
  fromMs: number,
  toMs: number,
  overrides: Partial<SimulationContext> = {},
): SimulationContext {
  return { fromMs, toMs, nowMs: NOW, findWindow: () => undefined, ...overrides }
}

const week = context(at(2026, 11, 9), at(2026, 11, 16))

describe("a daily block limit", () => {
  const rows = [
    row(at(2026, 11, 9, 8), 60),
    row(at(2026, 11, 9, 9), 50),
    row(at(2026, 11, 9, 10), 40),
    row(at(2026, 11, 10, 8), 30),
  ]

  test("refuses what arrives after the limit was reached, and times the warning and the trip", () => {
    const result = simulateDraft(draft(), rows, week)

    // 60 is admitted (used 0), 50 is admitted (used 60), 40 finds 110 >= 100.
    expect(result.refusedRequests).toBe(1)
    expect(result.refusedNanoAiu).toBe(40)
    expect(result.matchedRequests).toBe(4)
    expect(result.matchedNanoAiu).toBe(180)
    expect(result.admittedNanoAiu).toBe(140)
    // The 50 found 60 used (under the 80 line); the 40 found 110.
    expect(result.warnedAtMs).toBe(at(2026, 11, 9, 10))
    expect(result.trippedAtMs).toBe(at(2026, 11, 9, 10))
    expect(result.mode).toBe("periods")
  })

  test("the peak is the busiest period with no limit in force", () => {
    const result = simulateDraft(draft(), rows, week)
    expect(result.peakNanoAiu).toBe(150)
    expect(result.peakAtMs).toBe(at(2026, 11, 9))
  })

  test("each period reports its own spend, refusals and crossings", () => {
    const result = simulateDraft(draft(), rows, week)
    expect(result.periodsTotal).toBe(7)
    expect(result.periodsTripped).toBe(1)
    expect(result.periodsWarned).toBe(1)
    expect(result.periods.slice(0, 2)).toMatchObject([
      {
        startMs: at(2026, 11, 9),
        endMs: at(2026, 11, 10),
        spendNanoAiu: 150,
        refusedRequests: 1,
        refusedNanoAiu: 40,
        warnedAtMs: at(2026, 11, 9, 10),
        trippedAtMs: at(2026, 11, 9, 10),
      },
      {
        spendNanoAiu: 30,
        refusedRequests: 0,
        warnedAtMs: null,
        trippedAtMs: null,
      },
    ])
  })

  test("a request that finds the spend exactly at the limit is refused; one short is admitted", () => {
    const exact = simulateDraft(
      draft(),
      [row(at(2026, 11, 9, 1), 100), row(at(2026, 11, 9, 2), 1)],
      week,
    )
    expect(exact.refusedRequests).toBe(1)
    const short = simulateDraft(
      draft(),
      [row(at(2026, 11, 9, 1), 99), row(at(2026, 11, 9, 2), 1)],
      week,
    )
    expect(short.refusedRequests).toBe(0)
    expect(short.trippedAtMs).toBeNull()
    // 99 found nothing used; the 1 found 99, over the 80 line.
    expect(short.warnedAtMs).toBe(at(2026, 11, 9, 2))
  })

  test("a request that would overshoot is still admitted: the gate looks at spend so far", () => {
    const result = simulateDraft(
      draft(),
      [row(at(2026, 11, 9, 1), 500), row(at(2026, 11, 9, 2), 1)],
      week,
    )
    expect(result.refusedNanoAiu).toBe(1)
    expect(result.admittedNanoAiu).toBe(500)
  })

  test("the period starts over at midnight UTC, to the millisecond", () => {
    const result = simulateDraft(
      draft(),
      [
        row(at(2026, 11, 9, 23, 59) + 59_999, 100),
        row(at(2026, 11, 10), 100),
        row(at(2026, 11, 10) + 1, 1),
      ],
      week,
    )
    // The second row is in a new period: admitted. The third finds it full.
    expect(result.refusedRequests).toBe(1)
    expect(result.refusedNanoAiu).toBe(1)
  })

  test("a limit of 0 refuses everything, free requests included", () => {
    const result = simulateDraft(
      draft({ limit: 0 }),
      [row(at(2026, 11, 9, 1), 0), row(at(2026, 11, 9, 2), 5)],
      week,
    )
    expect(result.refusedRequests).toBe(2)
    expect(result.admittedNanoAiu).toBe(0)
  })

  test("free requests are refused too once the limit is reached", () => {
    const result = simulateDraft(
      draft(),
      [row(at(2026, 11, 9, 1), 100), row(at(2026, 11, 9, 2), 0)],
      week,
    )
    expect(result.refusedRequests).toBe(1)
    expect(result.refusedNanoAiu).toBe(0)
  })
})

describe("a warn limit", () => {
  test("refuses nothing and counts everything, but still trips and warns", () => {
    const result = simulateDraft(
      draft({ action: "warn" }),
      [
        row(at(2026, 11, 9, 1), 90),
        row(at(2026, 11, 9, 2), 90),
        row(at(2026, 11, 9, 3), 90),
      ],
      week,
    )
    expect(result.refusedRequests).toBe(0)
    expect(result.refusedNanoAiu).toBe(0)
    expect(result.admittedNanoAiu).toBe(270)
    expect(result.warnedAtMs).toBe(at(2026, 11, 9, 2))
    expect(result.trippedAtMs).toBe(at(2026, 11, 9, 3))
  })
})

describe("refused requests are never billed", () => {
  test("they add nothing to a rolling window, so room returns as the real spend ages out", () => {
    const result = simulateDraft(
      draft({ limitReset: { every: { hours: 1 } } }),
      [
        row(at(2026, 11, 11, 1), 100),
        row(at(2026, 11, 11, 1) + 10 * MIN, 100),
        // The first 100 has aged out; the refused one never counted.
        row(at(2026, 11, 11, 1) + 61 * MIN, 100),
      ],
      context(at(2026, 11, 11), NOW),
    )
    expect(result.refusedRequests).toBe(1)
    expect(result.admittedNanoAiu).toBe(200)
  })

  test("and they add nothing to the period either", () => {
    const result = simulateDraft(
      draft({ limit: 100, warnAt: 1 }),
      [
        row(at(2026, 11, 9, 1), 100),
        row(at(2026, 11, 9, 2), 100),
        row(at(2026, 11, 9, 3), 100),
      ],
      week,
    )
    expect(result.refusedRequests).toBe(2)
    // What the scope spent is still what it spent.
    expect(result.periods[0].spendNanoAiu).toBe(300)
    expect(result.peakNanoAiu).toBe(300)
  })
})

describe("scope", () => {
  const rows = [
    row(at(2026, 11, 9, 1), 60, {
      key: "laptop",
      plugin: "images",
      provider: "copilot",
    }),
    row(at(2026, 11, 9, 2), 60, { key: "ci", provider: "openrouter" }),
    row(at(2026, 11, 9, 3), 60, { key: "laptop", provider: "copilot" }),
    row(at(2026, 11, 9, 4), 60, {
      key: "laptop",
      plugin: "images",
      provider: "copilot",
    }),
  ]

  test.each([
    [{ kind: "global" }, 4, 2],
    [{ kind: "key", id: "laptop" }, 3, 1],
    [{ kind: "key", id: "ci" }, 1, 0],
    [{ kind: "plugin", id: "images" }, 2, 0],
    [{ kind: "provider", id: "openrouter" }, 1, 0],
    [{ kind: "provider", id: "copilot" }, 3, 1],
    [{ kind: "key", id: "nobody" }, 0, 0],
  ] as const)(
    "%o: matches %i requests and refuses %i",
    (scope, matched, refused) => {
      const result = simulateDraft(draft({ scope, limit: 100 }), rows, week)
      expect(result.matchedRequests).toBe(matched)
      expect(result.refusedRequests).toBe(refused)
    },
  )

  test("what the scope doesn't cover never counts toward the limit", () => {
    const result = simulateDraft(
      draft({ scope: { kind: "key", id: "ci" }, limit: 50 }),
      [
        row(at(2026, 11, 9, 1), 1000, { key: "laptop" }),
        row(at(2026, 11, 9, 2), 10, { key: "ci" }),
      ],
      week,
    )
    expect(result.refusedRequests).toBe(0)
    expect(result.matchedNanoAiu).toBe(10)
  })
})

describe("the replay window", () => {
  test("spend from before the window, in the same period, counts toward the limit but isn't reported", () => {
    // A weekly limit; the week began Monday, the window starts Wednesday.
    const result = simulateDraft(
      draft({ limitReset: "weekly" }),
      [row(at(2026, 11, 9, 5), 100), row(at(2026, 11, 11, 13), 5)],
      context(at(2026, 11, 11), at(2026, 11, 12)),
    )
    expect(result.matchedRequests).toBe(1)
    expect(result.refusedRequests).toBe(1)
    expect(result.periods).toHaveLength(1)
    expect(result.periods[0].startMs).toBe(at(2026, 11, 9))
    // The period's own spend is its whole spend.
    expect(result.periods[0].spendNanoAiu).toBe(105)
  })

  test("rows from before the first period are not replayed into it", () => {
    const result = simulateDraft(
      draft(),
      [row(at(2026, 11, 10, 23), 100), row(at(2026, 11, 11, 1), 5)],
      context(at(2026, 11, 11), at(2026, 11, 12)),
    )
    expect(result.refusedRequests).toBe(0)
    expect(result.periods[0].spendNanoAiu).toBe(5)
  })

  test("rows after the window are not reported", () => {
    const result = simulateDraft(
      draft(),
      [row(at(2026, 11, 9, 1), 5), row(at(2026, 11, 12, 1), 5)],
      context(at(2026, 11, 9), at(2026, 11, 10)),
    )
    expect(result.matchedRequests).toBe(1)
  })

  test("a lifetime limit replays from the window's first row", () => {
    const result = simulateDraft(
      draft({ limitReset: "never", limit: 100 }),
      [row(at(2026, 11, 9, 1), 100), row(at(2026, 11, 15, 1), 1)],
      week,
    )
    expect(result.refusedRequests).toBe(1)
    expect(result.periods).toMatchObject([{ startMs: 0, endMs: null }])
  })
})

describe("rolling limits", () => {
  const rolling = draft({ limitReset: { every: { hours: 5 } }, limit: 100 })
  const from = at(2026, 11, 10)
  const to = at(2026, 11, 11)

  test("room returns exactly one window after the spend that filled it", () => {
    const start = at(2026, 11, 10, 6)
    const result = simulateDraft(
      rolling,
      [row(start, 100), row(start + 5 * HOUR - 1, 1), row(start + 5 * HOUR, 1)],
      context(from, to),
    )
    expect(result.refusedRequests).toBe(1)
    expect(result.trippedAtMs).toBe(start + 5 * HOUR - 1)
  })

  test("it reports no periods, and its peak is the busiest window", () => {
    const result = simulateDraft(
      rolling,
      [
        row(at(2026, 11, 10, 1), 30),
        row(at(2026, 11, 10, 3), 40),
        row(at(2026, 11, 10, 20), 10),
      ],
      context(from, to),
    )
    expect(result.mode).toBe("rolling")
    expect(result.periods).toEqual([])
    expect(result.periodsTotal).toBeNull()
    expect(result.periodsTripped).toBeNull()
    expect(result.periodsWarned).toBeNull()
    expect(result.peakNanoAiu).toBe(70)
    expect(result.peakAtMs).toBe(at(2026, 11, 10, 3))
  })

  test("spend from before the window, still inside it, counts", () => {
    const result = simulateDraft(
      rolling,
      [row(at(2026, 11, 9, 22), 100), row(at(2026, 11, 10, 1), 5)],
      context(from, to),
    )
    expect(result.matchedRequests).toBe(1)
    expect(result.refusedRequests).toBe(1)
  })

  test("the suggestion is the p90 of the window's spend sampled hourly", () => {
    // One burst of 100 each morning for ten days, otherwise nothing: the
    // window holds it for 5 of 24 hours.
    const rows = Array.from({ length: 10 }, (_, d) =>
      row(at(2026, 11, 1 + d, 8), 100),
    )
    const result = simulateDraft(
      draft({ limitReset: { every: { hours: 5 } }, limit: 1000 }),
      rows,
      context(at(2026, 11, 1), at(2026, 11, 11)),
    )
    // 50 of 240 samples are 100; the rest are 0. p90 = 100 (rank 216 of 240).
    expect(result.suggestedNanoAiu).toBe(100)
  })
})

describe("the suggested amount", () => {
  /** Day d (0..9) spends (d + 1) * 10, in ten equal requests. */
  const ramp = Array.from({ length: 10 }, (_, d) =>
    Array.from({ length: 10 }, (_, k) =>
      row(at(2026, 11, 1 + d, 1 + k), d + 1),
    ),
  ).flat()
  const ten = context(at(2026, 11, 1), at(2026, 11, 11))

  test("is the p90 of the period spend", () => {
    const result = simulateDraft(draft({ limit: 1 }), ramp, ten)
    // Spends 10, 20, ... 100: nearest rank 9 of 10 is 90.
    expect(result.suggestedNanoAiu).toBe(90)
  })

  test("a limit set to it would not have tripped most periods", () => {
    const result = simulateDraft(draft({ limit: 90 }), ramp, ten)
    expect(result.periodsTotal).toBe(10)
    expect(result.periodsTripped).toBe(1)
    expect(result.periods.at(-1)?.trippedAtMs).not.toBeNull()
    // Only the busiest day (100) found the limit already reached.
    expect(result.refusedRequests).toBe(1)
  })

  test("the period still open at the end of the window is left out when an earlier one is complete", () => {
    // Nov 11 is open at the window's end, and its spend so far (1000) would
    // pull the p90 up to 100 if it were counted.
    const result = simulateDraft(
      draft({ limit: 1 }),
      [...ramp, row(at(2026, 11, 11, 1), 1000)],
      context(at(2026, 11, 1), at(2026, 11, 11, 6)),
    )
    expect(result.suggestedNanoAiu).toBe(90)
    expect(result.periodsTotal).toBe(11)
  })

  test("with only an open period it uses that", () => {
    const result = simulateDraft(
      draft({ limit: 1 }),
      [row(at(2026, 11, 11, 1), 7)],
      context(at(2026, 11, 11), at(2026, 11, 11, 6)),
    )
    expect(result.suggestedNanoAiu).toBe(7)
  })

  test("quiet periods count as zero", () => {
    // Spend on one day of ten: p90 of nine zeros and a 100 is 0, so no
    // amount is suggested... the busy day is the 10th value, rank 9 is 0.
    const result = simulateDraft(
      draft({ limit: 1 }),
      [row(at(2026, 11, 5, 1), 100)],
      ten,
    )
    expect(result.suggestedNanoAiu).toBeNull()
    expect(result.peakNanoAiu).toBe(100)
  })

  test("is null when nothing was spent", () => {
    expect(simulateDraft(draft(), [], ten).suggestedNanoAiu).toBeNull()
    expect(
      simulateDraft(draft(), [row(at(2026, 11, 5, 1), 0)], ten)
        .suggestedNanoAiu,
    ).toBeNull()
  })

  test("a lifetime limit is sized to the lifetime spend", () => {
    const result = simulateDraft(
      draft({ limitReset: "never", limit: 1 }),
      ramp,
      ten,
    )
    expect(result.suggestedNanoAiu).toBe(550)
  })
})

describe("empty and degenerate input", () => {
  test("no rows: nothing happened", () => {
    const result = simulateDraft(draft(), [], week)
    expect(result).toMatchObject({
      matchedRequests: 0,
      refusedRequests: 0,
      warnedAtMs: null,
      trippedAtMs: null,
      peakNanoAiu: 0,
      peakAtMs: null,
      suggestedNanoAiu: null,
      periodsTripped: 0,
    })
  })
})

describe("periods other than daily", () => {
  test("weekly starts over on Monday 00:00 UTC", () => {
    const result = simulateDraft(
      draft({ limitReset: "weekly" }),
      [
        row(at(2026, 11, 8, 23), 100),
        row(at(2026, 11, 9, 0), 100),
        row(at(2026, 11, 9, 1), 1),
      ],
      context(at(2026, 11, 2), at(2026, 11, 16)),
    )
    // Sunday's 100 is last week's; Monday's 100 fills the new week.
    expect(result.refusedRequests).toBe(1)
    expect(result.refusedNanoAiu).toBe(1)
  })

  test("monthly starts over on its day", () => {
    const result = simulateDraft(
      draft({ limitReset: { monthly: { day: 15 } } }),
      [
        row(at(2026, 10, 14, 23), 100),
        row(at(2026, 10, 15, 0), 100),
        row(at(2026, 10, 20), 1),
        row(at(2026, 11, 15, 0), 1),
      ],
      context(at(2026, 10, 1), at(2026, 11, 16)),
    )
    expect(result.refusedRequests).toBe(1)
    expect(result.periods.map((p) => p.startMs)).toEqual([
      at(2026, 9, 15),
      at(2026, 10, 15),
      at(2026, 11, 15),
    ])
  })

  test("a followed window uses the provider's reset; earlier cycles are estimated", () => {
    const window = {
      resetsAt: "2026-12-01T00:00:00Z",
      previousResetsAt: "2026-11-01T00:00:00Z",
    }
    const result = simulateDraft(
      draft({ limitReset: { follow: "copilot:premium" } }),
      [row(at(2026, 11, 2), 100), row(at(2026, 11, 3), 1)],
      context(at(2026, 11, 1), NOW, { findWindow: () => window }),
    )
    expect(result.refusedRequests).toBe(1)
    expect(result.periods).toMatchObject([
      { startMs: at(2026, 11, 1), endMs: at(2026, 12, 1), estimated: false },
    ])
  })

  test("a followed window nobody reported falls back to daily, estimated", () => {
    const result = simulateDraft(
      draft({ limitReset: { follow: "copilot:premium" } }),
      [row(at(2026, 11, 10, 1), 100), row(at(2026, 11, 11, 1), 1)],
      context(at(2026, 11, 10), NOW),
    )
    expect(result.refusedRequests).toBe(0)
    expect(result.periods.every((p) => p.estimated)).toBe(true)
  })
})

describe("determinism", () => {
  test("the same input gives the same result, and the input is left alone", () => {
    const rows = Object.freeze([
      Object.freeze(row(at(2026, 11, 9, 1), 60)),
      Object.freeze(row(at(2026, 11, 9, 2), 60)),
      Object.freeze(row(at(2026, 11, 9, 3), 60)),
    ])
    const frozen = Object.freeze(draft())
    const first = simulateDraft(frozen, rows, week)
    const second = simulateDraft(frozen, rows, week)
    expect(second).toEqual(first)
  })

  test("local daylight saving changes nothing: periods are UTC days", () => {
    process.env.TZ = "America/New_York"
    // New York springs forward at 07:00 UTC on 2026-03-08.
    const result = simulateDraft(
      draft(),
      [
        row(at(2026, 3, 8, 6, 59), 100),
        row(at(2026, 3, 8, 7, 0), 1),
        row(at(2026, 3, 9, 0, 0), 1),
      ],
      context(at(2026, 3, 8), at(2026, 3, 10)),
    )
    expect(result.refusedRequests).toBe(1)
    expect(result.periods.map((p) => (p.endMs ?? 0) - p.startMs)).toEqual([
      DAY,
      DAY,
    ])
  })
})

describe("the edges of the window and of the first period", () => {
  test("a request exactly at the window's start is reported; exactly at its end is not", () => {
    const result = simulateDraft(
      draft(),
      [
        row(at(2026, 11, 9, 5) - 1, 1),
        row(at(2026, 11, 9, 5), 1),
        row(at(2026, 11, 9, 6), 1),
        row(at(2026, 11, 9, 6) + 1, 1),
      ],
      context(at(2026, 11, 9, 5), at(2026, 11, 9, 6)),
    )
    expect(result.matchedRequests).toBe(1)
  })

  test("a request exactly at the first period's start is replayed into it", () => {
    const result = simulateDraft(
      draft(),
      [row(at(2026, 11, 9), 100), row(at(2026, 11, 9, 1), 1)],
      context(at(2026, 11, 9), at(2026, 11, 10)),
    )
    expect(result.refusedRequests).toBe(1)
    expect(result.periods[0].spendNanoAiu).toBe(101)
  })

  test("it warns the moment the spend reaches the warning line, not after", () => {
    const result = simulateDraft(
      draft({ limit: 100, warnAt: 0.8 }),
      [row(at(2026, 11, 9, 1), 80), row(at(2026, 11, 9, 2), 1)],
      week,
    )
    expect(result.warnedAtMs).toBe(at(2026, 11, 9, 2))
    const under = simulateDraft(
      draft({ limit: 100, warnAt: 0.8 }),
      [row(at(2026, 11, 9, 1), 79), row(at(2026, 11, 9, 2), 1)],
      week,
    )
    expect(under.warnedAtMs).toBeNull()
  })

  test("a window with no periods in it reports nothing and doesn't fail", () => {
    const midnight = at(2026, 11, 9)
    const result = simulateDraft(
      draft(),
      [row(midnight - 1, 5)],
      context(midnight, midnight),
    )
    expect(result).toMatchObject({
      periods: [],
      periodsTotal: 0,
      matchedRequests: 0,
      suggestedNanoAiu: null,
    })
  })

  test("two equal peaks report the first", () => {
    const result = simulateDraft(
      draft({ limitReset: { every: { hours: 1 } }, limit: 1000 }),
      [row(at(2026, 11, 10, 1), 50), row(at(2026, 11, 10, 9), 50)],
      context(at(2026, 11, 10), at(2026, 11, 11)),
    )
    expect(result.peakNanoAiu).toBe(50)
    expect(result.peakAtMs).toBe(at(2026, 11, 10, 1))
  })
})

const span = (fromMs: number, toMs: number) => ({ fromMs, toMs })

describe("rollingSamples", () => {
  test("one sample per hour boundary: the window's spend at the end of each hour", () => {
    const samples = rollingSamples(
      [row(at(2026, 11, 10, 1, 30), 10)],
      2 * HOUR,
      span(at(2026, 11, 10), at(2026, 11, 10, 6)),
    )
    // The 10 counts through 03:29:59.999, so hours 01 and 02 end with it and
    // hour 03 doesn't.
    expect(samples).toEqual([0, 10, 10, 0, 0, 0])
  })

  test("a window that doesn't start on the hour begins with its own hour", () => {
    const samples = rollingSamples(
      [row(at(2026, 11, 10, 1, 45), 7)],
      HOUR,
      span(at(2026, 11, 10, 1, 30), at(2026, 11, 10, 4)),
    )
    expect(samples).toEqual([7, 0, 0])
  })

  test("a window ending mid-hour includes that partial hour", () => {
    expect(
      rollingSamples([], HOUR, span(at(2026, 11, 10), at(2026, 11, 10, 2, 30))),
    ).toHaveLength(3)
  })

  test("a window ending on the hour does not include the next one", () => {
    expect(
      rollingSamples([], HOUR, span(at(2026, 11, 10), at(2026, 11, 10, 2))),
    ).toHaveLength(2)
  })

  test("a request on an hour boundary belongs to the hour it starts", () => {
    const samples = rollingSamples(
      [row(at(2026, 11, 10, 2), 5)],
      10 * HOUR,
      span(at(2026, 11, 10), at(2026, 11, 10, 4)),
    )
    expect(samples).toEqual([0, 0, 5, 5])
  })

  test("spend from before the window counts while it is inside the window", () => {
    const samples = rollingSamples(
      [row(at(2026, 11, 9, 23), 9)],
      3 * HOUR,
      span(at(2026, 11, 10), at(2026, 11, 10, 4)),
    )
    // Counts through 01:59:59.999.
    expect(samples).toEqual([9, 9, 0, 0])
  })
})

describe("replayStartMs", () => {
  const mid = context(at(2026, 11, 11, 15), at(2026, 11, 12))

  test("a daily limit is read from the start of its first day", () => {
    expect(replayStartMs(draft(), mid)).toBe(at(2026, 11, 11))
  })

  test("a weekly limit is read from that Monday", () => {
    expect(replayStartMs(draft({ limitReset: "weekly" }), mid)).toBe(
      at(2026, 11, 9),
    )
  })

  test("a monthly limit is read from its day of the month", () => {
    expect(
      replayStartMs(draft({ limitReset: { monthly: { day: 5 } } }), mid),
    ).toBe(at(2026, 11, 5))
  })

  test("a rolling limit is read one window back", () => {
    expect(
      replayStartMs(draft({ limitReset: { every: { hours: 5 } } }), mid),
    ).toBe(at(2026, 11, 11, 15) - 5 * HOUR)
    expect(
      replayStartMs(draft({ limitReset: { every: { days: 2 } } }), mid),
    ).toBe(at(2026, 11, 11, 15) - 2 * DAY)
  })

  test("a lifetime limit has no earlier history: the window's start", () => {
    expect(replayStartMs(draft({ limitReset: "never" }), mid)).toBe(
      at(2026, 11, 11, 15),
    )
  })

  test("a window that starts on a period's start is read from it", () => {
    expect(
      replayStartMs(draft(), context(at(2026, 11, 11), at(2026, 11, 12))),
    ).toBe(at(2026, 11, 11))
  })

  test("a followed window is read from its first (estimated) cycle's start", () => {
    const window = {
      resetsAt: "2026-12-01T00:00:00Z",
      previousResetsAt: "2026-11-01T00:00:00Z",
    }
    expect(
      replayStartMs(
        draft({ limitReset: { follow: "copilot:premium" } }),
        context(at(2026, 11, 11), NOW, { findWindow: () => window }),
      ),
    ).toBe(at(2026, 11, 1))
  })

  test("a window with no periods in it is read from its own start", () => {
    const midnight = at(2026, 11, 11)
    expect(replayStartMs(draft(), context(midnight, midnight))).toBe(midnight)
  })
})

describe("percentile", () => {
  test("nearest rank", () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(ten, 0.9)).toBe(9)
    expect(percentile(ten, 0.91)).toBe(10)
    expect(percentile(ten, 0.5)).toBe(5)
    expect(percentile(ten, 1)).toBe(10)
    expect(percentile(ten, 0)).toBe(1)
    expect(percentile([7], 0.9)).toBe(7)
    expect(percentile([], 0.9)).toBeUndefined()
  })
})
