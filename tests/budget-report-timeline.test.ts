/**
 * Bucket math and the pure timeline: UTC boundaries (daylight-saving changes
 * never move one), cumulative spend per period, a bucket cut where a period
 * resets, the warning and limit crossings, and refusals.
 */

import { afterEach, describe, expect, test } from "bun:test"

import type { BudgetPeriod } from "~/lib/budget/periods"

import {
  bucketCount,
  bucketStart,
  defaultBucket,
  nextBucketStart,
} from "~/lib/budget/reports/buckets"
import {
  computeTimeline,
  periodsInRange,
  type TimelineInput,
} from "~/lib/budget/reports/timeline"

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

describe("bucket boundaries", () => {
  test("hours, days and weeks start at UTC boundaries; weeks on Monday", () => {
    const t = at(2026, 11, 11, 15, 42)
    expect(bucketStart("hour", t)).toBe(at(2026, 11, 11, 15))
    expect(bucketStart("day", t)).toBe(at(2026, 11, 11))
    expect(bucketStart("week", t)).toBe(at(2026, 11, 9))
    // Sunday belongs to the week that began the Monday before.
    expect(bucketStart("week", at(2026, 11, 8, 23, 59))).toBe(at(2026, 11, 2))
  })

  test("a boundary instant starts its own bucket", () => {
    expect(bucketStart("hour", at(2026, 11, 11, 15))).toBe(at(2026, 11, 11, 15))
    expect(bucketStart("day", at(2026, 11, 11))).toBe(at(2026, 11, 11))
    expect(bucketStart("week", at(2026, 11, 9))).toBe(at(2026, 11, 9))
    expect(bucketStart("day", at(2026, 11, 11) - 1)).toBe(at(2026, 11, 10))
  })

  // 2026-03-08 and 2026-11-01 change the clock in New York; 2026-03-29 and
  // 2026-10-25 in Europe. A bucket is still exactly one UTC day.
  test.each([
    ["America/New_York", at(2026, 3, 6), at(2026, 3, 11)],
    ["America/New_York", at(2026, 10, 30), at(2026, 11, 4)],
    ["Europe/Berlin", at(2026, 3, 27), at(2026, 4, 1)],
    ["Europe/Berlin", at(2026, 10, 23), at(2026, 10, 28)],
    ["Australia/Lord_Howe", at(2026, 4, 3), at(2026, 4, 8)],
  ])("%s: days stay 24 h across a clock change", (zone, from, to) => {
    process.env.TZ = zone
    const starts: Array<number> = []
    for (
      let t = bucketStart("day", from);
      t < to;
      t = nextBucketStart("day", t)
    ) {
      starts.push(t)
    }
    expect(starts).toHaveLength(5)
    for (const [index, start] of starts.entries()) {
      expect(start % DAY).toBe(0)
      if (index > 0) expect(start - starts[index - 1]).toBe(DAY)
      expect(bucketStart("day", start + 12 * HOUR)).toBe(start)
    }
  })

  test("hours stay 1 h and weeks 7 d across a clock change", () => {
    process.env.TZ = "America/New_York"
    const hour = bucketStart("hour", at(2026, 3, 8, 7, 30))
    expect(nextBucketStart("hour", hour) - hour).toBe(HOUR)
    const week = bucketStart("week", at(2026, 3, 8, 12))
    expect(week).toBe(at(2026, 3, 2))
    expect(nextBucketStart("week", week)).toBe(at(2026, 3, 9))
    // A week that contains the change is still 168 hours of UTC.
    expect(nextBucketStart("week", week) - week).toBe(7 * DAY)
  })

  test("the next bucket of the last hour of a day is midnight", () => {
    expect(nextBucketStart("hour", at(2026, 11, 11, 23))).toBe(at(2026, 11, 12))
  })

  test("bucketCount counts partial buckets at either end", () => {
    expect(bucketCount("day", at(2026, 11, 4, 12), NOW + 1)).toBe(8)
    expect(
      bucketCount("hour", at(2026, 11, 11, 10, 30), at(2026, 11, 11, 12)),
    ).toBe(2)
    expect(bucketCount("day", NOW, NOW)).toBe(1)
    expect(bucketCount("day", NOW, NOW - DAY * 3)).toBe(0)
  })

  test("the default bucket follows the span's length", () => {
    expect(defaultBucket(DAY)).toBe("hour")
    expect(defaultBucket(2 * DAY)).toBe("hour")
    expect(defaultBucket(2 * DAY + 1)).toBe("day")
    expect(defaultBucket(30 * DAY)).toBe("day")
    expect(defaultBucket(120 * DAY)).toBe("day")
    expect(defaultBucket(120 * DAY + 1)).toBe("week")
  })
})

const none = () => undefined

describe("periodsInRange", () => {
  test("daily steps UTC midnights and covers the range", () => {
    const periods = periodsInRange("daily", none, {
      fromMs: at(2026, 11, 9, 5),
      toMs: at(2026, 11, 11, 1),
      nowMs: NOW,
    })
    expect(periods.map((p) => p.startMs)).toEqual([
      at(2026, 11, 9),
      at(2026, 11, 10),
      at(2026, 11, 11),
    ])
    expect(periods.every((p) => !p.estimated && p.basis === "fixed")).toBe(true)
  })

  test("weekly steps Mondays, across the clock change in New York", () => {
    process.env.TZ = "America/New_York"
    const periods = periodsInRange("weekly", none, {
      fromMs: at(2026, 3, 1),
      toMs: at(2026, 3, 20),
      nowMs: NOW,
    })
    expect(periods.map((p) => p.startMs)).toEqual([
      at(2026, 2, 23),
      at(2026, 3, 2),
      at(2026, 3, 9),
      at(2026, 3, 16),
    ])
  })

  test("never is one lifetime period", () => {
    const periods = periodsInRange("never", none, {
      fromMs: at(2026, 1, 1),
      toMs: NOW,
      nowMs: NOW,
    })
    expect(periods).toEqual([
      { startMs: 0, endMs: null, basis: "fixed", estimated: false },
    ])
  })

  test("a followed window's current period is exact; earlier cycles are estimated", () => {
    const window = {
      resetsAt: "2026-12-01T00:00:00Z",
      previousResetsAt: "2026-11-01T00:00:00Z",
    }
    const periods = periodsInRange(
      { follow: "copilot:premium_interactions" },
      () => window,
      { fromMs: at(2026, 9, 28), toMs: NOW, nowMs: NOW },
    )
    expect(periods.map((p) => [p.startMs, p.endMs, p.estimated])).toEqual([
      [at(2026, 11, 1) - 60 * DAY, at(2026, 11, 1) - 30 * DAY, true],
      [at(2026, 11, 1) - 30 * DAY, at(2026, 11, 1), true],
      [at(2026, 11, 1), at(2026, 12, 1), false],
    ])
  })

  test("a followed window that fell back to daily steps days, marked estimated", () => {
    const periods = periodsInRange({ follow: "copilot:x" }, none, {
      fromMs: at(2026, 11, 10),
      toMs: at(2026, 11, 12),
      nowMs: NOW,
    })
    expect(periods).toHaveLength(2)
    expect(periods.every((p) => p.basis === "fallback" && p.estimated)).toBe(
      true,
    )
    expect(periods[0].endMs).toBe(at(2026, 11, 11))
  })
})

const daily = (startDay: number, days: number): Array<BudgetPeriod> =>
  Array.from({ length: days }, (_, k) => ({
    startMs: at(2026, 11, startDay + k),
    endMs: at(2026, 11, startDay + k + 1),
    basis: "fixed" as const,
    estimated: false,
  }))

function input(overrides: Partial<TimelineInput>): TimelineInput {
  return {
    limitNanoAiu: 100,
    warnAt: 0.8,
    bucket: "day",
    fromMs: at(2026, 11, 9),
    toMs: at(2026, 11, 12),
    periods: daily(9, 3),
    rows: [],
    refusals: [],
    ...overrides,
  }
}

describe("computeTimeline", () => {
  test("daily limit: cumulative spend resets each day; warning and limit crossings are timed", () => {
    const timeline = computeTimeline(
      input({
        rows: [
          { createdAtMs: at(2026, 11, 9, 10), nanoAiu: 50 },
          { createdAtMs: at(2026, 11, 9, 15), nanoAiu: 40 },
          { createdAtMs: at(2026, 11, 10, 9), nanoAiu: 60 },
          { createdAtMs: at(2026, 11, 10, 10), nanoAiu: 50 },
        ],
      }),
    )

    expect(timeline.warnLineNanoAiu).toBe(80)
    expect(
      timeline.buckets.map((b) => [b.nanoAiu, b.requests, b.cumulativeNanoAiu]),
    ).toEqual([
      [90, 2, 90],
      [110, 2, 110],
      [0, 0, 0],
    ])
    expect(timeline.periods.map((p) => [p.warnedAtMs, p.crossedAtMs])).toEqual([
      [at(2026, 11, 9, 15), null],
      [at(2026, 11, 10, 10), at(2026, 11, 10, 10)],
      [null, null],
    ])
    expect(timeline.markers.map((m) => [m.kind, m.atMs])).toEqual([
      ["warned", at(2026, 11, 9, 15)],
      ["warned", at(2026, 11, 10, 10)],
      ["crossed", at(2026, 11, 10, 10)],
    ])
  })

  test("reaching the limit exactly is crossing it; one short is not", () => {
    const exact = computeTimeline(
      input({ rows: [{ createdAtMs: at(2026, 11, 9, 1), nanoAiu: 100 }] }),
    )
    expect(exact.periods[0].crossedAtMs).toBe(at(2026, 11, 9, 1))
    const short = computeTimeline(
      input({ rows: [{ createdAtMs: at(2026, 11, 9, 1), nanoAiu: 99 }] }),
    )
    expect(short.periods[0].crossedAtMs).toBeNull()
    expect(short.periods[0].warnedAtMs).toBe(at(2026, 11, 9, 1))
  })

  test("the warning line rounds up, so a spend below it is not a warning", () => {
    // 0.8 * 33 = 26.4: 26 is under the line, 27 is over.
    const base = { limitNanoAiu: 33 }
    const under = computeTimeline(
      input({
        ...base,
        rows: [{ createdAtMs: at(2026, 11, 9, 1), nanoAiu: 26 }],
      }),
    )
    expect(under.warnLineNanoAiu).toBe(27)
    expect(under.periods[0].warnedAtMs).toBeNull()
    const over = computeTimeline(
      input({
        ...base,
        rows: [{ createdAtMs: at(2026, 11, 9, 1), nanoAiu: 27 }],
      }),
    )
    expect(over.periods[0].warnedAtMs).toBe(at(2026, 11, 9, 1))
  })

  test("weekly limit with day buckets: cumulative runs through the week and restarts on Monday", () => {
    const periods: Array<BudgetPeriod> = [
      {
        startMs: at(2026, 11, 2),
        endMs: at(2026, 11, 9),
        basis: "fixed",
        estimated: false,
      },
      {
        startMs: at(2026, 11, 9),
        endMs: at(2026, 11, 16),
        basis: "fixed",
        estimated: false,
      },
    ]
    const timeline = computeTimeline(
      input({
        fromMs: at(2026, 11, 7),
        toMs: at(2026, 11, 11, 12),
        periods,
        rows: [
          { createdAtMs: at(2026, 11, 7, 10), nanoAiu: 10 },
          { createdAtMs: at(2026, 11, 8, 10), nanoAiu: 20 },
          { createdAtMs: at(2026, 11, 9, 10), nanoAiu: 5 },
          { createdAtMs: at(2026, 11, 10, 10), nanoAiu: 5 },
        ],
      }),
    )
    expect(timeline.buckets.map((b) => b.cumulativeNanoAiu)).toEqual([
      10, 30, 5, 10, 10,
    ])
    expect(timeline.buckets.map((b) => b.periodStartMs)).toEqual([
      at(2026, 11, 2),
      at(2026, 11, 2),
      at(2026, 11, 9),
      at(2026, 11, 9),
      at(2026, 11, 9),
    ])
    expect(timeline.periods.map((p) => p.spendNanoAiu)).toEqual([30, 10])
  })

  test("a bucket is cut where a period resets mid-bucket", () => {
    // A followed window that resets at 14:30 UTC.
    const periods: Array<BudgetPeriod> = [
      {
        startMs: at(2026, 11, 10, 14, 30) - DAY,
        endMs: at(2026, 11, 10, 14, 30),
        basis: "provider",
        estimated: false,
      },
      {
        startMs: at(2026, 11, 10, 14, 30),
        endMs: at(2026, 11, 11, 14, 30),
        basis: "provider",
        estimated: false,
      },
    ]
    const timeline = computeTimeline(
      input({
        bucket: "hour",
        fromMs: at(2026, 11, 10, 14),
        toMs: at(2026, 11, 10, 16),
        periods,
        rows: [
          { createdAtMs: at(2026, 11, 10, 14, 10), nanoAiu: 10 },
          { createdAtMs: at(2026, 11, 10, 14, 40), nanoAiu: 20 },
          { createdAtMs: at(2026, 11, 10, 15, 5), nanoAiu: 1 },
        ],
      }),
    )
    expect(
      timeline.buckets.map((b) => [
        b.startMs,
        b.endMs,
        b.nanoAiu,
        b.cumulativeNanoAiu,
      ]),
    ).toEqual([
      [at(2026, 11, 10, 14), at(2026, 11, 10, 14, 30), 10, 10],
      [at(2026, 11, 10, 14, 30), at(2026, 11, 10, 15), 20, 20],
      [at(2026, 11, 10, 15), at(2026, 11, 10, 16), 1, 21],
    ])
  })
})

describe("computeTimeline, resets and earlier spend", () => {
  test("a row exactly on a period's reset belongs to the new period", () => {
    const timeline = computeTimeline(
      input({ rows: [{ createdAtMs: at(2026, 11, 10), nanoAiu: 7 }] }),
    )
    expect(timeline.buckets.map((b) => b.nanoAiu)).toEqual([0, 7, 0])
    expect(timeline.buckets[1].cumulativeNanoAiu).toBe(7)
  })

  test("rows from before the range, in the first period, count toward it", () => {
    const timeline = computeTimeline(
      input({
        limitNanoAiu: 100,
        fromMs: at(2026, 11, 10),
        toMs: at(2026, 11, 12),
        periods: [
          {
            startMs: at(2026, 11, 9),
            endMs: at(2026, 11, 16),
            basis: "fixed",
            estimated: false,
          },
        ],
        rows: [
          { createdAtMs: at(2026, 11, 9, 8), nanoAiu: 70 },
          { createdAtMs: at(2026, 11, 10, 12), nanoAiu: 20 },
        ],
      }),
    )
    expect(
      timeline.buckets.map((b) => [b.nanoAiu, b.cumulativeNanoAiu]),
    ).toEqual([
      [20, 90],
      [0, 90],
    ])
    expect(timeline.periods[0].warnedAtMs).toBe(at(2026, 11, 10, 12))
    expect(timeline.buckets[0].requests).toBe(1)
  })

  test("a baseline already past a line opens the range with it crossed", () => {
    const never: Array<BudgetPeriod> = [
      { startMs: 0, endMs: null, basis: "fixed", estimated: false },
    ]
    const warned = computeTimeline(
      input({
        periods: never,
        baselineNanoAiu: 90,
        rows: [{ createdAtMs: at(2026, 11, 9, 5), nanoAiu: 5 }],
      }),
    )
    expect(warned.periods[0].warnedAtMs).toBe(at(2026, 11, 9))
    expect(warned.periods[0].crossedAtMs).toBeNull()
    expect(warned.buckets.map((b) => b.cumulativeNanoAiu)).toEqual([95, 95, 95])

    const crossed = computeTimeline(
      input({ periods: never, baselineNanoAiu: 100 }),
    )
    expect(crossed.periods[0].crossedAtMs).toBe(at(2026, 11, 9))
    expect(crossed.markers.map((m) => m.kind)).toEqual(["warned", "crossed"])
  })

  test("refusals land in their bucket and period, one marker per bucket", () => {
    const timeline = computeTimeline(
      input({
        refusals: [
          { atMs: at(2026, 11, 9, 20), estimateNanoAiu: 5 },
          { atMs: at(2026, 11, 9, 21), estimateNanoAiu: 0 },
          { atMs: at(2026, 11, 11, 1), estimateNanoAiu: 7 },
          // Outside the range: ignored.
          { atMs: at(2026, 11, 12, 1), estimateNanoAiu: 99 },
        ],
      }),
    )
    expect(timeline.buckets.map((b) => b.refused)).toEqual([2, 0, 1])
    expect(timeline.periods.map((p) => p.refused)).toEqual([2, 0, 1])
    expect(timeline.markers).toEqual([
      {
        kind: "refused",
        atMs: at(2026, 11, 9, 20),
        periodStartMs: at(2026, 11, 9),
        count: 2,
        estimateNanoAiu: 5,
      },
      {
        kind: "refused",
        atMs: at(2026, 11, 11, 1),
        periodStartMs: at(2026, 11, 11),
        count: 1,
        estimateNanoAiu: 7,
      },
    ])
  })
})

describe("computeTimeline, edge cases", () => {
  test("a limit of 0 is crossed from the start of the range", () => {
    const timeline = computeTimeline(input({ limitNanoAiu: 0 }))
    expect(timeline.periods[0].crossedAtMs).toBe(at(2026, 11, 9))
    expect(timeline.warnLineNanoAiu).toBe(0)
  })

  test("no rows: empty buckets, nothing crossed", () => {
    const timeline = computeTimeline(input({}))
    expect(timeline.buckets).toHaveLength(3)
    expect(
      timeline.buckets.every((b) => b.nanoAiu === 0 && b.requests === 0),
    ).toBe(true)
    expect(timeline.markers).toEqual([])
  })

  test("a range that starts mid-bucket is aligned to the bucket's start", () => {
    const timeline = computeTimeline(
      input({
        fromMs: at(2026, 11, 9, 17),
        toMs: at(2026, 11, 9, 19),
        bucket: "hour",
      }),
    )
    expect(timeline.buckets.map((b) => b.startMs)).toEqual([
      at(2026, 11, 9, 17),
      at(2026, 11, 9, 18),
    ])
  })

  test("DST: a New York spring-forward day is one 24 h UTC bucket with its spend", () => {
    process.env.TZ = "America/New_York"
    const timeline = computeTimeline(
      input({
        fromMs: at(2026, 3, 7),
        toMs: at(2026, 3, 10),
        periods: Array.from({ length: 3 }, (_, k) => ({
          startMs: at(2026, 3, 7 + k),
          endMs: at(2026, 3, 8 + k),
          basis: "fixed" as const,
          estimated: false,
        })),
        rows: [
          { createdAtMs: at(2026, 3, 8, 6, 59), nanoAiu: 1 },
          { createdAtMs: at(2026, 3, 8, 7, 0), nanoAiu: 2 },
          { createdAtMs: at(2026, 3, 9, 3, 59), nanoAiu: 4 },
        ],
      }),
    )
    expect(timeline.buckets.map((b) => b.endMs - b.startMs)).toEqual([
      DAY,
      DAY,
      DAY,
    ])
    expect(timeline.buckets.map((b) => b.nanoAiu)).toEqual([0, 3, 4])
  })
})
