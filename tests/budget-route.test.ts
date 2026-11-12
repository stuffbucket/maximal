/**
 * /settings/api/budget — status and limit CRUD.
 *
 * Uses the REAL config module (the test preload points COPILOT_API_HOME at a
 * temp dir) and the real token-usage store on an in-memory database; nothing
 * is module-mocked.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { Hono } from "hono"

import { createAuthMiddleware } from "~/lib/auth/request-auth"
import { __resetProviderWindowsForTests } from "~/lib/budget/provider-windows"
import {
  __resetBudgetServiceForTests,
  getBudgetService,
} from "~/lib/budget/runtime"
import { getConfig, writeConfig } from "~/lib/config/config"
import {
  BudgetActivityResponse,
  BudgetStatusResponse,
} from "~/lib/config/settings-types"
import { closeUsageStore, recordTokenUsageEvent } from "~/lib/token-usage"
import { settingsApiRoutes } from "~/routes/settings/api"
import { budgetRoutes } from "~/routes/settings/budget"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const AIU = 1_000_000_000

function buildApp(): Hono {
  const app = new Hono()
  app.route("/budget", budgetRoutes)
  return app
}

async function put(app: Hono, id: string, body: unknown): Promise<Response> {
  return app.request(`/budget/limits/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

async function status(response: Response): Promise<BudgetStatusResponse> {
  const parsed = BudgetStatusResponse.safeParse(await response.json())
  if (!parsed.success) throw new Error(parsed.error.message)
  return parsed.data
}

const images = {
  label: "Images",
  scope: { kind: "plugin", id: "images" },
  limit: 30 * AIU,
  limit_reset: "daily",
  action: "block",
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  __resetProviderWindowsForTests()
  __resetBudgetServiceForTests()
  writeConfig({})
})

afterEach(async () => {
  __resetBudgetServiceForTests()
  await closeUsageStore()
  __resetProviderWindowsForTests()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

afterAll(() => {
  writeConfig({})
})

describe("GET /settings/api/budget", () => {
  test("with no limits: empty, USD, storage on", async () => {
    const response = await buildApp().request("/budget")
    expect(response.status).toBe(200)
    expect(await status(response)).toEqual({
      enabled: true,
      display: { unit: "usd", credit_usd: 0.01 },
      storage_enabled: true,
      budgets: [],
      effective_budget: null,
      provider_windows: [],
    })
  })

  test("is gated by the API key like every /settings/api route", async () => {
    const app = new Hono()
    app.use(
      "*",
      createAuthMiddleware({
        getApiKeys: () => ["test-key-123"],
        isEnforcing: () => true,
        requireAuthPrefixes: ["/settings/api"],
      }),
    )
    app.route("/settings/api", settingsApiRoutes)
    expect((await app.request("/settings/api/budget")).status).toBe(401)
    const authed = await app.request("/settings/api/budget", {
      headers: { "x-api-key": "test-key-123" },
    })
    expect(authed.status).toBe(200)
  })
})

describe("PUT /settings/api/budget/limits/:id", () => {
  test("creates, then replaces, a limit in config.json", async () => {
    const app = buildApp()
    recordTokenUsageEvent({
      endpoint: "images",
      input_tokens: 1,
      model: "gpt-image-test",
      source: "copilot",
      total_nano_aiu: 6 * AIU,
    })

    const created = await put(app, "images-daily", images)
    expect(created.status).toBe(200)
    const body = await status(created)
    expect(body.budgets).toHaveLength(1)
    expect(body.budgets[0]).toMatchObject({
      id: "images-daily",
      label: "Images",
      limit: 30 * AIU,
      usage: 6 * AIU,
      warn_at: 0.8,
      state: "ok",
    })
    expect(body.budgets[0].display.limit).toBeCloseTo(0.3, 12)
    expect(getConfig().budget?.limits).toEqual([
      {
        id: "images-daily",
        label: "Images",
        scope: { kind: "plugin", id: "images" },
        limit: 30 * AIU,
        limitReset: "daily",
        warnAt: 0.8,
        action: "block",
      },
    ])

    const replaced = await put(app, "images-daily", {
      scope: { kind: "plugin", id: "images" },
      limit: 5 * AIU,
      limit_reset: { follow: "copilot:premium_interactions" },
      warn_at: 0.5,
      action: "warn",
    })
    expect(replaced.status).toBe(200)
    const limits = getConfig().budget?.limits ?? []
    expect(limits).toHaveLength(1)
    expect(limits[0]).toEqual({
      id: "images-daily",
      scope: { kind: "plugin", id: "images" },
      limit: 5 * AIU,
      limitReset: { follow: "copilot:premium_interactions" },
      warnAt: 0.5,
      action: "warn",
    })
    expect((await status(replaced)).budgets[0].state).toBe("exhausted")
  })

  test("an amount in the display unit is stored as nano-AIU", async () => {
    const app = buildApp()
    const { limit: _limit, ...withoutLimit } = images
    await put(app, "in-usd", { ...withoutLimit, amount: 3 })
    writeConfig({
      ...getConfig(),
      budget: { ...getConfig().budget, display: { unit: "credits" } },
    })
    await put(app, "in-credits", { ...withoutLimit, amount: 3 })
    writeConfig({
      ...getConfig(),
      budget: { ...getConfig().budget, display: { creditUsd: 0.02 } },
    })
    await put(app, "in-usd-override", { ...withoutLimit, amount: 3 })
    const stored = new Map(
      (getConfig().budget?.limits ?? []).map((limit) => [
        limit.id,
        limit.limit,
      ]),
    )
    expect(stored.get("in-usd")).toBe(300 * AIU)
    expect(stored.get("in-credits")).toBe(3 * AIU)
    expect(stored.get("in-usd-override")).toBe(150 * AIU)
  })

  test("rejects bad ids and bodies without touching config", async () => {
    const app = buildApp()
    const { limit: _limit, ...withoutLimit } = images
    const invalid: Array<[string, unknown]> = [
      ["Not_A_Slug", images],
      ["ok", "not json"],
      ["ok", { ...images, scope: { kind: "plugin" } }],
      ["ok", { ...images, scope: { kind: "model", id: "gpt" } }],
      ["ok", { ...images, limit: -1 }],
      ["ok", { ...images, limit: 1.5 }],
      ["ok", withoutLimit],
      ["ok", { ...images, amount: 3 }],
      ["ok", { ...withoutLimit, amount: -3 }],
      ["ok", { ...withoutLimit, amount: 1e300 }],
      ["ok", { ...images, limit_reset: "monthly" }],
      ["ok", { ...images, limit_reset: { follow: "copilot" } }],
      ["ok", { ...images, warn_at: 1.5 }],
      ["ok", { ...images, action: "throttle" }],
      ["ok", { ...images, limitReset: "daily" }],
    ]
    for (const [id, body] of invalid) {
      const response = await put(app, id, body)
      expect(response.status).toBe(400)
      const error = (await response.json()) as { error: { type: string } }
      expect(error.error.type).toBe("validation_error")
    }
    expect(getConfig().budget).toBeUndefined()
  })
})

describe("DELETE /settings/api/budget/limits/:id", () => {
  test("removes the limit and replies with the status", async () => {
    const app = buildApp()
    await put(app, "images-daily", images)
    await put(app, "everything", {
      scope: { kind: "global" },
      limit: 100 * AIU,
      limit_reset: "never",
      action: "warn",
    })
    const response = await app.request("/budget/limits/images-daily", {
      method: "DELETE",
    })
    expect(response.status).toBe(200)
    expect((await status(response)).budgets.map((entry) => entry.id)).toEqual([
      "everything",
    ])
    expect(getConfig().budget?.limits?.map((limit) => limit.id)).toEqual([
      "everything",
    ])
  })

  test("404s for an unknown limit", async () => {
    const response = await buildApp().request("/budget/limits/nope", {
      method: "DELETE",
    })
    expect(response.status).toBe(404)
  })
})

describe("what calls in progress hold", () => {
  test("shows on the limit's status until the call settles", async () => {
    const app = buildApp()
    await put(app, "images-daily", images)
    const decision = await getBudgetService().reserve({
      operation: "images.generations",
      key: "unidentified",
      provider: "copilot",
      plugin: "images",
      estimateNanoAiu: 0.6 * AIU,
    })
    if (!decision.ok) throw new Error("expected admission")

    const during = await status(await app.request("/budget"))
    decision.hold.commit()
    const after = await status(await app.request("/budget"))

    expect(during.budgets[0].held).toBe(0.6 * AIU)
    expect(after.budgets[0].held).toBe(0)
  })
})

async function patch(app: Hono, body: unknown): Promise<Response> {
  return app.request("/budget", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("PATCH /settings/api/budget", () => {
  test("switches enforcement off and on, keeping the limits", async () => {
    const app = buildApp()
    await put(app, "images-daily", images)

    const off = await status(await patch(app, { enabled: false }))
    expect(off.enabled).toBe(false)
    expect(off.budgets).toHaveLength(1)
    expect(getConfig().budget?.enabled).toBe(false)

    const on = await status(await patch(app, { enabled: true }))
    expect(on.enabled).toBe(true)
  })

  test("changes the display unit and nothing else", async () => {
    const app = buildApp()
    await put(app, "images-daily", images)

    const body = await status(await patch(app, { display_unit: "credits" }))

    expect(body.display.unit).toBe("credits")
    expect(body.budgets[0].limit).toBe(30 * AIU)
    expect(body.budgets[0].display.limit).toBe(30)
    expect(getConfig().budget?.limits).toHaveLength(1)
  })

  test("rejects an empty or unknown body without touching config", async () => {
    const app = buildApp()
    expect((await patch(app, {})).status).toBe(400)
    expect((await patch(app, { enabled: "yes" })).status).toBe(400)
    expect((await patch(app, { limits: [] })).status).toBe(400)
    expect(getConfig().budget).toBeUndefined()
  })
})

function record(
  model: string,
  nanoAiu: number,
  extra: { endpoint?: "images" | "messages" } = {},
): void {
  recordTokenUsageEvent({
    endpoint: extra.endpoint ?? "messages",
    model,
    input_tokens: 1,
    source: "copilot",
    total_nano_aiu: nanoAiu,
  })
}

describe("GET /settings/api/budget/activity", () => {
  test("groups spend by model, biggest first, leaving out what spent nothing", async () => {
    const app = buildApp()
    record("gpt-small", AIU)
    record("gpt-big", 2 * AIU)
    record("gpt-big", AIU)
    record("gpt-free", 0)

    const response = await app.request(
      "/budget/activity?period=day&group=model",
    )

    expect(response.status).toBe(200)
    const body = BudgetActivityResponse.parse(await response.json())
    expect(body.period).toBe("day")
    expect(body.group).toBe("model")
    expect(body.display).toEqual({ unit: "usd", credit_usd: 0.01 })
    expect(body.rows).toMatchObject([
      { key: "gpt-big", nano_aiu: 3 * AIU, requests: 2, amount: 0.03 },
      { key: "gpt-small", nano_aiu: AIU, requests: 1, amount: 0.01 },
    ])
  })

  test("groups by plugin, key, provider and day", async () => {
    const app = buildApp()
    record("gpt-image-test", AIU, { endpoint: "images" })
    record("gpt-chat", 2 * AIU)

    const get = async (group: string) =>
      BudgetActivityResponse.parse(
        await (await app.request(`/budget/activity?group=${group}`)).json(),
      ).rows

    expect(await get("plugin")).toMatchObject([
      { key: null, nano_aiu: 2 * AIU, requests: 1, amount: 0.02 },
      { key: "images", nano_aiu: AIU, requests: 1, amount: 0.01 },
    ])
    expect((await get("key")).map((row) => row.key)).toEqual(["unidentified"])
    expect((await get("provider")).map((row) => row.key)).toEqual(["copilot"])
    const [today] = await get("day")
    expect(today.key).toBe(new Date().toISOString().slice(0, 10))
    expect(today.nano_aiu).toBe(3 * AIU)
  })

  test("a week and a month cover today's rows; the period starts at 00:00 UTC", async () => {
    const app = buildApp()
    record("gpt-big", AIU)

    for (const period of ["week", "month"]) {
      const body = BudgetActivityResponse.parse(
        await (await app.request(`/budget/activity?period=${period}`)).json(),
      )
      expect(body.rows).toHaveLength(1)
      expect(body.period_start).toMatch(/T00:00:00\.000Z$/u)
    }
  })

  test("rejects an unknown period or group", async () => {
    const app = buildApp()
    expect((await app.request("/budget/activity?period=year")).status).toBe(400)
    expect((await app.request("/budget/activity?group=color")).status).toBe(400)
  })

  test("the CSV has the same rows, in the display unit, with commas quoted", async () => {
    const app = buildApp()
    record("gpt, big", 2 * AIU)
    record("gpt-small", AIU)

    const response = await app.request(
      "/budget/activity.csv?period=day&group=model",
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/csv")
    expect(response.headers.get("content-disposition")).toContain(
      "maximal-budget-model-day.csv",
    )
    expect(await response.text()).toBe(
      [
        "model,nano_aiu,requests,amount_usd,input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,total_tokens",
        `"gpt, big",${2 * AIU},1,0.02,1,0,0,0,1`,
        `gpt-small,${AIU},1,0.01,1,0,0,0,1`,
        "",
      ].join("\n"),
    )
  })
})

describe("rolling and monthly resets over the API", () => {
  test("a rolling or monthly limit is stored and reported as given", async () => {
    const app = buildApp()
    const rolling = await put(app, "agents", {
      ...images,
      limit_reset: { every: { hours: 5 } },
    })
    expect(rolling.status).toBe(200)
    const monthly = await put(app, "monthly", {
      ...images,
      limit_reset: { monthly: { day: 15 } },
    })
    const body = await status(monthly)
    const byId = new Map(body.budgets.map((entry) => [entry.id, entry]))
    expect(byId.get("agents")?.limit_reset).toEqual({ every: { hours: 5 } })
    expect(byId.get("monthly")?.limit_reset).toEqual({ monthly: { day: 15 } })
    expect(getConfig().budget?.limits?.map((l) => l.limitReset)).toEqual([
      { every: { hours: 5 } },
      { monthly: { day: 15 } },
    ])
  })

  test("an out-of-range window is a 400", async () => {
    const app = buildApp()
    for (const limit_reset of [
      { every: { hours: 0 } },
      { every: { hours: 721 } },
      { monthly: { day: 29 } },
    ]) {
      const response = await put(app, "bad", { ...images, limit_reset })
      expect(response.status).toBe(400)
    }
  })
})
