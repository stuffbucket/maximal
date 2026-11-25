import { describe, expect, test } from "bun:test"

import type {
  BudgetSessionsResponse,
  BudgetSuggestResponse,
} from "../src/lib/config/settings-types"

import { rangeChoice } from "../shell/src/ui/features/budget/range"
import {
  MAX_SESSIONS,
  draftForm,
  draftToPut,
  editorSupportsReset,
  modelMix,
  selectionTotals,
  sessionMinutes,
  sessionsPath,
  suggestRequest,
} from "../shell/src/ui/features/budget/sessions"

const NOW = Date.UTC(2026, 10, 11, 12)
const USD = { unit: "usd" as const, credit_usd: 0.01 }
const CREDITS = { unit: "credits" as const, credit_usd: 0.01 }

function session(
  id: string,
  nano: number,
  extra: Partial<BudgetSessionsResponse["sessions"][number]> = {},
): BudgetSessionsResponse["sessions"][number] {
  return {
    id,
    attributed: true,
    client: "claude-code",
    client_label: null,
    key: "claude-code",
    started_at: "2026-11-10T09:00:00.000Z",
    ended_at: "2026-11-10T09:30:00.000Z",
    duration_ms: 30 * 60_000,
    requests: 10,
    nano_aiu: nano,
    amount: nano / 1e9 / 100,
    usage: {
      request_count: 10,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      total_tokens: 0,
      total_nano_aiu: nano,
    },
    models: [
      { model: "a", requests: 6, nano_aiu: nano * 0.6, amount: 0, share: 0.6 },
      {
        model: "b",
        requests: 3,
        nano_aiu: nano * 0.25,
        amount: 0,
        share: 0.25,
      },
      { model: "c", requests: 1, nano_aiu: nano * 0.1, amount: 0, share: 0.1 },
      {
        model: "d",
        requests: 1,
        nano_aiu: nano * 0.05,
        amount: 0,
        share: 0.05,
      },
    ],
    ...extra,
  }
}

function rule(
  extra: Partial<BudgetSuggestResponse["limits"][number]> = {},
): BudgetSuggestResponse["limits"][number] {
  return {
    id: "daily-cap",
    label: "Daily cap",
    scope: { kind: "global" },
    limit: 4_500_000_000,
    amount: 0.045,
    limit_reset: "daily",
    warn_at: 0.8,
    action: "block",
    basis: {
      percentile: 0.9,
      periods_observed: 7,
      peak_nano_aiu: 5e9,
      sized_to_nano_aiu: 4e9,
      share: 1,
    },
    projection: {
      periods_total: 7,
      periods_tripped: 1,
      refused_requests: 12,
      refused_nano_aiu: 1e9,
    },
    ...extra,
  }
}

describe("the sessions to pick from", () => {
  test("are asked for over the range, biggest 100", () => {
    expect(sessionsPath(rangeChoice("7d", NOW))).toBe(
      "/settings/api/budget/sessions?range=7d&limit=100",
    )
    expect(
      sessionsPath({ range: "custom", from: "2026-11-01", to: "2026-11-02" }),
    ).toBe(
      "/settings/api/budget/sessions?from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-03T00%3A00%3A00.000Z&limit=100",
    )
    expect(sessionsPath({ range: "custom", from: "", to: "" })).toBeNull()
  })

  test("what is picked adds up", () => {
    const sessions = [session("a", 3e9), session("b", 1e9), session("c", 2e9)]
    expect(selectionTotals(sessions, new Set(["a", "c"]))).toEqual({
      count: 2,
      requests: 20,
      nanoAiu: 5e9,
      amount: 0.05,
    })
    expect(selectionTotals(sessions, new Set())).toEqual({
      count: 0,
      requests: 0,
      nanoAiu: 0,
      amount: 0,
    })
    // An id the list no longer has (a different range) counts for nothing.
    expect(selectionTotals(sessions, new Set(["gone"])).count).toBe(0)
  })

  test("the model mix names the biggest few and counts the rest", () => {
    const mix = modelMix(session("a", 1e9))
    expect(mix.shown.map((m) => m.model)).toEqual(["a", "b", "c"])
    expect(mix.more).toBe(1)
    expect(modelMix(session("a", 1e9), 5).more).toBe(0)
    expect(modelMix(session("a", 1e9, { models: [] })).shown).toEqual([])
  })

  test("a session is at least a minute long", () => {
    expect(sessionMinutes({ duration_ms: 0 })).toBe(1)
    expect(sessionMinutes({ duration_ms: 45 * 60_000 })).toBe(45)
  })
})

describe("the suggestion request", () => {
  const week = rangeChoice("7d", NOW)

  test("picked sessions alone: the server runs the range from their first request", () => {
    expect(suggestRequest(["a", "b"], week, "auto")).toEqual({
      session_ids: ["a", "b"],
    })
    expect(suggestRequest(["a"], week, "daily-driver")).toEqual({
      session_ids: ["a"],
      persona: "daily-driver",
    })
  })

  test("none picked: all usage in the range", () => {
    expect(suggestRequest([], week, "auto")).toEqual({ range: "7d" })
    expect(suggestRequest([], rangeChoice("30d", NOW), "team")).toEqual({
      range: "30d",
      persona: "team",
    })
    expect(
      suggestRequest(
        [],
        { range: "custom", from: "2026-11-01", to: "2026-11-01" },
        "auto",
      ),
    ).toEqual({
      range: {
        from: "2026-11-01T00:00:00.000Z",
        to: "2026-11-02T00:00:00.000Z",
      },
    })
    expect(
      suggestRequest([], { range: "custom", from: "", to: "" }, "auto"),
    ).toBeNull()
  })

  test("never more sessions than the API takes", () => {
    const many = Array.from({ length: MAX_SESSIONS + 30 }, (_, i) => `s${i}`)
    expect(suggestRequest(many, week, "auto")?.session_ids).toHaveLength(
      MAX_SESSIONS,
    )
  })
})

describe("a suggested rule", () => {
  test("is added as it was sized: the amount in nano-AIU, nothing rounded again", () => {
    expect(draftToPut(rule())).toEqual({
      label: "Daily cap",
      scope: { kind: "global" },
      limit: 4_500_000_000,
      limit_reset: "daily",
      warn_at: 0.8,
      action: "block",
    })
  })

  test("opens in the editor as its form: the display amount, the reset and the warning percent", () => {
    expect(
      draftForm(
        rule({
          scope: { kind: "key", id: "codex" },
          limit: 1_250_000_000_000,
          amount: 999,
          limit_reset: "weekly",
          warn_at: 0.75,
        }),
        USD,
        "en",
      ),
    ).toEqual({
      label: "Daily cap",
      scopeKind: "key",
      scopeId: "codex",
      amount: "12.5",
      reset: "weekly",
      warnPercent: "75",
      action: "block",
    })
    expect(draftForm(rule(), USD, "de").amount).toBe("0,045")
    // The response's display amount can be stale if another window changes the
    // unit; the canonical nano-AIU amount is converted into the current unit.
    expect(draftForm(rule({ amount: 0.045 }), CREDITS, "en").amount).toBe("4.5")
    expect(
      draftForm(
        rule({ limit_reset: { follow: "copilot:premium_interactions" } }),
        USD,
        "en",
      ).reset,
    ).toBe("follow:copilot:premium_interactions")
  })

  test("the editor opens the resets it can set, and only those", () => {
    expect(editorSupportsReset("daily")).toBe(true)
    expect(editorSupportsReset("weekly")).toBe(true)
    expect(editorSupportsReset("never")).toBe(true)
    expect(
      editorSupportsReset({ follow: "copilot:premium_interactions" }),
    ).toBe(true)
    expect(editorSupportsReset({ every: { hours: 5 } })).toBe(false)
    expect(editorSupportsReset({ monthly: { day: 1 } })).toBe(false)
  })
})
