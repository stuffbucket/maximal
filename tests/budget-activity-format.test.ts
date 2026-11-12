import { describe, expect, test } from "bun:test"

import {
  ACTIVITY_GROUPS,
  type ActivityRow,
  activityQuery,
  activityTotals,
  csvFileName,
  formatCompact,
  formatHourKey,
  formatSpan,
  isTimeGroup,
  rowFigures,
  timeSeries,
} from "../shell/src/ui/features/budget/format"
import {
  customSpan,
  isRangeReady,
  rangeBody,
  rangeChoice,
} from "../shell/src/ui/features/budget/range"

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)

function row(key: string, nano: number): ActivityRow {
  return { key, nano_aiu: nano, requests: 1, amount: nano / 1e9 }
}

function rowWith(key: string, extra: Partial<ActivityRow> = {}): ActivityRow {
  return { key, nano_aiu: 1_000_000_000, requests: 2, amount: 0.01, ...extra }
}

describe("activity range and query", () => {
  test("the activity and CSV endpoints share a query, and the export names its file", () => {
    const week = rangeChoice("7d", NOW)
    expect(activityQuery(week, "model")).toBe(
      "range=7d&group=model&include_free=true",
    )
    expect(csvFileName(week, "model")).toBe("maximal-activity-7d-by-model.csv")
    expect(csvFileName(rangeChoice("all", NOW), "hour")).toBe(
      "maximal-activity-all-by-hour.csv",
    )
    const custom = {
      range: "custom" as const,
      from: "2026-11-01",
      to: "2026-11-08",
    }
    expect(activityQuery(custom, "day")).toBe(
      "from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-09T00%3A00%3A00.000Z&group=day&include_free=true",
    )
    expect(csvFileName(custom, "day")).toBe(
      "maximal-activity-2026-11-01_to_2026-11-08-by-day.csv",
    )
  })

  test("a custom range that is not two days in order asks for nothing", () => {
    const base = {
      range: "custom" as const,
      from: "2026-11-01",
      to: "2026-11-08",
    }
    expect(activityQuery({ ...base, to: "" }, "model")).toBeNull()
    expect(activityQuery({ ...base, from: "" }, "model")).toBeNull()
    expect(activityQuery({ ...base, from: "2026-11-09" }, "model")).toBeNull()
    expect(isRangeReady({ ...base, from: "2026-11-09" })).toBe(false)
    // One day is a range: it runs through the end of that day.
    expect(customSpan({ from: "2026-11-01", to: "2026-11-01" })).toEqual({
      fromMs: Date.UTC(2026, 10, 1),
      toMs: Date.UTC(2026, 10, 2),
    })
    // A preset never needs the custom days.
    expect(isRangeReady({ range: "30d", from: "", to: "" })).toBe(true)
  })

  test("the report bodies name a range as the API reads it", () => {
    expect(rangeBody(rangeChoice("30d", NOW))).toBe("30d")
    expect(
      rangeBody({ range: "custom", from: "2026-11-01", to: "2026-11-01" }),
    ).toEqual({
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-02T00:00:00.000Z",
    })
    expect(rangeBody({ range: "custom", from: "", to: "" })).toBeNull()
  })

  test("Custom opens on the last week, ending today", () => {
    expect(rangeChoice("custom", NOW)).toEqual({
      range: "custom",
      from: "2026-11-05",
      to: "2026-11-11",
    })
  })
})

describe("activity measures", () => {
  test("a row reads the Dashboard's measures, and zero tokens from an older server", () => {
    expect(
      rowFigures(
        rowWith("m", {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 7,
          total_tokens: 122,
        }),
      ),
    ).toEqual({
      requests: 2,
      input: 10,
      output: 5,
      cacheRead: 100,
      cacheWrite: 7,
      total: 122,
    })
    expect(rowFigures(rowWith("m"))).toEqual({
      requests: 2,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    })
  })

  test("the totals are the response's own, else the sum of the rows", () => {
    const rows = [
      rowWith("a", { input_tokens: 10, total_tokens: 10 }),
      rowWith("b", { input_tokens: 5, total_tokens: 5 }),
    ]
    expect(activityTotals({ rows }).total).toBe(15)
    expect(activityTotals({ rows }).nanoAiu).toBe(2_000_000_000)
    expect(
      activityTotals({
        rows,
        totals: {
          request_count: 9,
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
          total_tokens: 10,
          total_nano_aiu: 5,
        },
      }),
    ).toEqual({
      requests: 9,
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      total: 10,
      nanoAiu: 5,
    })
  })

  test("counts read short in a table cell", () => {
    expect(formatCompact(812, "en")).toBe("812")
    expect(formatCompact(1_234_567, "en")).toBe("1.2M")
    expect(formatCompact(345_000, "en")).toBe("345K")
  })

  test("a day or hour reads in UTC, a span reads as days or hours", () => {
    expect(formatHourKey("2026-11-11T14:00:00Z", "en")).toMatch(
      /^Nov 11.* 2 PM$/,
    )
    expect(formatHourKey("garbage", "en")).toBe("garbage")
    // Longer than two days: the days, ending on the last one included.
    expect(
      formatSpan("2026-11-04T00:00:00Z", "2026-11-12T00:00:00Z", "en"),
    ).toBe("Nov 4 – Nov 11")
    // Two days or less: the hours too.
    expect(
      formatSpan("2026-11-10T14:00:00Z", "2026-11-11T14:00:00Z", "en"),
    ).toMatch(/^Nov 10.* 2:00 PM – Nov 11.* 2:00 PM$/)
  })

  test("time groups are the groups drawn as columns", () => {
    expect(ACTIVITY_GROUPS).toContain("hour")
    expect(isTimeGroup("hour")).toBe(true)
    expect(isTimeGroup("day")).toBe(true)
    expect(isTimeGroup("model")).toBe(false)
  })

  test("quiet days and hours are filled in at their place on the axis", () => {
    const days = timeSeries(
      [row("2026-11-09", 100), row("2026-11-12", 50)],
      "day",
    )
    expect(days.map((d) => d.key)).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
    ])
    expect(days.map((d) => d.nano_aiu)).toEqual([100, 0, 0, 50])
    // The range, not the first and last row, sets the ends of a named range.
    const hours = timeSeries([row("2026-11-11T13:00:00Z", 10)], "hour", {
      from: "2026-11-11T11:30:00.000Z",
      to: "2026-11-11T15:00:00.000Z",
      label: "24h",
    })
    expect(hours.map((h) => h.key)).toEqual([
      "2026-11-11T11:00:00Z",
      "2026-11-11T12:00:00Z",
      "2026-11-11T13:00:00Z",
      "2026-11-11T14:00:00Z",
    ])
    // "all" starts at the epoch, which is no span to draw: it runs from the first row.
    const all = timeSeries(
      [row("2026-11-10", 1), row("2026-11-11", 1)],
      "day",
      {
        from: "1970-01-01T00:00:00.000Z",
        to: "2026-11-11T12:00:00.000Z",
        label: "all",
      },
    )
    expect(all).toHaveLength(2)
    expect(timeSeries([], "day")).toEqual([])
  })
})
