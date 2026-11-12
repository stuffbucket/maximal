/**
 * Sessions, the what-if simulation and suggestions over the real usage
 * database: sessions are joined to usage by the `session_id` every row
 * records, the simulation matches scopes the way the live limit does, and a
 * suggestion is sized from the sessions it was asked about.
 *
 * Real config and usage store (the preload gives each run a temp
 * `COPILOT_API_HOME`); nothing is module-mocked.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test"
import { Hono } from "hono"
import path from "node:path"

import { HELPER_LABEL } from "~/apps/claude-code/config"
import { __resetProviderWindowsForTests } from "~/lib/budget/provider-windows"
import { __resetBudgetServiceForTests } from "~/lib/budget/runtime"
import { writeConfig } from "~/lib/config/config"
import {
  BudgetSessionsResponse,
  BudgetSimulateResponse,
  BudgetSuggestResponse,
} from "~/lib/config/settings-types"
import { requestContext } from "~/lib/http/request-context"
import { PATHS } from "~/lib/platform/paths"
import {
  closeUsageStore,
  recordTokenUsageEvent,
  type TokenUsageEventInput,
} from "~/lib/token-usage"
import { getNanoAiuSpend } from "~/lib/token-usage/spend"
import { getSessionRows } from "~/lib/token-usage/store"
import { budgetRoutes } from "~/routes/settings/budget"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const AIU = 1_000_000_000
const at = (...parts: [number, number, number, number?, number?]): number =>
  Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] ?? 0, parts[4] ?? 0)
/** Wednesday 2026-11-11 12:00 UTC. */
const NOW = at(2026, 11, 11, 12)

function buildApp(): Hono {
  const app = new Hono()
  app.route("/budget", budgetRoutes)
  return app
}

interface Recorded {
  sessionId?: string
  /** The API key label the request came in on. */
  label?: string
  /** When the request started, before it was recorded. */
  startedBeforeMs?: number
}

/** Record a usage row as if it happened at `ms`, inside a request. */
function recordAt(
  ms: number,
  row: Partial<TokenUsageEventInput> & Recorded,
): void {
  const { label, startedBeforeMs, ...input } = row
  setSystemTime(new Date(ms))
  requestContext.run(
    {
      traceId: "t",
      startTime: ms - (startedBeforeMs ?? 0),
      userAgent: "",
      sessionAffinity: undefined,
      parentSessionId: undefined,
      usage: { apiKeyLabel: label ?? null },
    },
    () => {
      recordTokenUsageEvent({
        endpoint: "messages",
        model: "gpt-test",
        source: "copilot",
        input_tokens: 10,
        ...input,
      })
    },
  )
  setSystemTime(new Date(NOW))
}

async function json<T>(
  response: Response,
  parse: (value: unknown) => T,
): Promise<T> {
  expect(response.status).toBe(200)
  return parse(await response.json())
}

async function post(
  app: Hono,
  route: string,
  body: unknown,
): Promise<Response> {
  return app.request(`/budget/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = path.join(
    PATHS.APP_DIR,
    `sessions-${crypto.randomUUID()}.sqlite`,
  )
  await closeUsageStore()
  __resetProviderWindowsForTests()
  __resetBudgetServiceForTests()
  writeConfig({})
  setSystemTime(new Date(NOW))
})

afterEach(async () => {
  setSystemTime()
  __resetBudgetServiceForTests()
  await closeUsageStore()
  __resetProviderWindowsForTests()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

afterAll(() => {
  writeConfig({})
})

/** Two real sessions, one on a named key and one on Claude Code's, a
 *  request that carried no session, and an old session. */
function recordSessions(): void {
  recordAt(at(2026, 11, 10, 9), {
    sessionId: "s-big",
    label: "laptop",
    model: "gpt-a",
    total_nano_aiu: 3 * AIU,
    input_tokens: 100,
    output_tokens: 10,
    startedBeforeMs: 30_000,
  })
  recordAt(at(2026, 11, 10, 9, 10), {
    sessionId: "s-big",
    label: "laptop",
    model: "gpt-b",
    total_nano_aiu: AIU,
    input_tokens: 50,
  })
  recordAt(at(2026, 11, 11, 8), {
    sessionId: "s-small",
    label: HELPER_LABEL,
    model: "gpt-a",
    total_nano_aiu: AIU,
  })
  recordAt(at(2026, 11, 11, 9), {
    label: HELPER_LABEL,
    model: "gpt-a",
    total_nano_aiu: 2 * AIU,
  })
  recordAt(at(2026, 9, 1, 9), {
    sessionId: "s-old",
    label: "laptop",
    model: "gpt-a",
    total_nano_aiu: 9 * AIU,
  })
}

describe("GET /settings/api/budget/sessions", () => {
  test("what each session cost, biggest first, with its model mix", async () => {
    recordSessions()

    const body = await json(
      await buildApp().request("/budget/sessions?range=30d"),
      (v) => BudgetSessionsResponse.parse(v),
    )

    expect(body.sessions.map((s) => [s.id, s.nano_aiu])).toEqual([
      ["s-big", 4 * AIU],
      ["other:claude-code", 2 * AIU],
      ["s-small", AIU],
    ])
    expect(body.total_sessions).toBe(3)
    const big = body.sessions[0]
    expect(big).toMatchObject({
      attributed: true,
      client: "other",
      client_label: "laptop",
      key: "laptop",
      requests: 2,
      amount: 0.04,
      usage: { input_tokens: 150, output_tokens: 10, request_count: 2 },
    })
    expect(big.models).toMatchObject([
      { model: "gpt-a", requests: 1, nano_aiu: 3 * AIU, share: 0.75 },
      { model: "gpt-b", requests: 1, nano_aiu: AIU, share: 0.25 },
    ])
  })

  test("a session starts when its first request started and ends at its last record", async () => {
    recordSessions()
    const body = await json(
      await buildApp().request("/budget/sessions?range=30d"),
      (v) => BudgetSessionsResponse.parse(v),
    )
    const big = body.sessions.find((s) => s.id === "s-big")
    expect(big?.started_at).toBe(
      new Date(at(2026, 11, 10, 9) - 30_000).toISOString(),
    )
    expect(big?.ended_at).toBe(new Date(at(2026, 11, 10, 9, 10)).toISOString())
    expect(big?.duration_ms).toBe(10 * 60_000 + 30_000)
    // One request: it starts and ends at its own record.
    const small = body.sessions.find((s) => s.id === "s-small")
    expect(small?.duration_ms).toBe(0)
  })

  test("requests with no session id fold into one pseudo-session per client", async () => {
    recordSessions()
    recordAt(at(2026, 11, 11, 10), { model: "gpt-a", total_nano_aiu: AIU })
    const body = await json(
      await buildApp().request("/budget/sessions?range=7d"),
      (v) => BudgetSessionsResponse.parse(v),
    )
    const pseudo = body.sessions.filter((s) => !s.attributed)
    expect(pseudo.map((s) => s.id).sort()).toEqual([
      "other:claude-code",
      "other:other",
    ])
    // A provisioned label only repeats the client's name: no label to show.
    expect(
      pseudo.find((s) => s.id === "other:claude-code")?.client_label,
    ).toBeNull()
    expect(pseudo.find((s) => s.id === "other:claude-code")?.key).toBe(
      HELPER_LABEL,
    )
    expect(pseudo.find((s) => s.id === "other:other")?.key).toBe("unidentified")
  })

  test("is joined to usage by the same session id the Dashboard's sessions use", async () => {
    recordSessions()
    const rows = await getSessionRows(0)
    const stored = new Set(
      rows.map((row) => row.session_id).filter((id) => id !== ""),
    )
    const body = await json(
      await buildApp().request("/budget/sessions?range=all"),
      (v) => BudgetSessionsResponse.parse(v),
    )
    const reported = new Set(
      body.sessions.filter((s) => s.attributed).map((s) => s.id),
    )
    expect(reported).toEqual(stored)
    // And each session's cost is the sum of exactly its rows.
    for (const session of body.sessions.filter((s) => s.attributed)) {
      const [spent] = await getNanoAiuSpend({ kind: "global" }, [
        { startMs: 0, endMs: null },
      ])
      expect(spent).toBe(body.totals.total_nano_aiu)
      expect(session.requests).toBe(
        rows.filter((row) => row.session_id === session.id).length,
      )
    }
  })

  test("the range leaves out older sessions; totals count what the range holds", async () => {
    recordSessions()
    const app = buildApp()
    const week = await json(await app.request("/budget/sessions"), (v) =>
      BudgetSessionsResponse.parse(v),
    )
    expect(week.range.label).toBe("7d")
    expect(week.sessions.map((s) => s.id)).not.toContain("s-old")
    expect(week.totals.total_nano_aiu).toBe(7 * AIU)
    const all = await json(
      await app.request("/budget/sessions?range=all"),
      (v) => BudgetSessionsResponse.parse(v),
    )
    expect(all.sessions[0]).toMatchObject({ id: "s-old", nano_aiu: 9 * AIU })
    const custom = await json(
      await app.request(
        `/budget/sessions?from=${new Date(at(2026, 11, 11)).toISOString()}`,
      ),
      (v) => BudgetSessionsResponse.parse(v),
    )
    expect(custom.sessions.map((s) => s.id).sort()).toEqual([
      "other:claude-code",
      "s-small",
    ])
  })

  test("limit cuts the list, not the totals", async () => {
    recordSessions()
    const body = await json(
      await buildApp().request("/budget/sessions?range=30d&limit=1"),
      (v) => BudgetSessionsResponse.parse(v),
    )
    expect(body.sessions).toHaveLength(1)
    expect(body.total_sessions).toBe(3)
    expect(body.totals.total_nano_aiu).toBe(7 * AIU)
  })

  test("rejects a bad limit or range", async () => {
    const app = buildApp()
    for (const query of ["limit=0", "limit=501", "limit=x", "range=year"]) {
      expect((await app.request(`/budget/sessions?${query}`)).status).toBe(400)
    }
  })

  test("no usage is an empty list", async () => {
    const body = await json(await buildApp().request("/budget/sessions"), (v) =>
      BudgetSessionsResponse.parse(v),
    )
    expect(body.sessions).toEqual([])
    expect(body.total_sessions).toBe(0)
  })
})

/** Thirty days of spend, Oct 13 to Nov 11: the laptop key spends d AIU on day
 *  d (1 to 30) on Copilot; CI spends 5 AIU a day through the images plugin. */
function recordMonth(): void {
  for (let day = 0; day < 30; day++) {
    const dayMs = at(2026, 10, 13 + day)
    recordAt(dayMs + 3_600_000, {
      sessionId: `laptop-${day}`,
      label: "laptop",
      total_nano_aiu: (day + 1) * AIU,
    })
    recordAt(dayMs + 7_200_000, {
      sessionId: `ci-${day}`,
      label: "ci",
      endpoint: "images",
      model: "gpt-image",
      total_nano_aiu: 5 * AIU,
    })
  }
}

const dailyCap = {
  scope: { kind: "global" },
  limit_reset: "daily",
  action: "block",
}

describe("POST /settings/api/budget/simulate", () => {
  test("replays the usage through each draft, in the order given", async () => {
    recordMonth()
    const body = await json(
      await post(buildApp(), "simulate", {
        range: "30d",
        limits: [
          { ...dailyCap, id: "tight", limit: 10 * AIU },
          { ...dailyCap, id: "wide", limit: 100 * AIU },
        ],
      }),
      (v) => BudgetSimulateResponse.parse(v),
    )

    expect(body.results.map((r) => r.id)).toEqual(["tight", "wide"])
    expect(body.requests_replayed).toBe(60)
    const [tight, wide] = body.results
    expect(wide.refused_requests).toBe(0)
    expect(wide.tripped_at).toBeNull()
    // From day 10 on, the laptop's request alone reaches 10 AIU, so the CI
    // request that follows it is refused.
    expect(tight.refused_requests).toBeGreaterThan(0)
    expect(tight.tripped_at).not.toBeNull()
    expect(tight.mode).toBe("periods")
    expect(tight.periods_total).toBeGreaterThanOrEqual(30)
    expect(tight.matched_requests).toBe(60)
  })

  test("reports the peak and a suggested amount, with display amounts", async () => {
    recordMonth()
    const [result] = (
      await json(
        await post(buildApp(), "simulate", {
          range: "30d",
          limits: [{ ...dailyCap, limit: 1000 * AIU }],
        }),
        (v) => BudgetSimulateResponse.parse(v),
      )
    ).results
    // The busiest day, today: 35 AIU. Today is still open, so the p90 is of
    // the 30 complete days before it (Oct 12, quiet, then 6 to 34 AIU):
    // the 27th of them is 31 AIU.
    expect(result.peak.nano_aiu).toBe(35 * AIU)
    expect(result.suggested_nano_aiu).toBe(31 * AIU)
    expect(result.display.peak).toBeCloseTo(0.35, 12)
    expect(result.display.suggested).toBeCloseTo(0.31, 12)
    expect(result.id).toBe("draft-1")
  })

  test("a draft's amount in the display unit is converted once", async () => {
    recordMonth()
    const body = await json(
      await post(buildApp(), "simulate", {
        limits: [{ ...dailyCap, amount: 0.1 }],
      }),
      (v) => BudgetSimulateResponse.parse(v),
    )
    expect(body.results[0].limit).toBe(10 * AIU)
    expect(body.range.label).toBe("30d")
  })

  test("covers the scope the way a live limit does: by key, plugin and provider", async () => {
    recordMonth()
    const app = buildApp()
    const scopes = [
      { kind: "key", id: "laptop" },
      { kind: "key", id: "ci" },
      { kind: "plugin", id: "images" },
      { kind: "provider", id: "copilot" },
      { kind: "global" },
    ] as const
    const body = await json(
      await post(app, "simulate", {
        range: "90d",
        limits: scopes.map((scope) => ({
          scope,
          limit: 1000 * AIU,
          limit_reset: "never",
          action: "warn",
        })),
      }),
      (v) => BudgetSimulateResponse.parse(v),
    )
    // The same scopes, summed in SQL (what the live ledger loads).
    for (const [index, scope] of scopes.entries()) {
      const [spent] = await getNanoAiuSpend(scope, [
        { startMs: 0, endMs: null },
      ])
      expect(body.results[index].matched_nano_aiu).toBe(spent)
    }
    expect(body.results[0].matched_requests).toBe(30)
    expect(body.results[2].matched_requests).toBe(30)
  })

  test("a rolling draft has no periods", async () => {
    recordMonth()
    const [result] = (
      await json(
        await post(buildApp(), "simulate", {
          range: "7d",
          limits: [
            {
              ...dailyCap,
              limit: 5 * AIU,
              limit_reset: { every: { hours: 5 } },
            },
          ],
        }),
        (v) => BudgetSimulateResponse.parse(v),
      )
    ).results
    expect(result.mode).toBe("rolling")
    expect(result.periods).toEqual([])
    expect(result.periods_total).toBeNull()
    expect(result.refused_requests).toBeGreaterThan(0)
  })

  test("is deterministic and applies nothing", async () => {
    recordMonth()
    const app = buildApp()
    const request = {
      range: "30d",
      limits: [{ ...dailyCap, limit: 10 * AIU }],
    }
    const first = await (await post(app, "simulate", request)).json()
    const second = await (await post(app, "simulate", request)).json()
    expect(second).toEqual(first)
    const config = await app.request("/budget")
    expect(await config.json()).toMatchObject({ budgets: [] })
  })

  test("rejects a bad body, a duplicate id, a missing amount and a bad range", async () => {
    const app = buildApp()
    const bad: Array<unknown> = [
      null,
      {},
      { limits: [] },
      { limits: [{ ...dailyCap }] },
      { limits: [{ ...dailyCap, limit: 1, amount: 1 }] },
      {
        limits: [
          { ...dailyCap, id: "a", limit: 1 },
          { ...dailyCap, id: "a", limit: 2 },
        ],
      },
      { limits: [{ ...dailyCap, limit: 1 }], range: "year" },
      { limits: [{ ...dailyCap, limit: 1 }], range: { from: "nonsense" } },
      { limits: [{ ...dailyCap, limit: 1 }], extra: true },
      { limits: Array.from({ length: 21 }, () => ({ ...dailyCap, limit: 1 })) },
    ]
    for (const body of bad) {
      expect((await post(app, "simulate", body)).status).toBe(400)
    }
  })
})

describe("POST /settings/api/budget/simulate, scopes and edges", () => {
  test("a filter scope covers the rows its members match; an unknown filter is a 400", async () => {
    recordMonth()
    writeConfig({
      budget: {
        filters: [
          {
            id: "images-model",
            name: "Images",
            kind: "models",
            members: ["gpt-image*"],
          },
        ],
      },
    })
    const app = buildApp()
    const [result] = (
      await json(
        await post(app, "simulate", {
          range: "90d",
          limits: [
            {
              scope: { kind: "filter", id: "images-model" },
              limit: 1000 * AIU,
              limit_reset: "never",
              action: "warn",
            },
          ],
        }),
        (v) => BudgetSimulateResponse.parse(v),
      )
    ).results
    expect(result.matched_requests).toBe(30)
    expect(result.matched_nano_aiu).toBe(150 * AIU)
    const unknown = await post(app, "simulate", {
      limits: [
        {
          scope: { kind: "filter", id: "nope" },
          limit: AIU,
          limit_reset: "daily",
          action: "block",
        },
      ],
    })
    expect(unknown.status).toBe(400)
  })

  test("with no usage, nothing happens and nothing is suggested", async () => {
    const [result] = (
      await json(
        await post(buildApp(), "simulate", {
          limits: [{ ...dailyCap, limit: AIU }],
        }),
        (v) => BudgetSimulateResponse.parse(v),
      )
    ).results
    expect(result).toMatchObject({
      matched_requests: 0,
      refused_requests: 0,
      suggested_nano_aiu: null,
    })
  })

  test("range=all starts at the first recorded request", async () => {
    recordAt(at(2026, 10, 20, 8), { total_nano_aiu: AIU })
    const body = await json(
      await post(buildApp(), "simulate", {
        range: "all",
        limits: [{ ...dailyCap, limit: 10 * AIU }],
      }),
      (v) => BudgetSimulateResponse.parse(v),
    )
    expect(body.range.from).toBe(new Date(at(2026, 10, 20, 8)).toISOString())
    expect(body.results[0].periods_total).toBe(23)
  })
})

describe("POST /settings/api/budget/suggest", () => {
  test("sizes rules from the sessions it is given", async () => {
    recordMonth()
    const body = await json(
      await post(buildApp(), "suggest", {
        session_ids: Array.from({ length: 30 }, (_, d) => `laptop-${d}`),
        persona: "trying-things-out",
      }),
      (v) => BudgetSuggestResponse.parse(v),
    )

    expect(body.persona).toBe("trying-things-out")
    expect(body.sessions_considered).toBe(30)
    expect(body.requests_considered).toBe(30)
    expect(body.nano_aiu_considered).toBe(465 * AIU)
    expect(body.limits).toHaveLength(1)
    const [rule] = body.limits
    // Days spend 1..30 AIU; the last is still open, so the p90 (rank 27 of
    // 29) is 27 AIU.
    expect(rule).toMatchObject({
      id: "daily-cap",
      scope: { kind: "global" },
      limit_reset: "daily",
      limit: 27 * AIU,
      amount: 0.27,
      warn_at: 0.8,
      action: "block",
      basis: {
        percentile: 0.9,
        periods_observed: 30,
        sized_to_nano_aiu: 27 * AIU,
      },
      // One request a day: none finds the limit already reached.
      projection: { periods_total: 30, periods_tripped: 0 },
    })
  })

  test("the range runs from the sessions' first request, not from before they existed", async () => {
    recordMonth()
    recordAt(at(2026, 9, 1), { sessionId: "old", total_nano_aiu: AIU })
    const body = await json(
      await post(buildApp(), "suggest", {
        sessionIds: ["laptop-10", "laptop-11"],
        persona: "trying-things-out",
      }),
      (v) => BudgetSuggestResponse.parse(v),
    )
    // Two days only; the sessions are on Oct 23 and 24.
    expect(body.range.from).toBe(new Date(at(2026, 10, 23)).toISOString())
    expect(body.sessions_considered).toBe(2)
    expect(body.limits[0].basis.periods_observed).toBeGreaterThanOrEqual(2)
  })

  test("a range alone covers all usage in it, with the default shape", async () => {
    recordMonth()
    const body = await json(
      await post(buildApp(), "suggest", { range: "30d" }),
      (v) => BudgetSuggestResponse.parse(v),
    )
    expect(body.persona).toBeNull()
    expect(body.limits.map((l) => l.id)).toEqual([
      "daily-cap",
      "weekly-cap",
      "images-daily",
    ])
    expect(body.notes).toEqual([])
  })

  test("a team persona makes a rule per key, scoped to that key", async () => {
    recordMonth()
    const body = await json(
      await post(buildApp(), "suggest", { range: "30d", persona: "team" }),
      (v) => BudgetSuggestResponse.parse(v),
    )
    expect(body.limits.map((l) => l.scope)).toEqual([
      { kind: "key", id: "laptop" },
      { kind: "key", id: "ci" },
    ])
  })

  test("a draft avoids the ids of rules that exist", async () => {
    recordMonth()
    writeConfig({
      budget: {
        limits: [
          {
            id: "daily-cap",
            scope: { kind: "global" },
            limit: AIU,
            limitReset: "daily",
            action: "block",
          },
        ],
      },
    })
    const body = await json(
      await post(buildApp(), "suggest", {
        range: "30d",
        persona: "trying-things-out",
      }),
      (v) => BudgetSuggestResponse.parse(v),
    )
    expect(body.limits[0].id).toBe("daily-cap-2")
  })

  test("amounts follow the display unit", async () => {
    recordMonth()
    writeConfig({ budget: { display: { unit: "credits" } } })
    const body = await json(
      await post(buildApp(), "suggest", {
        range: "30d",
        persona: "trying-things-out",
      }),
      (v) => BudgetSuggestResponse.parse(v),
    )
    expect(body.display.unit).toBe("credits")
    expect(body.limits[0].amount).toBe(body.limits[0].limit / AIU)
  })

  test("a request-less pseudo-session can be named", async () => {
    recordSessions()
    const body = await json(
      await post(buildApp(), "suggest", {
        session_ids: ["other:claude-code"],
        persona: "trying-things-out",
      }),
      (v) => BudgetSuggestResponse.parse(v),
    )
    expect(body.requests_considered).toBe(1)
    expect(body.nano_aiu_considered).toBe(2 * AIU)
  })

  test("sessions that spent nothing, or don't exist, suggest nothing", async () => {
    recordMonth()
    const body = await json(
      await post(buildApp(), "suggest", { session_ids: ["no-such-session"] }),
      (v) => BudgetSuggestResponse.parse(v),
    )
    expect(body.limits).toEqual([])
    expect(body.notes).toEqual(["no_spend"])
    expect(body.requests_considered).toBe(0)
  })

  test("a short history says so and leaves out the weekly rule", async () => {
    recordSessions()
    const body = await json(
      await post(buildApp(), "suggest", { range: "7d" }),
      (v) => BudgetSuggestResponse.parse(v),
    )
    expect(body.notes).toEqual(["short_history"])
    expect(body.limits.map((l) => l.id)).toEqual(["daily-cap"])
  })

  test("rejects a bad body", async () => {
    const app = buildApp()
    const bad: Array<unknown> = [
      null,
      { persona: "yolo" },
      { session_ids: [] },
      { session_ids: [""] },
      { range: "year" },
      { range: { from: "x" } },
      { surprise: 1 },
    ]
    for (const body of bad) {
      expect((await post(app, "suggest", body)).status).toBe(400)
    }
  })
})
