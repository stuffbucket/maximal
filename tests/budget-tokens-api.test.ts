/**
 * Token limits, request caps and conditions over the API: status, PUT, the
 * 402, the timeline, rules export and import, the chat gate's token estimate
 * and the rolling-minutes period.
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

import { BudgetExceededError } from "~/lib/budget/errors"
import { everyDurationMs, resolvePeriod } from "~/lib/budget/periods"
import { buildBudgetPresets } from "~/lib/budget/presets"
import { __resetProviderWindowsForTests } from "~/lib/budget/provider-windows"
import { buildLimitTimeline } from "~/lib/budget/reports/timeline"
import { exportRules, planImport } from "~/lib/budget/rules"
import { __resetBudgetServiceForTests, admitChat } from "~/lib/budget/runtime"
import { buildBudgetStatus } from "~/lib/budget/status"
import { getConfig, writeConfig } from "~/lib/config/config"
import {
  BudgetStatusResponse,
  BudgetTimelineResponse,
} from "~/lib/config/settings-types"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"
import { __resetPresenceForTests, recordPresence } from "~/lib/presence"
import { closeUsageStore, recordTokenUsageEvent } from "~/lib/token-usage"
import { budgetRoutes } from "~/routes/settings/budget"

const SQLITE_ENV = "COPILOT_API_SQLITE_DB_PATH"
const NOON = new Date("2026-11-11T12:00:00.000Z")
const AIU = 1_000_000_000
const MINUTE = 60_000

const app = new Hono().route("/budget", budgetRoutes)

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/budget${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

async function status(): Promise<BudgetStatusResponse> {
  return BudgetStatusResponse.parse(await (await send("GET", "")).json())
}

function putRule(
  body: Record<string, unknown>,
  id = "guard",
): Promise<Response> {
  return send("PUT", `/limits/${id}`, {
    scope: { kind: "global" },
    limit_reset: { every: { hours: 1 } },
    action: "block",
    ...body,
  })
}

function spend(input: number, output: number, nanoAiu = 0): void {
  recordTokenUsageEvent({
    endpoint: "messages",
    model: "gpt-test",
    source: "copilot",
    input_tokens: input,
    output_tokens: output,
    total_nano_aiu: nanoAiu,
  })
}

beforeEach(async () => {
  process.env[SQLITE_ENV] = ":memory:"
  setSystemTime(NOON)
  await closeUsageStore()
  __resetProviderWindowsForTests()
  __resetBudgetServiceForTests()
  __resetPresenceForTests()
  writeConfig({})
})

afterEach(async () => {
  setSystemTime()
  __resetBudgetServiceForTests()
  __resetPresenceForTests()
  await closeUsageStore()
  __resetProviderWindowsForTests()
  Reflect.deleteProperty(process.env, SQLITE_ENV)
})

afterAll(() => {
  writeConfig({})
})

describe("PUT /limits/:id with tokens, requests and a condition", () => {
  test("stores a token limit whose amount is a count of tokens, from limit or amount", async () => {
    const response = await putRule({
      unit: "tokens",
      measure: "output",
      amount: 2_000_000,
      max_requests: 120,
      when: { locked: true, idleMinutes: 30 },
    })
    expect(response.status).toBe(200)
    expect(getConfig().budget?.limits?.[0]).toMatchObject({
      id: "guard",
      limit: 2_000_000,
      unit: "tokens",
      measure: "output",
      maxRequests: 120,
      when: { locked: true, idleMinutes: 30 },
      limitReset: { every: { hours: 1 } },
    })
    await putRule({ unit: "tokens", limit: 5_000 }, "second")
    expect(getConfig().budget?.limits?.[1].limit).toBe(5_000)
    // A cost rule stores none of it.
    await putRule({ limit: AIU }, "cost")
    const cost = getConfig().budget?.limits?.find((l) => l.id === "cost")
    expect(cost).not.toHaveProperty("unit")
    expect(cost).not.toHaveProperty("maxRequests")
    expect(cost).not.toHaveProperty("when")
  })

  test("a fractional token amount is rounded; cost still converts the display unit", async () => {
    await putRule({ unit: "tokens", amount: 1000.6 })
    expect(getConfig().budget?.limits?.[0].limit).toBe(1001)
    await putRule({ amount: 5 }, "usd")
    expect(getConfig().budget?.limits?.find((l) => l.id === "usd")?.limit).toBe(
      500 * AIU,
    )
  })

  test("a measure without tokens, an empty condition or a bad cap is a 400", async () => {
    for (const body of [
      { limit: 1, measure: "input" },
      { limit: 1, unit: "cost", measure: "input" },
      { limit: 1, when: {} },
      { limit: 1, when: { idleMinutes: 0 } },
      { limit: 1, max_requests: 0 },
      { limit: 1, unit: "bytes" },
      { limit: 1, unit: "tokens", measure: "all" },
    ]) {
      expect((await putRule(body)).status).toBe(400)
    }
    expect(getConfig().budget?.limits ?? []).toEqual([])
  })

  test("accepts the new reset minutes", async () => {
    expect(
      (await putRule({ limit: AIU, limit_reset: { every: { minutes: 10 } } }))
        .status,
    ).toBe(200)
    expect(
      (await putRule({ limit: AIU, limit_reset: { every: { minutes: 0 } } }))
        .status,
    ).toBe(400)
  })
})

describe("status for a token limit", () => {
  test("amounts are tokens everywhere, held included, display too", async () => {
    await putRule({ unit: "tokens", measure: "total", limit: 1000 })
    spend(300, 100)
    const body = await status()
    expect(body.budgets[0]).toMatchObject({
      unit: "tokens",
      measure: "total",
      limit: 1000,
      effective_limit: 1000,
      usage: 400,
      usage_daily: 400,
      usage_weekly: 400,
      limit_remaining: 600,
      held: 0,
      max_requests: null,
      requests: null,
      when: null,
      enforced: true,
      state: "ok",
      display: {
        limit: 1000,
        effective_limit: 1000,
        usage: 400,
        limit_remaining: 600,
      },
    })
  })

  test("a cost limit says so, with no measure", async () => {
    await putRule({ limit: AIU })
    expect((await status()).budgets[0]).toMatchObject({
      unit: "cost",
      measure: null,
      max_requests: null,
    })
  })

  test("state follows the tokens: warning at warn_at, exhausted at the limit", async () => {
    await putRule({ unit: "tokens", limit: 1000, warn_at: 0.5 })
    spend(499, 0)
    expect((await status()).budgets[0].state).toBe("ok")
    spend(1, 0)
    expect((await status()).budgets[0].state).toBe("warning")
    spend(500, 0)
    expect((await status()).budgets[0].state).toBe("exhausted")
  })

  test("a request cap reports the count and drives the state", async () => {
    await putRule({
      unit: "tokens",
      limit: 1_000_000,
      max_requests: 4,
      warn_at: 0.5,
    })
    spend(1, 0)
    spend(1, 0)
    let budget = (await status()).budgets[0]
    expect(budget).toMatchObject({
      max_requests: 4,
      requests: 2,
      state: "warning",
    })
    spend(1, 0)
    spend(1, 0)
    budget = (await status()).budgets[0]
    expect(budget).toMatchObject({ requests: 4, state: "exhausted" })
  })

  test("a rolling window reads the trailing window's tokens and when they age out", async () => {
    await putRule({
      unit: "tokens",
      limit: 1000,
      limit_reset: { every: { minutes: 10 } },
    })
    setSystemTime(new Date(NOON.getTime() - 11 * MINUTE))
    spend(900, 0)
    setSystemTime(new Date(NOON.getTime() - 4 * MINUTE))
    spend(100, 0)
    setSystemTime(NOON)
    const budget = (await status()).budgets[0]
    expect(budget).toMatchObject({
      usage: 100,
      resets_at: new Date(NOON.getTime() + 6 * MINUTE).toISOString(),
    })
  })

  test("a conditional rule is counted but not enforced until the person is away", async () => {
    await putRule({ limit: AIU, when: { locked: true } })
    expect((await status()).budgets[0]).toMatchObject({
      when: { locked: true },
      enforced: false,
    })
    recordPresence({ locked: true, idleSeconds: 0, at: NOON.toISOString() })
    expect((await status()).budgets[0].enforced).toBe(true)
    recordPresence({ locked: false, idleSeconds: 3, at: NOON.toISOString() })
    expect((await status()).budgets[0].enforced).toBe(false)
  })

  test("the effective budget skips a rule that isn't enforced, and weighs units by share left", async () => {
    await putRule({ limit: AIU, when: { locked: true } }, "away")
    await putRule({ unit: "tokens", limit: 1000 }, "tokens")
    await putRule({ limit: 8 * AIU, limit_reset: "daily" }, "cost")
    spend(750, 0, 3 * AIU)
    // `away` is spent but sits out; tokens have 25% left, cost 62%.
    const unattended = await status()
    expect(unattended.budgets.find((b) => b.id === "away")?.state).toBe(
      "exhausted",
    )
    expect(unattended.effective_budget).toBe("tokens")
    // Locked, the spent rule is the one a request would hit.
    recordPresence({ locked: true, idleSeconds: 0, at: NOON.toISOString() })
    expect((await status()).effective_budget).toBe("away")
  })

  test("buildBudgetStatus takes presence as given", async () => {
    const budget = {
      limits: [
        {
          id: "away",
          scope: { kind: "global" as const },
          limit: AIU,
          limitReset: "daily" as const,
          action: "block" as const,
          when: { idleMinutes: 5 },
        },
      ],
    }
    const options = { nowMs: NOON.getTime(), windows: [] }
    expect((await buildBudgetStatus(budget, options)).budgets[0].enforced).toBe(
      false,
    )
    expect(
      (
        await buildBudgetStatus(budget, {
          ...options,
          presence: { locked: false, idleSeconds: 300 },
        })
      ).budgets[0].enforced,
    ).toBe(true)
  })
})

async function respond(
  wire: "anthropic" | "openai",
  maxTokens?: number,
): Promise<Response> {
  const handler = new Hono()
    .onError(proxyErrorHandler(wire))
    .post("/", async (c) => {
      await admitChat("messages", { maxTokens })
      return c.json({ ok: true })
    })
  return handler.request("/", { method: "POST" })
}

describe("the 402 for tokens and requests", () => {
  test("a token limit's metadata has the unit and plain figures, not dollars", async () => {
    await putRule({ unit: "tokens", measure: "total", limit: 1000 })
    spend(600, 400)
    const anthropic = await respond("anthropic")
    expect(anthropic.status).toBe(402)
    expect(anthropic.headers.get("x-maximal-budget-unit")).toBe("total_tokens")
    expect(anthropic.headers.get("x-maximal-budget-limit")).toBe("1000")
    expect(anthropic.headers.get("x-maximal-budget-used")).toBe("1000")

    const openai = (await (await respond("openai")).json()) as {
      error: { message: string; metadata: Record<string, unknown> }
    }
    expect(openai.error.metadata).toMatchObject({
      limit_id: "guard",
      unit: "total_tokens",
      limit: 1000,
      spend: 1000,
      requested: 0,
    })
    expect(openai.error.metadata).not.toHaveProperty("limit_usd")
    expect(openai.error.metadata).not.toHaveProperty("limit_nano_aiu")
    expect(openai.error.message).toContain("1k tokens of 1k tokens used")
  })

  test("a cost limit's metadata keeps its names and adds the unit", async () => {
    await putRule({ limit: AIU })
    spend(1, 1, AIU)
    const openai = (await (await respond("openai")).json()) as {
      error: { metadata: Record<string, unknown> }
    }
    expect(openai.error.metadata).toMatchObject({
      unit: "nano_aiu",
      limit_usd: 0.01,
      limit_nano_aiu: AIU,
    })
  })

  test("a request cap's metadata counts requests", async () => {
    await putRule({ unit: "tokens", limit: 1_000_000, max_requests: 2 })
    spend(1, 0)
    spend(1, 0)
    const openai = (await (await respond("openai")).json()) as {
      error: { message: string; metadata: Record<string, unknown> }
    }
    expect(openai.error.metadata).toMatchObject({
      unit: "requests",
      limit: 2,
      spend: 2,
      requested: 1,
    })
    expect(openai.error.message).toContain("it has made 2 of its 2 requests")
  })

  test("the request's max_tokens is held against an output limit", async () => {
    await putRule({ unit: "tokens", measure: "output", limit: 1000 })
    spend(0, 900)
    expect((await respond("openai", 100)).status).toBe(200)
    expect((await respond("openai", 101)).status).toBe(402)
    // No max_tokens, or none that counts: gated on what is recorded.
    expect((await respond("openai")).status).toBe(200)
    for (const odd of [0, -5, Number.NaN]) {
      expect((await respond("openai", odd)).status).toBe(200)
    }
  })

  test("a rule that applies only while away refuses only then", async () => {
    await putRule({ limit: AIU, when: { locked: true } })
    spend(1, 1, 2 * AIU)
    expect((await respond("openai")).status).toBe(200)
    recordPresence({ locked: true, idleSeconds: 0, at: NOON.toISOString() })
    expect((await respond("openai")).status).toBe(402)
    recordPresence({ locked: false, idleSeconds: 0, at: NOON.toISOString() })
    expect((await respond("openai")).status).toBe(200)
  })

  test("the chat gate throws a BudgetExceededError carrying the unit", async () => {
    await putRule({ unit: "tokens", limit: 10 })
    spend(10, 0)
    let caught: unknown
    try {
      await admitChat("messages")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BudgetExceededError)
    expect((caught as BudgetExceededError).refusal.unit).toBe("total_tokens")
  })
})

describe("rolling minutes", () => {
  test("a window of N minutes is N minutes long", () => {
    expect(everyDurationMs({ minutes: 10 })).toBe(600_000)
    expect(everyDurationMs({ minutes: 1 })).toBe(60_000)
    const period = resolvePeriod(
      { every: { minutes: 10 } },
      NOON.getTime(),
      () => undefined,
    )
    expect(period.rollingMs).toBe(600_000)
    expect(period.startMs).toBe(NOON.getTime() - 600_000 + 1)
  })
})

describe("timeline of a token limit", () => {
  test("replays tokens and reads figures as they are", async () => {
    const config = {
      limits: [
        {
          id: "guard",
          scope: { kind: "global" as const },
          limit: 1000,
          limitReset: "daily" as const,
          warnAt: 0.8,
          action: "block" as const,
          unit: "tokens" as const,
        },
      ],
    }
    writeConfig({ budget: config })
    setSystemTime(new Date("2026-11-11T08:30:00Z"))
    spend(500, 0)
    setSystemTime(new Date("2026-11-11T09:30:00Z"))
    spend(400, 200)
    setSystemTime(NOON)
    const timeline = BudgetTimelineResponse.parse(
      await buildLimitTimeline({
        limit: config.limits[0],
        config,
        range: {
          fromMs: Date.parse("2026-11-11T08:00:00Z"),
          toMs: Date.parse("2026-11-11T11:00:00Z"),
          label: "custom",
        },
        bucket: "hour",
        nowMs: NOON.getTime(),
        findWindow: () => undefined,
      }),
    )
    expect(timeline.limit).toMatchObject({
      limit: 1000,
      warn_line: 800,
      display: { limit: 1000, warn_line: 800 },
    })
    expect(timeline.buckets.map((b) => b.nano_aiu)).toEqual([500, 600, 0])
    expect(timeline.buckets.map((b) => b.cumulative_nano_aiu)).toEqual([
      500, 1100, 1100,
    ])
    expect(timeline.totals.nano_aiu).toBe(1100)
  })
})

describe("rules documents", () => {
  const tokenRule = {
    id: "runaway",
    scope: { kind: "global" as const },
    limit: 2_000_000,
    limitReset: { every: { hours: 1 } } as const,
    warnAt: 0.8,
    action: "block" as const,
    unit: "tokens" as const,
    maxRequests: 100,
    when: { locked: true as const, idleMinutes: 30 },
  }
  const budget = { limits: [tokenRule] }

  test("export writes the unit, measure, cap and condition, and only for those that need it", () => {
    const [rule] = exportRules(budget).limits
    expect(rule).toMatchObject({
      unit: "tokens",
      measure: "total",
      max_requests: 100,
      when: { locked: true, idleMinutes: 30 },
    })
    const plain = exportRules({
      limits: [
        {
          ...tokenRule,
          id: "p",
          unit: undefined,
          maxRequests: undefined,
          when: undefined,
        },
      ],
    }).limits[0]
    for (const key of ["unit", "measure", "max_requests", "when"]) {
      expect(plain).not.toHaveProperty(key)
    }
  })

  test("an export imports back to no change, with or without the explicit measure", () => {
    const document = exportRules(budget)
    const same = planImport(budget, { rules: document, mode: "replace" })
    expect(same.ok && same.diff.limits.unchanged).toEqual(["runaway"])
    const [rule] = document.limits
    const withoutMeasure = {
      ...document,
      limits: [{ ...rule, measure: undefined }],
    }
    const again = planImport(budget, { rules: withoutMeasure, mode: "merge" })
    expect(again.ok && again.diff.limits.unchanged).toEqual(["runaway"])
  })

  test("import stores token fields on a new rule, and a different measure is a change", () => {
    const document = exportRules(budget)
    const output = {
      ...document,
      limits: [{ ...document.limits[0], measure: "output" as const }],
    }
    const changed = planImport(budget, { rules: output, mode: "merge" })
    expect(changed.ok && changed.diff.limits.changed).toHaveLength(1)
    const fresh = planImport(undefined, { rules: output, mode: "merge" })
    expect(fresh.ok && fresh.next.limits[0]).toMatchObject({
      unit: "tokens",
      measure: "output",
      maxRequests: 100,
      when: { locked: true, idleMinutes: 30 },
    })
  })

  test("a measure without tokens, a bad cap or condition is refused", () => {
    const document = exportRules(budget)
    for (const patch of [
      { unit: undefined, measure: "input" },
      { max_requests: 0 },
      { when: {} },
      { when: { locked: false } },
    ]) {
      const rules = {
        ...document,
        limits: [{ ...document.limits[0], ...patch }],
      }
      const plan = planImport(undefined, { rules, mode: "merge" })
      expect(plan.ok).toBe(false)
    }
  })
})

describe("presets for tokens, requests and conditions", () => {
  const presets = buildBudgetPresets({
    display: { unit: "usd", creditUsd: 0.01 },
    windows: [],
    keyLabels: [],
  })
  const persona = (id: string) => presets.personas.find((p) => p.id === id)

  test("the runaway guard is tokens, whatever the display unit", () => {
    expect(persona("runaway-guard")?.label).toBe(
      "Runaway guard: 2M tokens per rolling hour",
    )
    expect(persona("runaway-guard")?.limits[0]).toEqual({
      id: "runaway-tokens",
      label: "Runaway guard",
      scope: { kind: "global" },
      unit: "tokens",
      limit: 2_000_000,
      amount: 2_000_000,
      limit_reset: { every: { hours: 1 } },
      warn_at: 0.8,
      action: "block",
    })
    const credits = buildBudgetPresets({
      display: { unit: "credits", creditUsd: 0.02 },
      windows: [],
      keyLabels: [],
    })
    expect(
      credits.personas.find((p) => p.id === "runaway-guard")?.limits[0],
    ).toMatchObject({
      limit: 2_000_000,
      amount: 2_000_000,
    })
  })

  test("the away guard carries its condition and is a cost rule", () => {
    expect(persona("while-away")?.limits[0]).toMatchObject({
      when: { locked: true, idleMinutes: 30 },
      limit: 1000 * AIU,
      limit_reset: { every: { hours: 1 } },
    })
    expect(persona("while-away")?.limits[0]).not.toHaveProperty("unit")
  })

  test("the fan-out guard is a short window with a request cap", () => {
    expect(persona("fan-out-guard")?.limits[0]).toMatchObject({
      unit: "tokens",
      limit: 500_000,
      max_requests: 120,
      limit_reset: { every: { minutes: 10 } },
    })
  })
})
