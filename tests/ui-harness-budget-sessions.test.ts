/**
 * The mock sidecar's session costs and suggested rules (scripts/ui-harness-
 * budget-sessions.ts) against the wire contract and against the real
 * implementations (src/lib/budget/reports/), fed the same requests.
 */

import { describe, expect, test } from "bun:test"

import { suggestRules } from "~/lib/budget/reports/suggest"

import {
  budgetLimitsSeed,
  createBudgetMock,
} from "../scripts/ui-harness-budget"
import { eventsFor } from "../scripts/ui-harness-budget-reports"
import { suggest } from "../scripts/ui-harness-budget-sessions"
import {
  BudgetSessionsResponse,
  BudgetSuggestResponse,
  type BudgetPersonaId,
} from "../src/lib/config/settings-types"

const BASE = "http://harness.invalid/settings/api/budget"

function get(path: string): Request {
  return new Request(`${BASE}${path}`)
}

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

type SuggestedRule = ReturnType<typeof suggestRules>["rules"][number]

/** One drafted rule from the mock against the real suggestion's, field for field. */
function expectSameRule(
  rule: BudgetSuggestResponse["limits"][number],
  expected: SuggestedRule,
): void {
  expect(rule.scope).toEqual(expected.scope)
  expect(rule.limit).toBe(expected.limitNanoAiu)
  expect(rule.limit_reset).toEqual(expected.limitReset)
  expect(rule.basis.percentile).toBe(expected.basis.percentile)
  expect(rule.basis.peak_nano_aiu).toBe(expected.basis.peakNanoAiu)
  expect(rule.basis.periods_observed).toEqual(expected.basis.periodsObserved)
  expect(rule.projection.periods_tripped).toEqual(
    expected.projection.periodsTripped,
  )
  expect(rule.projection.refused_requests).toBe(
    expected.projection.refusedRequests,
  )
}

async function sessionsOf(
  mock: ReturnType<typeof createBudgetMock>,
  query: string,
) {
  const response = await mock.handle(get(`/sessions?${query}`))
  expect(response?.status).toBe(200)
  return BudgetSessionsResponse.parse(await response?.json())
}

describe("sessions from the mock", () => {
  test("answers with the wire contract over every range, biggest spender first", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    for (const range of ["24h", "7d", "30d", "90d", "all"]) {
      const report = await sessionsOf(mock, `range=${range}&limit=500`)
      const spends = report.sessions.map((session) => session.nano_aiu)
      expect(spends).toEqual([...spends].sort((a, b) => b - a))
      // What the sessions cost is what the range cost.
      expect(report.sessions.reduce((sum, s) => sum + s.nano_aiu, 0)).toBe(
        report.totals.total_nano_aiu,
      )
    }
  })

  test("a session's model mix adds up to it, and requests without a session fall into the client's pseudo-session", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const report = await sessionsOf(mock, "range=30d&limit=500")
    for (const session of report.sessions) {
      expect(session.models.reduce((sum, m) => sum + m.nano_aiu, 0)).toBe(
        session.nano_aiu,
      )
      const shares = session.models.reduce((sum, m) => sum + m.share, 0)
      expect(shares).toBeCloseTo(session.nano_aiu === 0 ? 0 : 1, 6)
    }
    const loose = report.sessions.filter((session) => !session.attributed)
    expect(loose.length).toBeGreaterThan(0)
    expect(loose.every((session) => session.id.startsWith("other:"))).toBe(true)
    expect(report.sessions.some((session) => session.attributed)).toBe(true)
  })

  test("the limit cuts the list and not the totals", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const all = await sessionsOf(mock, "range=30d&limit=500")
    const few = await sessionsOf(mock, "range=30d&limit=3")
    expect(few.sessions).toHaveLength(3)
    expect(few.total_sessions).toBe(all.total_sessions)
    expect(few.totals).toEqual(all.totals)
    expect(few.sessions.map((s) => s.id)).toEqual(
      all.sessions.slice(0, 3).map((s) => s.id),
    )
  })

  test("a bad range is a 400", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    expect((await mock.handle(get("/sessions?range=year")))?.status).toBe(400)
  })
})

describe("suggested rules from the mock", () => {
  const personas: Array<BudgetPersonaId | undefined> = [
    undefined,
    "trying-things-out",
    "daily-driver",
    "heavy-agent-use",
    "team",
  ]

  test("answer with the wire contract, for a range and for picked sessions", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const sessions = await sessionsOf(mock, "range=30d&limit=5")
    const ids = sessions.sessions.map((session) => session.id)
    for (const persona of personas) {
      const shape = persona === undefined ? {} : { persona }
      for (const body of [
        { range: "30d", ...shape },
        { session_ids: ids, ...shape },
      ]) {
        const response = await mock.handle(post("/suggest", body))
        expect(response?.status).toBe(200)
        const suggestion = BudgetSuggestResponse.parse(await response?.json())
        expect(suggestion.persona).toBe(persona ?? null)
        expect(suggestion.limits.length).toBeGreaterThan(0)
      }
    }
  })

  test("a short history says so and suggests no weekly rule", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const response = await mock.handle(post("/suggest", { range: "7d" }))
    const suggestion = BudgetSuggestResponse.parse(await response?.json())
    expect(suggestion.notes).toContain("short_history")
    expect(suggestion.limits.map((rule) => rule.id)).not.toContain("weekly-cap")
  })

  test("nothing spent says so", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const response = await mock.handle(
      post("/suggest", { session_ids: ["no-such-session"] }),
    )
    const suggestion = BudgetSuggestResponse.parse(await response?.json())
    expect(suggestion.limits).toEqual([])
    expect(suggestion.notes).toEqual(["no_spend"])
  })

  test("an invalid body is a 400", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    expect(
      (await mock.handle(post("/suggest", { persona: "nobody" })))?.status,
    ).toBe(400)
    expect(
      (await mock.handle(post("/suggest", { session_ids: [] })))?.status,
    ).toBe(400)
  })

  test.each(personas)(
    "agree with the real suggestion on the same requests (persona %s)",
    (persona) => {
      const mock = createBudgetMock(budgetLimitsSeed)
      const context = mock.reports()
      const ids = new Set(["taken"])
      const ours = suggest(
        context,
        { range: "30d", ...(persona === undefined ? {} : { persona }) },
        ids,
      )
      if ("status" in ours) throw new Error(ours.message)
      const fromMs = Date.parse(ours.range.from)
      const toMs = Date.parse(ours.range.to)
      const rows = eventsFor(context, { kind: "global" }, fromMs, toMs).map(
        (event) => ({
          createdAtMs: event.atMs,
          nanoAiu: event.nanoAiu,
          key: event.key,
          provider: event.provider,
          model: event.model,
          ...(event.plugin === undefined ? {} : { plugin: event.plugin }),
        }),
      )
      const real = suggestRules({
        rows,
        ...(persona === undefined ? {} : { persona }),
        display: context.display,
        context: {
          fromMs,
          toMs,
          nowMs: context.nowMs,
          findWindow: context.findWindow,
        },
        existingIds: ids,
      })
      expect(ours.notes).toEqual(real.notes)
      expect(ours.limits.map((rule) => rule.id)).toEqual(
        real.rules.map((rule) => rule.id),
      )
      for (const [index, rule] of ours.limits.entries()) {
        expectSameRule(rule, real.rules[index])
      }
    },
  )
})
