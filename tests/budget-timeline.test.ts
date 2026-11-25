import { describe, expect, test } from "bun:test"

import type { BudgetTimelineResponse } from "../src/lib/config/settings-types"

import {
  chartModel,
  markerCounts,
  periodRows,
  sparkPoints,
  sparkValues,
  timelineHasActivity,
  timelinePath,
} from "../shell/src/ui/features/budget/timeline"

const FROM = Date.UTC(2026, 10, 9)
const DAY = 86_400_000
const iso = (ms: number): string => new Date(ms).toISOString()

function bucket(
  day: number,
  [nano, cumulative]: [number, number],
  { period = 0, refused = 0 }: { period?: number; refused?: number } = {},
): BudgetTimelineResponse["buckets"][number] {
  return {
    start: iso(FROM + day * DAY),
    end: iso(FROM + (day + 1) * DAY),
    nano_aiu: nano,
    requests: nano > 0 ? 2 : 0,
    cumulative_nano_aiu: cumulative,
    refused,
    period_start: iso(FROM + period * DAY),
    amount: nano / 1e9,
    cumulative_amount: cumulative / 1e9,
  }
}

function timeline(
  overrides: Partial<BudgetTimelineResponse> = {},
): BudgetTimelineResponse {
  return {
    limit: {
      id: "daily",
      label: null,
      scope: { kind: "global" },
      action: "block",
      limit_reset: "daily",
      warn_at: 0.8,
      limit: 100,
      warn_line: 80,
      display: { limit: 100 / 1e9, warn_line: 80 / 1e9 },
    },
    display: { unit: "usd", credit_usd: 0.01 },
    range: {
      from: iso(FROM),
      to: iso(FROM + 4 * DAY),
      label: "custom",
      bucket: "day",
    },
    // Two daily periods of two days... each day its own period here.
    buckets: [
      bucket(0, [50, 50], { period: 0 }),
      bucket(1, [60, 60], { period: 1 }),
      bucket(2, [120, 100], { period: 2, refused: 3 }),
      bucket(3, [0, 0], { period: 3 }),
    ],
    periods: [0, 1, 2, 3].map((day) => ({
      start: iso(FROM + day * DAY),
      end: iso(FROM + (day + 1) * DAY),
      estimated: false,
      spend_nano_aiu: [50, 60, 100, 0][day] ?? 0,
      warned_at: day === 2 ? iso(FROM + 2 * DAY + 1000) : null,
      crossed_at: day === 2 ? iso(FROM + 2 * DAY + 2000) : null,
      refused: day === 2 ? 3 : 0,
    })),
    markers: [
      {
        kind: "warned",
        at: iso(FROM + 2 * DAY + 1000),
        period_start: iso(FROM + 2 * DAY),
      },
      {
        kind: "crossed",
        at: iso(FROM + 2 * DAY + 2000),
        period_start: iso(FROM + 2 * DAY),
      },
      {
        kind: "refused",
        at: iso(FROM + 2 * DAY + 3000),
        period_start: iso(FROM + 2 * DAY),
        count: 3,
        estimate_nano_aiu: 20,
      },
    ],
    totals: {
      nano_aiu: 230,
      requests: 6,
      refused: 3,
      refused_estimate_nano_aiu: 20,
      periods_crossed: 1,
    },
    ...overrides,
  }
}

describe("the timeline's chart model", () => {
  test("each period is its own run, starting where its first bucket began", () => {
    const model = chartModel(timeline())
    // The line starts over where a period resets, so four daily periods are four runs.
    expect(model.runs).toHaveLength(4)
    expect(model.runs[0].points[0]).toEqual([0, 0])
    // The run for day 3 ends at 100 of a top a tenth above the limit.
    const top = 100 * 1.1
    expect(model.runs[2].points.at(-1)?.[1]).toBeCloseTo(100 / top)
    expect(model.runs[2].points.at(-1)?.[0]).toBeCloseTo(0.75)
  })

  test("a period's buckets chain into one run, carrying what the period had spent", () => {
    const model = chartModel(
      timeline({
        buckets: [
          bucket(0, [30, 30], { period: 0 }),
          bucket(1, [40, 70], { period: 0 }),
        ],
        periods: [],
        markers: [],
      }),
    )
    expect(model.runs).toHaveLength(1)
    // Start, end of the first bucket, end of the second.
    expect(model.runs[0]?.points).toHaveLength(3)
    const [start, mid, end] = model.runs[0].points
    expect(start[1]).toBe(0)
    expect(mid[1]).toBeCloseTo(30 / 110)
    expect(end[1]).toBeCloseTo(70 / 110)
  })

  test("the limit and warning lines sit at their share of the scale", () => {
    const model = chartModel(timeline())
    expect(model.limitY).toBeCloseTo(100 / 110)
    expect(model.warnY).toBeCloseTo(80 / 110)
  })

  test("a run past the limit makes the scale taller so it stays on the chart", () => {
    const model = chartModel(
      timeline({
        buckets: [bucket(0, [500, 500], { period: 0 })],
        periods: [],
        markers: [],
      }),
    )
    expect(model.limitY).toBeLessThan(0.25)
    expect(model.runs[0]?.points.at(-1)?.[1]).toBeLessThanOrEqual(1)
    expect(model.peakNanoAiu).toBe(500)
  })

  test("warned sits on the warning line, crossed and refused on the limit", () => {
    const model = chartModel(timeline())
    const byKind = Object.fromEntries(
      model.markers.map((marker) => [marker.kind, marker]),
    )
    expect(byKind.warned.y).toBe(model.warnY)
    expect(byKind.crossed.y).toBe(model.limitY)
    expect(byKind.refused.y).toBe(model.limitY)
    expect(byKind.refused.count).toBe(3)
    expect(byKind.refused.estimateNanoAiu).toBe(20)
    expect(byKind.crossed.count).toBe(1)
    // 2 days and a second into a 4 day range.
    expect(byKind.warned.x).toBeCloseTo(0.5, 3)
  })

  test("boundaries are where a period begins inside the range, not at its edge", () => {
    const model = chartModel(timeline())
    expect(model.boundaries).toEqual([0.25, 0.5, 0.75])
  })

  test("columns are as tall as their share of the busiest bucket", () => {
    const model = chartModel(timeline())
    expect(model.columns.map((c) => c.height)).toEqual([50 / 120, 0.5, 1, 0])
    expect(model.busiest).toBe(2)
    expect(model.columns[0].x0).toBe(0)
    expect(model.columns[3].x1).toBe(1)
  })

  test("nothing spent: no busiest column and a scale that still holds the limit", () => {
    const model = chartModel(
      timeline({
        buckets: [bucket(0, [0, 0], { period: 0 })],
        periods: [],
        markers: [],
        totals: {
          nano_aiu: 0,
          requests: 0,
          refused: 0,
          refused_estimate_nano_aiu: 0,
          periods_crossed: 0,
        },
      }),
    )
    expect(model.busiest).toBe(-1)
    expect(model.limitY).toBeCloseTo(100 / 110)
  })

  test("an empty range does not divide by zero", () => {
    const model = chartModel(
      timeline({
        range: {
          from: iso(FROM),
          to: iso(FROM),
          label: "custom",
          bucket: "day",
        },
        buckets: [],
        periods: [],
        markers: [],
      }),
    )
    expect(model.runs).toEqual([])
    expect(model.columns).toEqual([])
  })
})

describe("what the timeline counts", () => {
  test("refused markers count requests, the others occurrences", () => {
    expect(markerCounts(timeline())).toEqual({
      warned: 1,
      crossed: 1,
      refused: 3,
    })
  })

  test("periods read newest first", () => {
    const rows = periodRows(timeline())
    expect(rows.map((row) => row.start)).toEqual(
      [3, 2, 1, 0].map((day) => iso(FROM + day * DAY)),
    )
    expect(rows[1].refused).toBe(3)
    expect(rows[1].crossedAt).not.toBeNull()
  })

  test("activity is spend, requests or a refusal", () => {
    expect(timelineHasActivity(timeline())).toBe(true)
    const none = {
      nano_aiu: 0,
      requests: 0,
      refused: 0,
      refused_estimate_nano_aiu: 0,
      periods_crossed: 0,
    }
    expect(timelineHasActivity(timeline({ totals: none }))).toBe(false)
    expect(
      timelineHasActivity(timeline({ totals: { ...none, refused: 1 } })),
    ).toBe(true)
  })
})

describe("the row sparkline", () => {
  test("values are a share of the busiest bucket; a quiet week is flat", () => {
    expect(sparkValues(timeline())).toEqual([50 / 120, 0.5, 1, 0])
    expect(
      sparkValues(
        timeline({ buckets: [bucket(0, [0, 0]), bucket(1, [0, 0])] }),
      ),
    ).toEqual([0, 0])
  })

  test("points run left to right, the busiest at the top", () => {
    const points = sparkPoints([0, 1, 0.5]).split(" ")
    expect(points).toEqual(["0.00,22.00", "50.00,2.00", "100.00,12.00"])
    expect(sparkPoints([])).toBe("")
    // One point sits at the left edge.
    expect(sparkPoints([1])).toBe("0.00,2.00")
  })
})

describe("the timeline request", () => {
  test("names the rule and the range, escaping the id", () => {
    expect(
      timelinePath("key-codex weekly", { range: "30d", from: "", to: "" }),
    ).toBe("/settings/api/budget/limits/key-codex%20weekly/timeline?range=30d")
    expect(
      timelinePath("a", {
        range: "custom",
        from: "2026-11-01",
        to: "2026-11-02",
      }),
    ).toBe(
      "/settings/api/budget/limits/a/timeline?from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-03T00%3A00%3A00.000Z",
    )
  })

  test("an incomplete custom range asks for nothing", () => {
    expect(
      timelinePath("a", { range: "custom", from: "", to: "2026-11-02" }),
    ).toBeNull()
  })
})
