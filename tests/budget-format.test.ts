import { describe, expect, test } from "bun:test"

import type {
  BudgetLimitStatus,
  BudgetStatusResponse,
  ProviderQuotaWindowStatus,
} from "../src/lib/config/settings-types"

import {
  type ActivityRow,
  type LimitForm,
  amountText,
  blockingLimit,
  buildPutRequest,
  columnHeights,
  describeReset,
  formatAmount,
  formatDayKey,
  formatRelative,
  keyChoices,
  newLimitId,
  nanoToDisplay,
  currencyAffix,
  parseAmount,
  parseAmountDetailed,
  parseWarnPercent,
  pluginChoices,
  providerChoices,
  resetChoice,
  resetFromChoice,
  topSegments,
  usedFraction,
  warnPercentText,
  windowTone,
  windowUsedFraction,
} from "../shell/src/ui/features/budget/format"

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)
const HOUR = 3_600_000
const DAY = 24 * HOUR

function limit(overrides: Partial<BudgetLimitStatus> = {}): BudgetLimitStatus {
  return {
    id: "images-daily",
    label: null,
    scope: { kind: "plugin", id: "images" },
    action: "block",
    warn_at: 0.8,
    limit: 3_000_000_000,
    limit_reset: "daily",
    limit_remaining: 600_000_000,
    usage: 2_400_000_000,
    held: 0,
    usage_daily: 2_400_000_000,
    usage_weekly: 2_400_000_000,
    period_start: new Date(NOW - 12 * HOUR).toISOString(),
    resets_at: new Date(NOW + 12 * HOUR).toISOString(),
    reset_basis: "fixed",
    reset_estimated: false,
    state: "warning",
    display: { limit: 0.03, usage: 0.024, limit_remaining: 0.006 },
    ...overrides,
  }
}

function window(
  overrides: Partial<ProviderQuotaWindowStatus> = {},
): ProviderQuotaWindowStatus {
  return {
    provider: "copilot",
    id: "premium_interactions",
    label: "Copilot premium allowance",
    unit: "credits",
    used: null,
    limit: null,
    percent_remaining: null,
    resets_at: new Date(NOW + 19 * DAY).toISOString(),
    previous_resets_at: null,
    kind: "fixed",
    duration_ms: null,
    scope: null,
    overage: null,
    observed_at: new Date(NOW).toISOString(),
    source: "header",
    ...overrides,
  }
}

const form = (overrides: Partial<LimitForm> = {}): LimitForm => ({
  label: "",
  scopeKind: "global",
  scopeId: "",
  amount: "3",
  reset: "daily",
  warnPercent: "80",
  action: "block",
  ...overrides,
})

const row = (key: string | null, nano: number, requests = 1): ActivityRow => ({
  key,
  nano_aiu: nano,
  requests,
  amount: nano / 1e11,
})

function status(
  overrides: Partial<BudgetStatusResponse> = {},
): BudgetStatusResponse {
  return {
    enabled: true,
    display: { unit: "usd", credit_usd: 0.01 },
    storage_enabled: true,
    budgets: [],
    effective_budget: null,
    provider_windows: [],
    filters: [],
    ...overrides,
  }
}

describe("amounts", () => {
  test("US dollars keep two decimals for ordinary amounts", () => {
    expect(formatAmount(2.4, "usd", "en-US")).toBe("$2.40")
    expect(formatAmount(0, "usd", "en-US")).toBe("$0.00")
    expect(formatAmount(1234.5, "usd", "en-US")).toBe("$1,234.50")
  })

  test("a small amount keeps two significant digits instead of rounding to a cent", () => {
    expect(formatAmount(0.006, "usd", "en-US")).toBe("$0.006")
    expect(formatAmount(0.0004, "usd", "en-US")).toBe("$0.0004")
    expect(formatAmount(0.061, "usd", "en-US")).toBe("$0.061")
  })

  test("AI credits are a bare number for the caller to give a unit", () => {
    expect(formatAmount(2.4, "credits", "en-US")).toBe("2.40")
    expect(formatAmount(0.6, "credits", "en-US")).toBe("0.60")
  })

  test("the language decides separators and the currency sign's place", () => {
    expect(formatAmount(1234.5, "usd", "de-DE")).toContain("1.234,50")
  })

  test("nano-AIU convert to the display unit like the server does", () => {
    const usd = { unit: "usd", credit_usd: 0.01 } as const
    const credits = { unit: "credits", credit_usd: 0.01 } as const
    expect(nanoToDisplay(600_000_000, usd)).toBeCloseTo(0.006, 10)
    expect(nanoToDisplay(600_000_000, credits)).toBeCloseTo(0.6, 10)
    expect(
      nanoToDisplay(1_000_000_000, { unit: "usd", credit_usd: 0.02 }),
    ).toBeCloseTo(0.02, 10)
  })

  test("the amount field starts from a clean number", () => {
    expect(amountText(0.30000000000000004)).toBe("0.3")
    expect(amountText(12)).toBe("12")
    expect(amountText(0.006)).toBe("0.006")
  })

  test("the amount field starts in the locale's decimal mark, ungrouped, so it reads back the same", () => {
    expect(amountText(2.125, "de")).toBe("2,125")
    expect(amountText(1234.5, "en")).toBe("1234.5")
    expect(parseAmount(amountText(2.125, "de"), USD, "de")).toBe(2.125)
    expect(parseAmount(amountText(1234.5, "de"), USD, "de")).toBe(1234.5)
  })
})

describe("meters", () => {
  test("usedFraction is clamped and a limit of zero is full once anything is spent", () => {
    expect(usedFraction(2.4, 3)).toBeCloseTo(0.8)
    expect(usedFraction(5, 3)).toBe(1)
    expect(usedFraction(0, 0)).toBe(0)
    expect(usedFraction(1, 0)).toBe(1)
    expect(usedFraction(-1, 3)).toBe(0)
  })

  test("a provider window reads its own percentage first, then its counters", () => {
    expect(
      windowUsedFraction({ percent_remaining: 62.4, used: null, limit: null }),
    ).toBeCloseTo(0.376)
    expect(
      windowUsedFraction({ percent_remaining: null, used: 25, limit: 100 }),
    ).toBe(0.25)
    expect(
      windowUsedFraction({ percent_remaining: null, used: null, limit: null }),
    ).toBeNull()
    expect(
      windowUsedFraction({ percent_remaining: 140, used: null, limit: null }),
    ).toBe(0)
  })

  test("a window warns from 75% used and errors from 90%, like the Dashboard's quotas", () => {
    expect(windowTone(0.5)).toBe("ok")
    expect(windowTone(0.75)).toBe("warning")
    expect(windowTone(0.89)).toBe("warning")
    expect(windowTone(0.9)).toBe("exhausted")
  })
})

describe("time", () => {
  test("relative times pick the unit a person would say", () => {
    expect(formatRelative(NOW + 20 * 60_000, NOW, "en-US")).toBe(
      "in 20 minutes",
    )
    expect(formatRelative(NOW + 3 * HOUR, NOW, "en-US")).toBe("in 3 hours")
    expect(formatRelative(NOW + 4 * DAY, NOW, "en-US")).toBe("in 4 days")
    expect(formatRelative(NOW + 21 * DAY, NOW, "en-US")).toBe("in 3 weeks")
    expect(formatRelative(NOW + 90 * DAY, NOW, "en-US")).toBe("in 3 months")
    expect(formatRelative(NOW - 2 * HOUR, NOW, "en-US")).toBe("2 hours ago")
  })

  test("a reset a few seconds away still reads as a minute, never zero", () => {
    expect(formatRelative(NOW + 5_000, NOW, "en-US")).toBe("in 1 minute")
  })

  test("a day key names the UTC day whatever the local zone is", () => {
    expect(formatDayKey("2026-11-10", "en-US")).toBe("Nov 10")
    expect(formatDayKey("not-a-day", "en-US")).toBe("not-a-day")
  })
})

describe("what a limit's reset reads as", () => {
  test("a limit that never resets has no date", () => {
    expect(
      describeReset(limit({ limit_reset: "never", resets_at: null }), []),
    ).toEqual({ kind: "never" })
  })

  test("a daily or weekly limit resets at a fixed time", () => {
    const described = describeReset(limit(), [])
    expect(described).toEqual({
      kind: "at",
      resetsAtMs: NOW + 12 * HOUR,
      estimated: false,
    })
  })

  test("a limit that follows a provider window names it", () => {
    const followed = limit({
      limit_reset: { follow: "copilot:premium_interactions" },
      reset_basis: "provider",
      resets_at: new Date(NOW + 19 * DAY).toISOString(),
    })
    expect(describeReset(followed, [window()])).toEqual({
      kind: "follow",
      resetsAtMs: NOW + 19 * DAY,
      estimated: false,
      window: "Copilot premium allowance",
    })
  })

  test("a followed window nobody has reported falls back to its reference", () => {
    const followed = limit({
      limit_reset: { follow: "copilot:chat" },
      reset_basis: "provider",
      reset_estimated: true,
    })
    const described = describeReset(followed, [])
    expect(described).toMatchObject({
      kind: "follow",
      estimated: true,
      window: "copilot:chat",
    })
  })

  test("a followed window with no usable reset says it fell back to daily", () => {
    const fell = limit({
      limit_reset: { follow: "copilot:chat" },
      reset_basis: "fallback",
      reset_estimated: true,
    })
    expect(describeReset(fell, [])).toMatchObject({
      kind: "fallback",
      window: "copilot:chat",
    })
  })
})

describe("what stops requests", () => {
  test("a spent blocking limit is reported", () => {
    const spent = limit({
      state: "exhausted",
      usage: 3_000_000_000,
      limit_remaining: 0,
    })
    expect(
      blockingLimit(status({ budgets: [spent], effective_budget: spent.id }))
        ?.id,
    ).toBe("images-daily")
  })

  test("nothing blocks while enforcement is off, the limit is only a warning, or room is left", () => {
    const spent = limit({ state: "exhausted" })
    expect(
      blockingLimit(
        status({
          enabled: false,
          budgets: [spent],
          effective_budget: spent.id,
        }),
      ),
    ).toBeUndefined()
    const warnOnly = limit({ state: "exhausted", action: "warn" })
    expect(
      blockingLimit(
        status({ budgets: [warnOnly], effective_budget: warnOnly.id }),
      ),
    ).toBeUndefined()
    const roomy = limit({ state: "ok" })
    expect(
      blockingLimit(status({ budgets: [roomy], effective_budget: roomy.id })),
    ).toBeUndefined()
    expect(blockingLimit(status())).toBeUndefined()
  })
})

const USD = { unit: "usd", credit_usd: 0.01 } as const
const CREDITS = { unit: "credits", credit_usd: 0.01 } as const

describe("the limit editor", () => {
  test("a form becomes the request the API takes, with the amount in the display unit", () => {
    const built = buildPutRequest(
      form({
        label: "  Daily cap ",
        amount: "2,5",
        warnPercent: "90",
        action: "warn",
      }),
    )
    expect(built).toEqual({
      ok: true,
      body: {
        label: "Daily cap",
        scope: { kind: "global" },
        amount: 2.5,
        limit_reset: "daily",
        warn_at: 0.9,
        action: "warn",
      },
    })
  })

  test("a named scope carries its id, and an unnamed limit sends no label", () => {
    const built = buildPutRequest(
      form({
        scopeKind: "plugin",
        scopeId: " images ",
        reset: "follow:copilot:premium_interactions",
      }),
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.body.scope).toEqual({ kind: "plugin", id: "images" })
    expect(built.body.limit_reset).toEqual({
      follow: "copilot:premium_interactions",
    })
    expect("label" in built.body).toBe(false)
  })

  test("the first problem is named", () => {
    expect(buildPutRequest(form({ amount: "" }))).toEqual({
      ok: false,
      issue: "amount",
    })
    expect(buildPutRequest(form({ amount: "0" }))).toEqual({
      ok: false,
      issue: "amount-zero",
    })
    expect(buildPutRequest(form({ amount: "abc" }))).toEqual({
      ok: false,
      issue: "amount",
    })
    expect(buildPutRequest(form({ warnPercent: "0" }))).toEqual({
      ok: false,
      issue: "warn",
    })
    expect(buildPutRequest(form({ warnPercent: "101" }))).toEqual({
      ok: false,
      issue: "warn",
    })
    expect(buildPutRequest(form({ scopeKind: "key", scopeId: " " }))).toEqual({
      ok: false,
      issue: "target",
    })
  })
})

describe("the amount field", () => {
  test("a currency sign or code on either end is ignored", () => {
    for (const text of [
      "$100",
      "$ 100",
      "100$",
      "100 $",
      "  $100  ",
      "USD 100",
      "100 usd",
      "100USD",
      "US$100",
      "100 Usd",
    ]) {
      expect(parseAmount(text, USD)).toBe(100)
    }
    for (const text of ["€100", "100 EUR", "£100", "¥100", "₹100", "100 eur"]) {
      expect(parseAmount(text, USD)).toBe(100)
    }
  })

  test("credit words are accepted in any case, and the unit sits where it is typed", () => {
    for (const text of [
      "100 credits",
      "100 Credits",
      "100 credit",
      "100 AIU",
      "100aiu",
      "100 cr",
      "100CR",
      "credits 100",
      "AIU 100",
      "  100   credits  ",
    ]) {
      expect(parseAmount(text, CREDITS)).toBe(100)
    }
  })

  test("a unit that differs from the display unit is converted at credit_usd", () => {
    expect(parseAmount("$5", CREDITS)).toBeCloseTo(500, 8)
    expect(parseAmount("2.5 USD", CREDITS)).toBeCloseTo(250, 8)
    expect(parseAmount("100 credits", USD)).toBeCloseTo(1, 8)
    expect(
      parseAmount("250 AIU", { unit: "usd", credit_usd: 0.02 }),
    ).toBeCloseTo(5, 8)
    // The same unit is not converted.
    expect(parseAmount("$5", USD)).toBe(5)
    expect(parseAmount("5 credits", CREDITS)).toBe(5)
    // A bare number is in the display unit.
    expect(parseAmount("5", CREDITS)).toBe(5)
  })

  test("two different units are not guessed at", () => {
    expect(parseAmountDetailed("$100 credits", USD)).toEqual({
      ok: false,
      reason: "format",
    })
    expect(parseAmount("$100 USD", USD)).toBe(100)
  })

  test("thousands separators follow the locale", () => {
    expect(parseAmount("1,000.50", USD, "en")).toBe(1000.5)
    expect(parseAmount("$1,000.50", USD, "en")).toBe(1000.5)
    expect(parseAmount("1.000,50", USD, "de")).toBe(1000.5)
    expect(parseAmount("1.000,50 €", USD, "de")).toBe(1000.5)
    expect(parseAmount("1,000", USD, "en")).toBe(1000)
    expect(parseAmount("1.000", USD, "de")).toBe(1000)
    expect(parseAmount("1,000,000", USD, "en")).toBe(1_000_000)
    expect(parseAmount("1.000.000", USD, "de")).toBe(1_000_000)
    expect(parseAmount("1 000,50", USD, "fr")).toBe(1000.5)
    expect(parseAmount("1\u202f000,50", USD, "fr")).toBe(1000.5)
    expect(parseAmount("1'000.50", USD, "en")).toBe(1000.5)
    // Both marks present: the last is the decimal point, whatever the locale.
    expect(parseAmount("1,000.50", USD, "de")).toBe(1000.5)
    expect(parseAmount("1.000,50", USD, "en")).toBe(1000.5)
  })

  test("a lone comma or point that is not a group of three is a decimal mark", () => {
    expect(parseAmount("2,5", USD, "en")).toBe(2.5)
    expect(parseAmount("2,50", USD, "en")).toBe(2.5)
    expect(parseAmount("0,500", USD, "en")).toBe(0.5)
    expect(parseAmount("2.5", USD, "de")).toBe(2.5)
    expect(parseAmount("2,5", USD, "de")).toBe(2.5)
    expect(parseAmount("2,500", USD, "de")).toBe(2.5)
    expect(parseAmount(".5", USD, "en")).toBe(0.5)
    expect(parseAmount("5.", USD, "en")).toBe(5)
  })

  test("what is not an amount says so, and zero is told apart", () => {
    for (const text of [
      "",
      "   ",
      "$",
      "credits",
      "abc",
      "$abc",
      "1,2,3",
      "1.2.3",
      "1e3",
      "-5",
      "$-5",
      "12 34 56x",
      "NaN",
      "Infinity",
    ]) {
      expect(parseAmountDetailed(text, USD, "en")).toEqual({
        ok: false,
        reason: "format",
      })
      expect(parseAmount(text, USD, "en")).toBeNull()
    }
    for (const text of ["0", "$0", "0.00", "0 credits"]) {
      expect(parseAmountDetailed(text, USD, "en")).toEqual({
        ok: false,
        reason: "zero",
      })
    }
  })

  test("the editor builds the request from a typed unit, in the display unit", () => {
    const built = buildPutRequest(form({ amount: "$100" }), CREDITS)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.body.amount).toBeCloseTo(10_000, 6)
    const german = buildPutRequest(form({ amount: "1.000,50 $" }), USD, "de")
    expect(german.ok && german.body.amount).toBe(1000.5)
    expect(buildPutRequest(form({ amount: "$ abc" }), USD)).toEqual({
      ok: false,
      issue: "amount",
    })
  })

  test("the dollar sign sits on the side the locale writes it", () => {
    expect(currencyAffix("en")).toEqual({ symbol: "$", position: "prefix" })
    expect(currencyAffix("de").position).toBe("suffix")
    expect(currencyAffix("not-a-locale-").position).toBe("prefix")
  })
})

describe("the limit editor's other inputs", () => {
  test("amounts and percentages are read the way people type them", () => {
    expect(parseAmount("12.50")).toBe(12.5)
    expect(parseAmount(" 0,25 ")).toBe(0.25)
    expect(parseAmount("-1")).toBeNull()
    expect(parseWarnPercent("80")).toBe(0.8)
    expect(parseWarnPercent("100")).toBe(1)
    expect(parseWarnPercent("12.4")).toBe(0.12)
    expect(parseWarnPercent("")).toBeNull()
    expect(warnPercentText(0.8)).toBe("80")
  })

  test("the reset select round-trips every kind of reset", () => {
    for (const reset of [
      "daily",
      "weekly",
      "never",
      { follow: "copilot:premium_interactions" },
    ] as const) {
      expect(resetFromChoice(resetChoice(reset))).toEqual(reset)
    }
    expect(resetFromChoice("nonsense")).toBe("daily")
  })

  test("a new limit gets a readable id that no other limit has", () => {
    expect(newLimitId({ kind: "global" }, "daily", [])).toBe("everything-daily")
    expect(newLimitId({ kind: "plugin", id: "images" }, "daily", [])).toBe(
      "plugin-images-daily",
    )
    expect(newLimitId({ kind: "key", id: "Claude Code!" }, "weekly", [])).toBe(
      "key-claude-code-weekly",
    )
    expect(
      newLimitId(
        { kind: "provider", id: "copilot" },
        { follow: "copilot:chat" },
        [],
      ),
    ).toBe("provider-copilot-cycle")
    expect(
      newLimitId({ kind: "global" }, "daily", [
        "everything-daily",
        "everything-daily-2",
      ]),
    ).toBe("everything-daily-3")
  })

  test("an id stays within the API's pattern and length", () => {
    const id = newLimitId({ kind: "key", id: "x".repeat(200) }, "never", [])
    expect(id.length).toBeLessThanOrEqual(64)
    expect(id).toMatch(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u)
  })

  test("pickers list only what exists, once, with the built-ins after the person's own", () => {
    expect(keyChoices(["work laptop", "codex"])).toEqual([
      "work laptop",
      "codex",
      "claude-code",
      "claude-desktop",
      "unidentified",
    ])
    expect(pluginChoices(["figjam", "images"])).toEqual([
      "images",
      "decisions",
      "systemone",
      "figjam",
    ])
    expect(providerChoices([])).toEqual(["copilot"])
    expect(
      providerChoices([
        window(),
        window({ id: "chat" }),
        window({ provider: "acme", id: "weekly" }),
      ]),
    ).toEqual(["copilot", "acme"])
  })
})

describe("activity", () => {
  test("few rows each get a segment, biggest first, with their share", () => {
    const segments = topSegments(
      [row("a", 100), row("b", 300), row("c", 100)],
      6,
    )
    expect(segments.map((segment) => segment.key)).toEqual(["b", "a", "c"])
    expect(segments[0]?.share).toBeCloseTo(0.6)
    expect(segments.some((segment) => segment.other)).toBe(false)
  })

  test("the tail folds into one Other segment that keeps every total", () => {
    const rows = [
      row("a", 600, 6),
      row("b", 500, 5),
      row("c", 400, 4),
      row("d", 300, 3),
      row("e", 200, 2),
      row("f", 100, 1),
      row("g", 50, 1),
    ]
    const segments = topSegments(rows, 6)
    expect(segments).toHaveLength(6)
    expect(segments.slice(0, 5).map((segment) => segment.key)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ])
    const other = segments[5]
    expect(other).toMatchObject({
      other: true,
      key: null,
      nanoAiu: 150,
      requests: 2,
    })
    expect(other.amount).toBeCloseTo(150 / 1e11)
    expect(
      segments.reduce((sum, segment) => sum + segment.share, 0),
    ).toBeCloseTo(1)
  })

  test("exactly the limit of rows needs no Other", () => {
    const rows = Array.from({ length: 6 }, (_, index) =>
      row(`m${index}`, 100 - index),
    )
    expect(topSegments(rows, 6).some((segment) => segment.other)).toBe(false)
  })

  test("no rows, no segments; no spend, no shares", () => {
    expect(topSegments([], 6)).toEqual([])
    expect(topSegments([row("a", 0)], 6)[0]?.share).toBe(0)
  })

  test("day columns are as tall as their share of the busiest day", () => {
    expect(
      columnHeights([
        row("2026-11-09", 100),
        row("2026-11-10", 50),
        row("2026-11-11", 0),
      ]),
    ).toEqual([1, 0.5, 0])
    expect(columnHeights([])).toEqual([])
  })
})
