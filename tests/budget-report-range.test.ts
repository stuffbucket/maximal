/**
 * The range the usage reports share: `from`/`to`, `range=` and the original
 * `period=`, resolved against a clock.
 */

import { describe, expect, test } from "bun:test"

import {
  namedRange,
  parseUsageRange,
  periodStartMs,
} from "~/lib/budget/reports/range"

const DAY = 86_400_000
/** Wednesday 2026-11-11 12:00 UTC. */
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)

function ok(
  query: Parameters<typeof parseUsageRange>[0],
  fallback = "day" as const,
) {
  const parsed = parseUsageRange(query, NOW, fallback)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.range
}

describe("trailing ranges", () => {
  test.each([
    ["24h", 1],
    ["7d", 7],
    ["30d", 30],
    ["90d", 90],
  ] as const)("%s reaches back that long and includes now", (name, days) => {
    expect(ok({ range: name })).toEqual({
      fromMs: NOW - days * DAY,
      toMs: NOW + 1,
      label: name,
    })
  })

  test("all starts at the epoch", () => {
    expect(ok({ range: "all" })).toEqual({
      fromMs: 0,
      toMs: NOW + 1,
      label: "all",
    })
  })
})

describe("period ranges (the original activity query)", () => {
  test("day starts at 00:00 UTC", () => {
    expect(ok({ period: "day" }).fromMs).toBe(Date.UTC(2026, 10, 11))
  })

  test("week starts on Monday, even when that is last month", () => {
    expect(ok({ period: "week" }).fromMs).toBe(Date.UTC(2026, 10, 9))
    expect(periodStartMs("week", Date.UTC(2026, 9, 1, 5))).toBe(
      Date.UTC(2026, 8, 28),
    )
  })

  test("month starts on the 1st, at 00:00 UTC", () => {
    expect(ok({ period: "month" })).toEqual({
      fromMs: Date.UTC(2026, 10, 1),
      toMs: NOW + 1,
      label: "month",
    })
    // Not the local month: a late evening on the 31st is still that month.
    expect(periodStartMs("month", Date.UTC(2026, 9, 31, 23, 59))).toBe(
      Date.UTC(2026, 9, 1),
    )
  })

  test("a period at 00:00 UTC sharp starts that very instant", () => {
    const midnight = Date.UTC(2026, 10, 9)
    expect(namedRange("week", midnight).fromMs).toBe(midnight)
  })
})

describe("custom ranges", () => {
  test("from and to are ISO instants, to exclusive", () => {
    expect(
      ok({ from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" }),
    ).toEqual({
      fromMs: Date.UTC(2026, 10, 1),
      toMs: Date.UTC(2026, 10, 2),
      label: "custom",
    })
  })

  test("a from alone runs to now", () => {
    expect(ok({ from: "2026-11-10" })).toEqual({
      fromMs: Date.UTC(2026, 10, 10),
      toMs: NOW + 1,
      label: "custom",
    })
  })

  test("offsets are honoured", () => {
    expect(
      ok({ from: "2026-11-10T00:00:00-05:00", to: "2026-11-11" }).fromMs,
    ).toBe(Date.UTC(2026, 10, 10, 5))
  })

  test.each([
    ["a to without a from", { to: "2026-11-02" }],
    ["a from that isn't a date", { from: "yesterday" }],
    ["a to that isn't a date", { from: "2026-11-01", to: "soon" }],
    ["a from after the to", { from: "2026-11-03", to: "2026-11-02" }],
    ["an empty range", { from: "2026-11-02", to: "2026-11-02" }],
    ["a from past now with no to", { from: "2026-11-12" }],
    ["from with range", { from: "2026-11-01", range: "7d" }],
    ["to with range", { to: "2026-11-01", range: "7d" }],
  ])("rejects %s", (_name, query) => {
    expect(parseUsageRange(query, NOW, "day").ok).toBe(false)
  })
})

describe("which form wins", () => {
  test("range beats period", () => {
    expect(ok({ range: "7d", period: "month" }).label).toBe("7d")
  })

  test("nothing given: the fallback", () => {
    expect(ok({}, "day").label).toBe("day")
    expect(ok({}).fromMs).toBe(Date.UTC(2026, 10, 11))
    const parsed = parseUsageRange({}, NOW, "7d")
    expect(parsed.ok && parsed.range.label).toBe("7d")
  })

  test.each([
    { range: "year" },
    { range: "" },
    { period: "year" },
    { period: "7d" },
  ])("rejects %o", (query) => {
    expect(parseUsageRange(query, NOW, "day").ok).toBe(false)
  })

  test("a range is not checked against a period it overrides", () => {
    expect(ok({ range: "30d", period: "year" }).label).toBe("30d")
  })
})
