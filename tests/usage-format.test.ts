import { describe, expect, test } from "bun:test"

import {
  formatCellText,
  formatCostAiu,
  formatNumber,
  formatQuotaUsed,
} from "../shell/src/ui/features/usage/format"

/**
 * Usage display formatters (spec §4). Locale output isn't pinned (toLocaleString
 * is environment-dependent); the assertions target the stable contract — the
 * em-dash absent-marker, the AIU unit, and the graceful zero/non-finite handling
 * the design failure-modes rule requires.
 */

describe("formatNumber", () => {
  test("non-finite degrades to 0, not NaN", () => {
    expect(formatNumber(Number.NaN)).toBe("0")
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("0")
  })
  test("a finite integer renders its digits", () => {
    expect(formatNumber(0)).toBe("0")
    expect(formatNumber(1234).replaceAll(/[,. ]/g, "")).toBe("1234")
  })
})

describe("formatCostAiu", () => {
  test("zero / negative / non-finite → em dash (many models bill nothing)", () => {
    expect(formatCostAiu(0)).toBe("—")
    expect(formatCostAiu(-5)).toBe("—")
    expect(formatCostAiu(Number.NaN)).toBe("—")
  })
  test("a positive cost renders in AIU", () => {
    expect(formatCostAiu(1_000_000_000).includes("AIU")).toBe(true)
    expect(formatCostAiu(1_000_000_000).startsWith("1")).toBe(true)
  })
  test("sub-1 AIU keeps more precision than large values", () => {
    // 0.0096 AIU must not round to 0.
    const small = formatCostAiu(9_600_000)
    expect(small).not.toBe("—")
    expect(small.includes("AIU")).toBe(true)
  })
})

describe("formatCellText", () => {
  test("non-string → em dash", () => {
    expect(formatCellText(null)).toBe("—")
    expect(formatCellText(42)).toBe("—")
  })
  test("trims, and empty-after-trim → em dash", () => {
    expect(formatCellText("  gpt-4o  ")).toBe("gpt-4o")
    expect(formatCellText("   ")).toBe("—")
  })
})

describe("formatQuotaUsed", () => {
  test("unlimited → 0 used", () => {
    expect(formatQuotaUsed(0, 0, true)).toBe("0")
  })
  test("used = entitlement − remaining, floored at 0", () => {
    expect(formatQuotaUsed(100, 30, false).replaceAll(/[,. ]/g, "")).toBe("70")
    expect(formatQuotaUsed(100, 200, false)).toBe("0") // never negative
  })
})
