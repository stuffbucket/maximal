import { describe, expect, test } from "bun:test"

import {
  endpointLabel,
  formatCellText,
  formatCompact,
  formatCostAiu,
  formatNumber,
  formatQuotaUsed,
  formatRate,
  formatRelativeTime,
  providerLabel,
  quotaView,
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

describe("quotaView", () => {
  const base = {
    entitlement: 100,
    remaining: 100,
    percent_remaining: 100,
    unlimited: false,
  }
  test("unlimited is its own level with ∞ labels", () => {
    const v = quotaView({ ...base, unlimited: true })
    expect(v.level).toBe("unlimited")
    expect(v.entitlement).toBe("∞")
    expect(v.remaining).toBe("∞")
  })
  test("severity thresholds: ok ≤75 < warn ≤90 < crit", () => {
    expect(quotaView({ ...base, percent_remaining: 50 }).level).toBe("ok") // 50% used
    expect(quotaView({ ...base, percent_remaining: 20 }).level).toBe("warn") // 80% used
    expect(quotaView({ ...base, percent_remaining: 5 }).level).toBe("crit") // 95% used
  })
  test("percentUsed = 100 − percent_remaining; used floored at 0", () => {
    const v = quotaView({
      entitlement: 100,
      remaining: 30,
      percent_remaining: 30,
      unlimited: false,
    })
    expect(v.percentUsed).toBe(70)
    expect(v.used.replaceAll(/[,. ]/g, "")).toBe("70")
  })
})

describe("formatCompact", () => {
  test("below 1000 renders the rounded integer", () => {
    expect(formatCompact(0)).toBe("0")
    expect(formatCompact(999)).toBe("999")
  })
  test("scales into K / M / B with one decimal below 10", () => {
    expect(formatCompact(1_234)).toBe("1.2K")
    expect(formatCompact(12_000)).toBe("12K")
    expect(formatCompact(3_400_000)).toBe("3.4M")
    expect(formatCompact(2_000_000_000)).toBe("2B")
  })
  test("non-finite degrades to 0", () => {
    expect(formatCompact(Number.NaN)).toBe("0")
  })
})

describe("providerLabel", () => {
  test("the built-in path is GitHub Copilot", () => {
    expect(providerLabel("copilot")).toBe("GitHub Copilot")
    expect(providerLabel("")).toBe("GitHub Copilot")
  })
  test("an external provider is title-cased", () => {
    expect(providerLabel("anthropic")).toBe("Anthropic")
  })
})

describe("endpointLabel", () => {
  test("humanizes known endpoints", () => {
    expect(endpointLabel("chat_completions")).toBe("Chat")
    expect(endpointLabel("responses")).toBe("Responses")
    expect(endpointLabel("provider_messages")).toBe("Messages")
  })
})

describe("formatRelativeTime", () => {
  const now = 1_000_000_000
  test("recent → just now; seconds/minutes/hours/days scale", () => {
    expect(formatRelativeTime(now, now)).toBe("just now")
    expect(formatRelativeTime(now - 12_000, now)).toBe("12s ago")
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago")
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago")
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago")
  })
})

describe("formatRate", () => {
  test("tokens over a window → per-minute compact rate", () => {
    // 600 tokens over 60s = 600/min.
    expect(formatRate(600, 60_000)).toBe("600/min")
    expect(formatRate(0, 0)).toBe("0/min")
  })
})
