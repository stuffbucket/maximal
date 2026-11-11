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
import { getConfig, writeConfig } from "~/lib/config/config"
import { BudgetStatusResponse } from "~/lib/config/settings-types"
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
  writeConfig({})
})

afterEach(async () => {
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
