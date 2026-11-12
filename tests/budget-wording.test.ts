/**
 * Pure budget helpers: the refusal's wording, the image estimate and scope
 * matching. No clock, database or config.
 */

import { describe, expect, test } from "bun:test"

import { estimateOperationNanoAiu } from "~/lib/budget/estimate"
import { budgetKeyOf, scopeMatches } from "~/lib/budget/scope"
import { NANO_AIU_PER_CREDIT, type BudgetDisplay } from "~/lib/budget/units"
import {
  formatAmount,
  formatDuration,
  refusalMessage,
  type RefusalWords,
} from "~/lib/budget/wording"

const AIU = NANO_AIU_PER_CREDIT
const usd: BudgetDisplay = { unit: "usd", creditUsd: 0.01 }
const credits: BudgetDisplay = { unit: "credits", creditUsd: 0.01 }

describe("formatAmount", () => {
  test("dollars to the cent, and to two significant figures below a cent", () => {
    expect(formatAmount(3 * AIU, usd)).toBe("$0.03")
    expect(formatAmount(0, usd)).toBe("$0.00")
    expect(formatAmount(0.6 * AIU, usd)).toBe("$0.006")
    expect(formatAmount(0.123456 * AIU, usd)).toBe("$0.0012")
    expect(formatAmount(150 * AIU, usd)).toBe("$1.50")
  })

  test("AI credits when that is the display unit", () => {
    expect(formatAmount(2.5 * AIU, credits)).toBe("2.50 AI credits")
    expect(formatAmount(0.6 * AIU, { ...credits, creditUsd: 0.5 })).toBe(
      "0.60 AI credits",
    )
  })

  test("the credit rate changes dollars only", () => {
    expect(formatAmount(AIU, { unit: "usd", creditUsd: 0.5 })).toBe("$0.50")
  })
})

describe("formatDuration", () => {
  test("minutes, hours with minutes, then days", () => {
    expect(formatDuration(10_000)).toBe("1 min")
    expect(formatDuration(59 * 60_000)).toBe("59 min")
    expect(formatDuration(3 * 3_600_000 + 12 * 60_000)).toBe("3 h 12 min")
    expect(formatDuration(5 * 3_600_000)).toBe("5 h")
    expect(formatDuration(47 * 3_600_000)).toBe("47 h")
    expect(formatDuration(72 * 3_600_000)).toBe("3 days")
  })
})

describe("refusalMessage", () => {
  const NOW = Date.UTC(2026, 10, 11, 20, 48, 0)
  const base: RefusalWords = {
    name: "Images per day",
    limit: 3 * AIU,
    used: 3 * AIU,
    held: 0,
    requested: 0.6 * AIU,
    resetsAtMs: Date.UTC(2026, 10, 12, 0, 0, 0),
    nowMs: NOW,
    inFlight: false,
    display: usd,
  }

  test("a spent limit says so, with what this call needs and when it resets", () => {
    expect(refusalMessage(base)).toBe(
      'Maximal rule "Images per day" is used up: $0.03 of $0.03 used; this request needs about $0.006. Resets 2026-11-12T00:00:00.000Z (in 3 h 12 min). Raise or remove it in Maximal → Rules.',
    )
  })

  test("a call that doesn't fit says there's no room for it", () => {
    expect(refusalMessage({ ...base, used: 2.98 * AIU })).toBe(
      'Maximal rule "Images per day" doesn\'t have room for this request: $0.03 of $0.03 used; this request needs about $0.006. Resets 2026-11-12T00:00:00.000Z (in 3 h 12 min). Raise or remove it in Maximal → Rules.',
    )
  })

  test("a call with no estimate leaves that clause out", () => {
    expect(refusalMessage({ ...base, requested: 0 })).toBe(
      'Maximal rule "Images per day" is used up: $0.03 of $0.03 used. Resets 2026-11-12T00:00:00.000Z (in 3 h 12 min). Raise or remove it in Maximal → Rules.',
    )
  })

  test("a limit that never resets says that", () => {
    expect(refusalMessage({ ...base, resetsAtMs: null })).toContain(
      "It never resets.",
    )
  })

  test("room held by calls in progress is not a wait for the reset", () => {
    const message = refusalMessage({
      ...base,
      used: AIU,
      held: 1.8 * AIU,
      inFlight: true,
    })
    expect(message).toBe(
      'Maximal rule "Images per day" has $0.02 left, and requests in progress already hold $0.02 of it; this request needs about $0.006. Try again in a moment. Raise or remove it in Maximal → Rules.',
    )
    expect(message).not.toContain("Resets")
  })

  test("amounts follow the display unit", () => {
    expect(refusalMessage({ ...base, display: credits })).toContain(
      "3.00 AI credits of 3.00 AI credits used; this request needs about 0.60 AI credits",
    )
  })
})

describe("estimateOperationNanoAiu", () => {
  test("a low-quality generation is about 0.6 AI credits, scaling with quality and count", () => {
    expect(
      estimateOperationNanoAiu("images.generations", { quality: "low" }),
    ).toBe(0.6 * AIU)
    expect(
      estimateOperationNanoAiu("images.generations", { quality: "medium" }),
    ).toBe(2.4 * AIU)
    expect(
      estimateOperationNanoAiu("images.generations", { quality: "High" }),
    ).toBe(9.6 * AIU)
    expect(
      estimateOperationNanoAiu("images.generations", { quality: "low", n: 3 }),
    ).toBe(1.8 * AIU)
  })

  test("a generation that names no quality (or auto) is estimated as medium", () => {
    expect(estimateOperationNanoAiu("images.generations", {})).toBe(2.4 * AIU)
    expect(
      estimateOperationNanoAiu("images.generations", { quality: "auto" }),
    ).toBe(2.4 * AIU)
  })

  test("an edit is about 1.4 AI credits", () => {
    expect(estimateOperationNanoAiu("images.edits", {})).toBe(1.4 * AIU)
  })

  test("reads a multipart form, with n as text", () => {
    const form = new FormData()
    form.set("quality", "low")
    form.set("n", "2")
    expect(estimateOperationNanoAiu("images.edits", form)).toBe(2.8 * AIU)
  })

  test("a bad count counts as one, and at most ten", () => {
    for (const n of [0, -2, 1.5, "x", null]) {
      expect(
        estimateOperationNanoAiu("images.generations", { quality: "low", n }),
      ).toBe(0.6 * AIU)
    }
    expect(
      estimateOperationNanoAiu("images.generations", { quality: "low", n: 99 }),
    ).toBe(6 * AIU)
  })

  test("calls that can't be estimated are 0", () => {
    expect(estimateOperationNanoAiu("decisions", {})).toBe(0)
    expect(estimateOperationNanoAiu("systemone", {})).toBe(0)
    expect(estimateOperationNanoAiu("messages", {})).toBe(0)
    expect(estimateOperationNanoAiu("server_tool", {})).toBe(0)
  })
})

describe("scope matching", () => {
  const subject = { key: "codex", plugin: "images", provider: "copilot" }

  test("global covers everything; the others select one attribute", () => {
    expect(scopeMatches({ kind: "global" }, subject)).toBe(true)
    expect(scopeMatches({ kind: "key", id: "codex" }, subject)).toBe(true)
    expect(scopeMatches({ kind: "key", id: "other" }, subject)).toBe(false)
    expect(scopeMatches({ kind: "plugin", id: "images" }, subject)).toBe(true)
    expect(scopeMatches({ kind: "plugin", id: "systemone" }, subject)).toBe(
      false,
    )
    expect(scopeMatches({ kind: "provider", id: "copilot" }, subject)).toBe(
      true,
    )
  })

  test("a call with no plugin or provider isn't in a scope that names one", () => {
    const plain = { key: "codex" }
    expect(scopeMatches({ kind: "plugin", id: "images" }, plain)).toBe(false)
    expect(scopeMatches({ kind: "provider", id: "copilot" }, plain)).toBe(false)
    expect(scopeMatches({ kind: "global" }, plain)).toBe(true)
  })

  test("the key is the label, else the recognised client, else unidentified", () => {
    expect(budgetKeyOf("ci", "claude-code")).toBe("ci")
    expect(budgetKeyOf(null, "claude-code")).toBe("claude-code")
    expect(budgetKeyOf(undefined, "codex")).toBe("codex")
    expect(budgetKeyOf("", "other")).toBe("unidentified")
    expect(budgetKeyOf(null, "other")).toBe("unidentified")
  })
})
