import { describe, expect, test } from "bun:test"

import { borderPeriodS, tracePath } from "../shell/src/dashboard/live/geometry"

/** Every y coordinate in an SVG path's commands (M, L and C pairs). */
function ys(d: string): Array<number> {
  const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  return numbers.filter((_, i) => i % 2 === 1)
}

describe("tracePath", () => {
  test("all zeros draw a flat line on the baseline", () => {
    const { line, last } = tracePath(Array<number>(15).fill(0), 0, 280, 68)
    expect(new Set(ys(line))).toEqual(new Set([68]))
    expect(last).toEqual([280, 68])
  })

  test("a spike never dips below the baseline or above the top", () => {
    const values = [0, 0, 0, 0, 0, 0, 50_000, 0, 0, 0, 0, 0, 0, 0, 0]
    const { line, area } = tracePath(values, 50_000, 280, 68)
    for (const y of [...ys(line), ...ys(area)]) {
      expect(y).toBeLessThanOrEqual(68)
      expect(y).toBeGreaterThanOrEqual(0)
    }
  })

  test("a steep climb then a drop stays inside the box", () => {
    const values = [3_100, 2_400, 4_800, 0, 5_600, 7_900, 41_000, 0, 41_000]
    const { line } = tracePath(values, 41_000, 100, 40)
    for (const y of ys(line)) {
      expect(y).toBeLessThanOrEqual(40)
      expect(y).toBeGreaterThanOrEqual(0)
    }
  })

  test("the last point is the latest value at the right edge", () => {
    const { last } = tracePath([0, 10, 20], 20, 100, 40)
    expect(last).toEqual([100, 0])
  })

  test("the area closes the line down to the baseline", () => {
    const { line, area } = tracePath([1, 2, 3], 3, 100, 40)
    expect(area.startsWith(line)).toBe(true)
    expect(area.endsWith("L100,40 L0,40 Z")).toBe(true)
  })

  test("a single value draws a flat line across the width", () => {
    const { line, last } = tracePath([5], 10, 100, 40)
    expect(ys(line)).toEqual([20, 20])
    expect(last).toEqual([100, 20])
  })
})

/** The period, with "stopped" as NaN so comparisons fail loudly. */
const period = (flow: number): number => borderPeriodS(flow) ?? Number.NaN

describe("borderPeriodS", () => {
  test("stops at zero flow", () => {
    expect(borderPeriodS(0)).toBeNull()
  })

  test("is about 25 s per turn at 500 tokens/min", () => {
    // 30 - 26 * log10(2) / log10(201) = 26.6
    expect(period(500)).toBeGreaterThan(24)
    expect(period(500)).toBeLessThan(28)
  })

  test("reaches the 4 s floor at 100,000 tokens/min and stays there", () => {
    expect(borderPeriodS(100_000)).toBe(4)
    expect(borderPeriodS(5_000_000)).toBe(4)
  })

  test("never exceeds 30 s while anything flows", () => {
    expect(period(1)).toBeLessThanOrEqual(30)
    expect(period(1)).toBeGreaterThan(29)
  })

  test("gets faster as flow rises", () => {
    expect(period(41_800)).toBeLessThan(period(5_000))
  })
})
