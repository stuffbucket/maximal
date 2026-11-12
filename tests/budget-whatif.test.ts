import { describe, expect, test } from "bun:test"

import type {
  BudgetLimitPutRequest,
  BudgetSimulationResult,
} from "../src/lib/config/settings-types"

import {
  roundUpAmount,
  simulateKey,
  simulateRequest,
  suggestedAmount,
  whatIfFacts,
} from "../shell/src/ui/features/budget/whatif"

const draft: BudgetLimitPutRequest = {
  label: "My cap",
  scope: { kind: "key", id: "codex" },
  amount: 5,
  limit_reset: "daily",
  warn_at: 0.8,
  action: "block",
}

function result(
  overrides: Partial<BudgetSimulationResult> = {},
): BudgetSimulationResult {
  return {
    id: "draft-1",
    label: null,
    scope: { kind: "key", id: "codex" },
    limit: 5_000_000_000,
    limit_reset: "daily",
    warn_at: 0.8,
    action: "block",
    mode: "periods",
    matched_requests: 120,
    matched_nano_aiu: 9_000_000_000,
    admitted_nano_aiu: 8_000_000_000,
    refused_requests: 14,
    refused_nano_aiu: 1_000_000_000,
    warned_at: "2026-11-03T16:10:00.000Z",
    tripped_at: "2026-11-04T09:00:00.000Z",
    peak: { nano_aiu: 6_000_000_000, at: "2026-11-04T00:00:00.000Z" },
    periods_total: 30,
    periods_warned: 5,
    periods_tripped: 3,
    suggested_nano_aiu: 4_381_000_000,
    display: {
      limit: 0.05,
      matched: 0.09,
      refused: 0.01,
      peak: 0.06,
      suggested: 4.381,
    },
    periods: [],
    ...overrides,
  }
}

describe("the what-if request", () => {
  test("is the draft over the range, without its name", () => {
    const request = simulateRequest(draft, { range: "30d", from: "", to: "" })
    expect(request).toEqual({
      limits: [
        {
          scope: { kind: "key", id: "codex" },
          amount: 5,
          limit_reset: "daily",
          warn_at: 0.8,
          action: "block",
        },
      ],
      range: "30d",
    })
  })

  test("typing the name changes nothing, so it asks for nothing new", () => {
    const choice = { range: "30d", from: "", to: "" } as const
    expect(simulateKey(simulateRequest(draft, choice))).toBe(
      simulateKey(simulateRequest({ ...draft, label: "Other" }, choice)),
    )
    expect(
      simulateKey(simulateRequest({ ...draft, amount: 6 }, choice)),
    ).not.toBe(simulateKey(simulateRequest(draft, choice)))
    expect(
      simulateKey(simulateRequest(draft, { ...choice, range: "90d" })),
    ).not.toBe(simulateKey(simulateRequest(draft, choice)))
  })

  test("a form that isn't a rule yet, or a half-picked range, asks for nothing", () => {
    expect(simulateRequest(null, { range: "30d", from: "", to: "" })).toBeNull()
    expect(
      simulateRequest(draft, { range: "custom", from: "", to: "" }),
    ).toBeNull()
    expect(simulateKey(null)).toBe("")
  })
})

describe("the suggested amount", () => {
  test("rounds up to what the amount reads as, never down", () => {
    expect(roundUpAmount(4.381)).toBe(4.39)
    expect(roundUpAmount(4.38)).toBe(4.38)
    expect(roundUpAmount(4.3801)).toBe(4.39)
    // A small amount keeps two significant digits.
    expect(roundUpAmount(0.0124)).toBe(0.013)
    expect(roundUpAmount(0.3125)).toBe(0.32)
    expect(roundUpAmount(100)).toBe(100)
  })

  test("is the simulation's, rounded up, or nothing without history", () => {
    expect(suggestedAmount(result())).toBe(4.39)
    expect(
      suggestedAmount(
        result({
          suggested_nano_aiu: null,
          display: { ...result().display, suggested: null },
        }),
      ),
    ).toBeNull()
  })
})

describe("what the replay says", () => {
  test("reads the facts in the order the panel lists them", () => {
    const facts = whatIfFacts(result())
    expect(facts).toMatchObject({
      anyUsage: true,
      blocks: true,
      warnedAt: "2026-11-03T16:10:00.000Z",
      trippedAt: "2026-11-04T09:00:00.000Z",
      refusedRequests: 14,
      refusedAmount: 0.01,
      peakAmount: 0.06,
      matchedRequests: 120,
      periods: { tripped: 3, total: 30 },
      rolling: false,
      suggested: 4.39,
    })
  })

  test("a warn-only rule refuses nothing and says it only warns", () => {
    expect(whatIfFacts(result({ action: "warn" })).blocks).toBe(false)
    expect(whatIfFacts(result({ action: "warn" })).asks).toBe(false)
  })

  test("a rule that asks refuses nothing either: it would have asked first", () => {
    const facts = whatIfFacts(result({ action: "ask" }))
    expect(facts.blocks).toBe(false)
    expect(facts.asks).toBe(true)
  })

  test("a rolling rule has no periods to count", () => {
    const facts = whatIfFacts(
      result({
        mode: "rolling",
        periods_total: null,
        periods_warned: null,
        periods_tripped: null,
      }),
    )
    expect(facts.rolling).toBe(true)
    expect(facts.periods).toBeNull()
  })

  test("no usage in scope is no usage, even with a suggestion absent", () => {
    const facts = whatIfFacts(
      result({
        matched_requests: 0,
        warned_at: null,
        tripped_at: null,
        suggested_nano_aiu: null,
        display: { ...result().display, suggested: null },
      }),
    )
    expect(facts.anyUsage).toBe(false)
    expect(facts.warnedAt).toBeNull()
    expect(facts.suggested).toBeNull()
  })
})
