/**
 * The ask flow end to end on the real runtime, config and usage store: a rule
 * that asks refuses, raises an attention entry and a notice; each answer
 * records the override it should; the override shows in status and expires;
 * and where each rule's warnings and limit notices go.
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
import { __resetProviderWindowsForTests } from "~/lib/budget/provider-windows"
import {
  __resetBudgetServiceForTests,
  admitChat,
  getOverrideRegistry,
} from "~/lib/budget/runtime"
import { getConfig, writeConfig } from "~/lib/config/config"
import {
  BudgetStatusResponse,
  PluginsAttentionResponse,
} from "~/lib/config/settings-types"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"
import { takePluginNotices } from "~/lib/plugins/notices"
import { closeUsageStore, recordTokenUsageEvent } from "~/lib/token-usage"
import { budgetRoutes } from "~/routes/settings/budget"
import { pluginsRoutes } from "~/routes/settings/plugins"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const AIU = 1_000_000_000
const NOON = new Date("2026-11-11T12:00:00.000Z")
const HOUR = 3_600_000

const app = new Hono()
  .route("/budget", budgetRoutes)
  .route("/plugins", pluginsRoutes)

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

async function status(): Promise<BudgetStatusResponse> {
  return BudgetStatusResponse.parse(await (await send("GET", "/budget")).json())
}

async function attention(): Promise<PluginsAttentionResponse["attention"]> {
  return PluginsAttentionResponse.parse(
    await (await send("GET", "/plugins/attention")).json(),
  ).attention
}

function putRule(
  action: "ask" | "block" | "warn",
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return send("PUT", "/budget/limits/images", {
    label: "Images",
    scope: { kind: "global" },
    limit: 4 * AIU,
    limit_reset: "daily",
    action,
    ...extra,
  })
}

function spend(nanoAiu: number): void {
  recordTokenUsageEvent({
    endpoint: "messages",
    model: "gpt-test",
    source: "copilot",
    input_tokens: 1,
    total_nano_aiu: nanoAiu,
  })
}

async function refusal(): Promise<BudgetExceededError | undefined> {
  try {
    await admitChat("messages")
    return undefined
  } catch (error) {
    if (error instanceof BudgetExceededError) return error
    throw error
  }
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  setSystemTime(NOON)
  await closeUsageStore()
  __resetProviderWindowsForTests()
  __resetBudgetServiceForTests()
  writeConfig({})
  takePluginNotices()
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

describe("a rule that asks", () => {
  test("refuses at the limit, says approval was requested, and shows in status", async () => {
    await putRule("ask")
    spend(4 * AIU)

    const error = await refusal()
    expect(error?.refusal.approval).toBe("pending")
    expect(error?.message).toContain("Approval was requested in Maximal")

    const body = await status()
    expect(body.budgets[0]).toMatchObject({
      action: "ask",
      approval: "pending",
      overrides: [],
      state: "exhausted",
      effective_limit: 4 * AIU,
    })
    expect(body.effective_budget).toBe("images")
  })

  test("raises a native notice and an attention entry, once", async () => {
    await putRule("ask")
    spend(4 * AIU)
    await refusal()
    await refusal()

    const notices = takePluginNotices()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      plugin: "budget",
      name: "Rules",
      code: "rule-ask",
      params: { rule: "images" },
    })
    expect(notices[0].message).toContain('Rule "Images" reached its limit')

    const items = await attention()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ plugin: "budget", name: "Rules" })
    expect(items[0].actions.map((action) => action.id)).toEqual([
      "allow-more.ask.images",
      "allow-hour.ask.images",
      "keep-blocked.ask.images",
    ])
    expect(items[0].actions[0].label).toBe("Allow $0.01 more: Images")
  })

  test("Allow more, through the tray's route: the next calls pass up to the new limit", async () => {
    await putRule("ask")
    spend(4 * AIU)
    await refusal()

    const run = await send(
      "POST",
      "/plugins/budget/actions/allow-more.ask.images",
    )
    expect(run.status).toBe(202)
    expect(await run.json()).toEqual({ ok: true })

    // A quarter of 4 AIU more: 5 AIU in force, and nothing waits any more.
    expect(await refusal()).toBeUndefined()
    expect(await attention()).toEqual([])
    spend(AIU)
    const after = await refusal()
    expect(after?.refusal.limit).toBe(5 * AIU)
    // Spent again: asked again.
    expect(after?.refusal.approval).toBe("pending")

    const body = await status()
    expect(body.budgets[0]).toMatchObject({
      limit: 4 * AIU,
      effective_limit: 5 * AIU,
      limit_remaining: 0,
      approval: "pending",
    })
    expect(body.budgets[0].overrides).toEqual([
      {
        id: expect.any(String) as string,
        kind: "extra",
        extra_nano_aiu: AIU,
        extra: 0.01,
        created_at: NOON.toISOString(),
        // The end of the day it was granted in.
        expires_at: "2026-11-12T00:00:00.000Z",
      },
    ])
  })

  test("Allow for 1 hour lifts the limit for exactly an hour", async () => {
    await putRule("ask")
    spend(10 * AIU)
    await refusal()

    expect(
      (await send("POST", "/budget/attention/allow-hour.ask.images")).status,
    ).toBe(202)
    expect(await refusal()).toBeUndefined()
    const body = await status()
    expect(body.budgets[0].state).toBe("ok")
    expect(body.budgets[0].overrides[0]).toMatchObject({
      kind: "unlimited",
      extra_nano_aiu: 0,
      expires_at: new Date(NOON.getTime() + HOUR).toISOString(),
    })
    // An allowed rule isn't the one a request would hit.
    expect(body.effective_budget).toBeNull()

    setSystemTime(new Date(NOON.getTime() + HOUR - 1))
    expect(await refusal()).toBeUndefined()
    setSystemTime(new Date(NOON.getTime() + HOUR))
    expect(await refusal()).toBeInstanceOf(BudgetExceededError)
    expect((await status()).budgets[0].overrides).toEqual([])
  })

  test("Keep blocked leaves it refusing, stops asking, and asks again next period", async () => {
    await putRule("ask")
    spend(4 * AIU)
    await refusal()
    takePluginNotices()

    expect(
      (await send("POST", "/plugins/budget/actions/keep-blocked.ask.images"))
        .status,
    ).toBe(202)
    const error = await refusal()
    expect(error?.refusal.approval).toBe("declined")
    expect(error?.message).not.toContain("Approval was requested")
    expect(takePluginNotices()).toEqual([])
    expect(await attention()).toEqual([])
    expect((await status()).budgets[0].approval).toBe("declined")
    expect((await status()).budgets[0].overrides).toEqual([])

    // Tomorrow: a new day, a new ask (spend is counted per day).
    setSystemTime(new Date("2026-11-12T09:00:00.000Z"))
    spend(4 * AIU)
    expect((await refusal())?.refusal.approval).toBe("pending")
    expect(takePluginNotices()).toHaveLength(1)
  })

  test("a stale action answers 404, and does nothing", async () => {
    await putRule("ask")
    for (const path of [
      "/plugins/budget/actions/allow-more.ask.images",
      "/budget/attention/allow-more.ask.images",
      "/plugins/budget/actions/nonsense",
    ]) {
      const response = await send("POST", path)
      expect(response.status).toBe(404)
    }
    expect(getOverrideRegistry().list(Date.now())).toEqual([])
  })

  test("is also listed beside a plugin's own attention source id, never shadowing a plugin", async () => {
    // With no plugin gateway the endpoint still answers with the core's.
    expect(await attention()).toEqual([])
  })
})

const approve = (body: unknown, id = "images") =>
  send("POST", `/budget/limits/${id}/approve`, body)

describe("POST /settings/api/budget/limits/:id/approve", () => {
  test("more records extra room: the default, nano-AIU or the display unit", async () => {
    await putRule("block")
    for (const [body, nano] of [
      [{ choice: "more" }, AIU],
      [{ choice: "more", extra: 3 * AIU }, 3 * AIU],
      [{ choice: "more", amount: 0.05 }, 5 * AIU],
    ] as const) {
      const response = await approve(body)
      expect(response.status).toBe(200)
      const overrides = BudgetStatusResponse.parse(await response.json())
        .budgets[0].overrides
      expect(overrides.at(-1)?.extra_nano_aiu).toBe(nano)
    }
    expect((await status()).budgets[0].effective_limit).toBe(13 * AIU)
  })

  test("hour lifts the limit; both are available before any request asked", async () => {
    await putRule("block")
    const response = await approve({ choice: "hour" })
    expect(response.status).toBe(200)
    expect(
      BudgetStatusResponse.parse(await response.json()).budgets[0].overrides[0]
        .kind,
    ).toBe("unlimited")
  })

  test("keep needs a request that is waiting", async () => {
    await putRule("ask")
    const none = await approve({ choice: "keep" })
    expect(none.status).toBe(409)
    expect(await none.json()).toEqual({
      error: {
        type: "nothing_asked",
        message: "Rule 'images' has no request waiting to keep blocked",
      },
    })

    spend(4 * AIU)
    await refusal()
    expect((await approve({ choice: "keep" })).status).toBe(200)
    expect((await status()).budgets[0].approval).toBe("declined")
  })

  test("an unknown rule is a 404; a bad id or body is a 400", async () => {
    expect((await approve({ choice: "more" }, "ghost")).status).toBe(404)
    expect((await approve({ choice: "more" }, "Bad Id")).status).toBe(400)
    await putRule("block")
    for (const body of [
      {},
      { choice: "pause" },
      { choice: "hour", extra: 1 },
      { choice: "keep", amount: 1 },
      { choice: "more", extra: 1, amount: 1 },
      { choice: "more", amount: 0 },
      { choice: "more", extra: 0 },
      { choice: "more", extra: -1 },
      { choice: "more", extra: 1.5 },
      { choice: "more", surprise: true },
      "text",
    ]) {
      expect((await approve(body)).status).toBe(400)
    }
    const unparsable = await app.request("/budget/limits/images/approve", {
      method: "POST",
      body: "{",
    })
    expect(unparsable.status).toBe(400)
    expect(getOverrideRegistry().list(Date.now())).toEqual([])
  })

  test("the amount is read in the display unit", async () => {
    writeConfig({ budget: { display: { unit: "credits" } } })
    await putRule("block")
    const response = await approve({ choice: "more", amount: 2 })
    expect(
      BudgetStatusResponse.parse(await response.json()).budgets[0].overrides[0]
        .extra_nano_aiu,
    ).toBe(2 * AIU)
  })
})

describe("ending an approval", () => {
  test("DELETE /overrides/:id removes it; an unknown id is a 404", async () => {
    await putRule("block")
    await send("POST", "/budget/limits/images/approve", { choice: "hour" })
    const [override] = (await status()).budgets[0].overrides

    const gone = await send("DELETE", `/budget/overrides/${override.id}`)
    expect(gone.status).toBe(200)
    expect(
      BudgetStatusResponse.parse(await gone.json()).budgets[0].overrides,
    ).toEqual([])
    const again = await send("DELETE", `/budget/overrides/${override.id}`)
    expect(again.status).toBe(404)
    expect(await again.json()).toEqual({
      error: { type: "not_found", message: "Budget override not found" },
    })
  })

  test("deleting a rule takes its overrides with it", async () => {
    await putRule("block")
    await send("POST", "/budget/limits/images/approve", { choice: "hour" })
    expect(getOverrideRegistry().list(Date.now())).toHaveLength(1)
    await send("DELETE", "/budget/limits/images")
    expect(getOverrideRegistry().list(Date.now())).toEqual([])
  })

  test("an override survives replacing the rule", async () => {
    await putRule("block")
    await send("POST", "/budget/limits/images/approve", { choice: "hour" })
    await putRule("block", { limit: 8 * AIU })
    expect((await status()).budgets[0].overrides).toHaveLength(1)
  })
})

describe("where a rule's notices go", () => {
  test("a block rule's first refusal notifies and lists by default", async () => {
    await putRule("block")
    spend(4 * AIU)
    await refusal()
    await refusal()
    expect(takePluginNotices().map((n) => n.code)).toEqual(["rule-limit"])
    const items = await attention()
    expect(items).toHaveLength(1)
    expect(items[0].actions).toEqual([
      { id: "dismiss.limit.images", label: "Dismiss: Images" },
    ])

    expect(
      (await send("POST", "/plugins/budget/actions/dismiss.limit.images"))
        .status,
    ).toBe(202)
    expect(await attention()).toEqual([])
    // Dismissed means seen: the same period doesn't raise it again.
    await refusal()
    expect(takePluginNotices()).toEqual([])
  })

  test.each([
    ["none", 0, 0],
    ["notification", 1, 0],
    ["tray", 0, 1],
    ["both", 1, 1],
  ] as const)("notify.limit %s", async (channel, notices, items) => {
    await putRule("block", { notify: { limit: channel } })
    spend(4 * AIU)
    await refusal()
    expect(takePluginNotices()).toHaveLength(notices)
    expect(await attention()).toHaveLength(items)
    expect((await status()).budgets[0].notify).toEqual({
      warn: "notification",
      limit: channel,
    })
  })

  test.each([
    ["none", 0, 0],
    ["notification", 1, 0],
    ["tray", 0, 1],
    ["both", 1, 1],
  ] as const)("notify.warn %s", async (channel, notices, items) => {
    await putRule("block", { notify: { warn: channel } })
    // 80% of 4 AIU.
    spend(3.2 * AIU)
    expect(await refusal()).toBeUndefined()
    const sent = takePluginNotices()
    expect(sent).toHaveLength(notices)
    if (notices > 0) expect(sent[0].code).toBe("rule-warning")
    expect(await attention()).toHaveLength(items)
  })

  test("the default is a notification for a warning and both for the limit", async () => {
    await putRule("warn")
    expect((await status()).budgets[0].notify).toEqual({
      warn: "notification",
      limit: "both",
    })
    spend(3.2 * AIU)
    await refusal()
    expect(takePluginNotices().map((n) => n.code)).toEqual(["rule-warning"])
    expect(await attention()).toEqual([])
  })

  test("a warn-only rule never reaches its limit", async () => {
    await putRule("warn")
    spend(10 * AIU)
    expect(await refusal()).toBeUndefined()
    expect(takePluginNotices().map((n) => n.code)).toEqual(["rule-warning"])
  })

  test("PUT keeps the notify choice in config.json, and replaces it", async () => {
    await putRule("ask", { notify: { warn: "tray", limit: "none" } })
    expect(getConfig().budget?.limits?.[0].notify).toEqual({
      warn: "tray",
      limit: "none",
    })
    await putRule("ask")
    expect(getConfig().budget?.limits?.[0].notify).toBeUndefined()
    expect(
      (
        await send("PUT", "/budget/limits/images", {
          scope: { kind: "global" },
          limit: AIU,
          limit_reset: "daily",
          action: "ask",
          notify: { warn: "loud" },
        })
      ).status,
    ).toBe(400)
  })

  test("a rule that was deleted leaves no entry behind", async () => {
    await putRule("ask")
    spend(4 * AIU)
    await refusal()
    expect(await attention()).toHaveLength(1)
    await send("DELETE", "/budget/limits/images")
    expect(await attention()).toEqual([])
  })
})

async function respond(wire: "anthropic" | "openai"): Promise<Response> {
  const handler = new Hono()
    .onError(proxyErrorHandler(wire))
    .post("/", async (c) => {
      await admitChat("messages")
      return c.json({ ok: true })
    })
  return handler.request("/", { method: "POST" })
}

describe("the 402 an ask rule sends", () => {
  test("says approval is pending in the headers and metadata", async () => {
    await putRule("ask")
    spend(4 * AIU)

    const anthropic = await respond("anthropic")
    expect(anthropic.status).toBe(402)
    expect(anthropic.headers.get("x-maximal-budget-approval")).toBe("pending")

    const openai = await respond("openai")
    const body = (await openai.json()) as {
      error: { metadata: Record<string, unknown> }
    }
    expect(body.error.metadata).toMatchObject({
      approval: "pending",
      remedy_hint: "Allow more in the Maximal menu or Rules, then retry.",
    })
  })

  test("a block rule's 402 carries no approval", async () => {
    await putRule("block")
    spend(4 * AIU)
    const anthropic = await respond("anthropic")
    expect(anthropic.headers.has("x-maximal-budget-approval")).toBe(false)
    const body = (await (await respond("openai")).json()) as {
      error: { metadata: Record<string, unknown> }
    }
    expect(body.error.metadata).not.toHaveProperty("approval")
    expect(body.error.metadata.remedy_hint).toBe(
      "Raise or remove it in Maximal → Rules.",
    )
  })

  test("once declined, the 402 says so", async () => {
    await putRule("ask")
    spend(4 * AIU)
    await refusal()
    await send("POST", "/budget/limits/images/approve", { choice: "keep" })
    const body = (await (await respond("openai")).json()) as {
      error: { metadata: Record<string, unknown> }
    }
    expect(body.error.metadata).toMatchObject({
      approval: "declined",
      remedy_hint: "Raise or remove it in Maximal → Rules.",
    })
  })
})
