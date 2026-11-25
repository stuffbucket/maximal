/**
 * The mock sidecar's timeline and what-if replay (scripts/ui-harness-budget-
 * reports.ts) against the wire contract and against the real implementations
 * (src/lib/budget/reports/), fed the same requests, so the harness and
 * Storybook can't drift from what the app will show.
 */

import { describe, expect, test } from "bun:test"

import {
  replayStartMs,
  simulateDraft,
  type DraftLimit,
} from "~/lib/budget/reports/simulate"
import { periodsInRange } from "~/lib/budget/reports/timeline"
import { computeTimeline } from "~/lib/budget/reports/timeline"

import {
  budgetLimitsSeed,
  createBudgetMock,
} from "../scripts/ui-harness-budget"
import {
  type ReportLimit,
  eventsFor,
  simulateDraft as mockSimulate,
  periodsInRange as mockPeriods,
  buildTimeline,
} from "../scripts/ui-harness-budget-reports"
import {
  BudgetSimulateResponse,
  BudgetTimelineResponse,
} from "../src/lib/config/settings-types"

const BASE = "http://harness.invalid/settings/api/budget"
const DAY = 86_400_000

const iso = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString()

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

describe("a rule's timeline from the mock", () => {
  test("every seeded rule answers every range with the wire contract", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    for (const limit of mock.status().budgets) {
      for (const range of ["24h", "7d", "30d", "90d", "all"] as const) {
        const response = await mock.handle(
          get(`/limits/${limit.id}/timeline?range=${range}`),
        )
        expect(response?.status).toBe(200)
        const timeline = BudgetTimelineResponse.parse(await response?.json())
        expect(timeline.limit.id).toBe(limit.id)
        expect(timeline.range.label).toBe(range)
        // A bucket never straddles a reset: each sits inside one period.
        for (const bucket of timeline.buckets) {
          expect(bucket.start < bucket.end).toBe(true)
        }
      }
    }
  })

  test("a spent blocking rule shows crossing, refusals and the totals that add up", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const response = await mock.handle(
      get("/limits/key-codex-weekly/timeline?range=30d"),
    )
    const timeline = BudgetTimelineResponse.parse(await response?.json())
    expect(timeline.totals.periods_crossed).toBeGreaterThan(0)
    expect(timeline.totals.refused).toBeGreaterThan(0)
    const kinds = new Set(timeline.markers.map((marker) => marker.kind))
    expect(kinds.has("crossed")).toBe(true)
    expect(kinds.has("refused")).toBe(true)
    // Refusals are counted per bucket and in the markers alike.
    const marked = timeline.markers
      .filter((marker) => marker.kind === "refused")
      .reduce((sum, marker) => sum + (marker.count ?? 0), 0)
    expect(marked).toBe(timeline.totals.refused)
    expect(timeline.totals.nano_aiu).toBe(
      timeline.buckets.reduce((sum, bucket) => sum + bucket.nano_aiu, 0),
    )
  })

  test("an unknown rule is a 404, a bad range or bucket a 400", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    expect((await mock.handle(get("/limits/nope/timeline")))?.status).toBe(404)
    expect(
      (await mock.handle(get("/limits/everything/timeline?range=year")))
        ?.status,
    ).toBe(400)
    expect(
      (await mock.handle(get("/limits/everything/timeline?bucket=minute")))
        ?.status,
    ).toBe(400)
  })

  test("a warn-only rule agrees with the real timeline, bucket for bucket", () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const context = mock.reports()
    const limit: ReportLimit = {
      id: "daily-warn",
      scope: { kind: "key", id: "claude-code" },
      limit: 120_000_000_000,
      limitReset: "daily",
      warnAt: 0.8,
      action: "warn",
    }
    const timeline = buildTimeline(context, limit, { range: "7d" })
    if ("status" in timeline) throw new Error(timeline.message)
    const fromMs = Date.parse(timeline.range.from)
    const toMs = Date.parse(timeline.range.to)
    const periods = periodsInRange(limit.limitReset, context.findWindow, {
      fromMs,
      toMs,
      nowMs: context.nowMs,
    })
    expect(periods.map((p) => p.startMs)).toEqual(
      mockPeriods(limit.limitReset, context.findWindow, {
        fromMs,
        toMs,
        nowMs: context.nowMs,
      }).map((p) => p.startMs),
    )
    const real = computeTimeline({
      limitNanoAiu: limit.limit,
      warnAt: limit.warnAt,
      bucket: timeline.range.bucket,
      fromMs: Date.parse(timeline.range.from),
      toMs,
      periods,
      rows: eventsFor(
        context,
        limit.scope,
        periods[0]?.startMs ?? fromMs,
        toMs,
      ).map((event) => ({ createdAtMs: event.atMs, nanoAiu: event.nanoAiu })),
      refusals: [],
    })
    expect(timeline.buckets.map((b) => b.cumulative_nano_aiu)).toEqual(
      real.buckets.map((b) => b.cumulativeNanoAiu),
    )
    expect(timeline.buckets.map((b) => b.nano_aiu)).toEqual(
      real.buckets.map((b) => b.nanoAiu),
    )
    expect(timeline.periods.map((p) => p.crossed_at)).toEqual(
      real.periods.map((p) =>
        p.crossedAtMs === null ? null : new Date(p.crossedAtMs).toISOString(),
      ),
    )
    expect(timeline.markers.filter((m) => m.kind === "warned").length).toBe(
      real.markers.filter((m) => m.kind === "warned").length,
    )
  })
})

describe("what-if from the mock", () => {
  const draftBody = {
    scope: { kind: "key", id: "codex" },
    amount: 5,
    limit_reset: "daily",
    action: "block",
  }

  test("answers a draft with the wire contract, over any range", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    for (const range of ["7d", "30d", "90d", "all"] as const) {
      const response = await mock.handle(
        post("/simulate", { limits: [draftBody], range }),
      )
      expect(response?.status).toBe(200)
      const answer = BudgetSimulateResponse.parse(await response?.json())
      expect(answer.results).toHaveLength(1)
      expect(answer.range.label).toBe(range)
    }
    // The default is 30 days, and a custom range works.
    const bare = await mock.handle(post("/simulate", { limits: [draftBody] }))
    expect(BudgetSimulateResponse.parse(await bare?.json()).range.label).toBe(
      "30d",
    )
  })

  test("a smaller cap refuses more and suggests a figure that fits", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const ask = async (amount: number) => {
      const response = await mock.handle(
        post("/simulate", {
          limits: [{ ...draftBody, amount }],
          range: "30d",
        }),
      )
      return BudgetSimulateResponse.parse(await response?.json()).results[0]
    }
    const tight = await ask(0.5)
    const loose = await ask(500)
    expect(tight.refused_requests).toBeGreaterThan(0)
    expect(tight.tripped_at).not.toBeNull()
    expect(loose.refused_requests).toBe(0)
    expect(loose.tripped_at).toBeNull()
    // The suggestion doesn't depend on the amount asked about.
    expect(tight.suggested_nano_aiu).toBe(loose.suggested_nano_aiu ?? -1)
    expect(tight.suggested_nano_aiu ?? 0).toBeGreaterThan(0)
  })

  test("a warn-only draft refuses nothing but still times the limit", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const response = await mock.handle(
      post("/simulate", {
        limits: [{ ...draftBody, amount: 0.5, action: "warn" }],
        range: "30d",
      }),
    )
    const result = BudgetSimulateResponse.parse(await response?.json())
      .results[0]
    expect(result.refused_requests).toBe(0)
    expect(result.tripped_at).not.toBeNull()
  })

  test("an invalid body is a 400", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    expect((await mock.handle(post("/simulate", { limits: [] })))?.status).toBe(
      400,
    )
    expect(
      (
        await mock.handle(
          post("/simulate", { limits: [draftBody], range: "century" }),
        )
      )?.status,
    ).toBe(400)
  })

  test.each([
    { name: "daily block", reset: "daily", action: "block", limit: 3e9 },
    { name: "daily warn", reset: "daily", action: "warn", limit: 4e10 },
    { name: "weekly block", reset: "weekly", action: "block", limit: 2e11 },
    { name: "never", reset: "never", action: "block", limit: 5e11 },
    {
      name: "rolling 5 h",
      reset: { every: { hours: 5 } },
      action: "block",
      limit: 3e10,
    },
  ] as const)(
    "$name agrees with the real replay on the same requests",
    ({ reset, action, limit }) => {
      const mock = createBudgetMock(budgetLimitsSeed)
      const context = mock.reports()
      const draft: DraftLimit & ReportLimit = {
        id: "draft",
        scope: { kind: "global" },
        limit,
        limitReset: reset,
        warnAt: 0.8,
        action,
      }
      const window = { fromMs: context.nowMs - 30 * DAY, toMs: context.nowMs }
      const simulationContext = {
        ...window,
        nowMs: context.nowMs,
        findWindow: context.findWindow,
      }
      const rows = eventsFor(
        context,
        draft.scope,
        replayStartMs(draft, simulationContext),
        window.toMs,
      ).map((event) => ({
        createdAtMs: event.atMs,
        nanoAiu: event.nanoAiu,
        key: event.key,
        provider: event.provider,
        model: event.model,
        ...(event.plugin === undefined ? {} : { plugin: event.plugin }),
      }))
      const real = simulateDraft(draft, rows, simulationContext)
      const mocked = mockSimulate(context, draft, window)
      expect(mocked.matched_requests).toBe(real.matchedRequests)
      expect(mocked.matched_nano_aiu).toBe(real.matchedNanoAiu)
      expect(mocked.refused_requests).toBe(real.refusedRequests)
      expect(mocked.refused_nano_aiu).toBe(real.refusedNanoAiu)
      expect(mocked.warned_at).toBe(iso(real.warnedAtMs))
      expect(mocked.tripped_at).toBe(iso(real.trippedAtMs))
      expect(mocked.peak.nano_aiu).toBe(real.peakNanoAiu)
      expect(mocked.suggested_nano_aiu).toBe(real.suggestedNanoAiu)
      expect(mocked.periods_total).toBe(real.periodsTotal)
      expect(mocked.periods_tripped).toBe(real.periodsTripped)
      expect(mocked.mode).toBe(real.mode)
    },
  )
})
