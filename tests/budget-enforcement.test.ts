/**
 * Budget enforcement at the generic seams, with the real config and the
 * real service on an in-memory usage database (nothing is module-mocked):
 *
 * - a spent limit answers 402 on each wire (`billing_error` for Anthropic,
 *   `insufficient_quota` for OpenAI), never retried, naming the limit;
 * - an operation dispatch holds, commits with the provider's cost, books the
 *   estimate when the reply reports none, and releases on error;
 * - a server tool refused by a limit comes back as the tool's result.
 */

import type { OperationDispatch } from "@stuffbucket/maximal-plugin-sdk/gateway"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import type { BudgetConfig, BudgetScope } from "~/lib/budget/schema"

import { BudgetExceededError } from "~/lib/budget/errors"
import { __resetProviderWindowsForTests } from "~/lib/budget/provider-windows"
import { __resetBudgetServiceForTests, admitChat } from "~/lib/budget/runtime"
import { getConfig, writeConfig } from "~/lib/config/config"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"
import { requestContext } from "~/lib/http/request-context"
import { traceIdMiddleware } from "~/lib/http/trace"
import { state } from "~/lib/runtime-state/state"
import { closeUsageStore, recordTokenUsageEvent } from "~/lib/token-usage"
import { getNanoAiuSpend } from "~/lib/token-usage/spend"
import { createImagesRoutes } from "~/routes/images/route"
import { pluginServerToolListings } from "~/routes/messages/server-tools/plugin-listings"
import { runOperation } from "~/routes/passthrough"
import { COPILOT_PROVIDER_ID } from "~/services/copilot/upstream-request"

import { definePlugin, startTestGateway } from "./helpers/plugins"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const AIU = 1_000_000_000
const originalConfig = getConfig()
const originalState = {
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  lastRequestTimestamp: state.lastRequestTimestamp,
  manualApprove: state.manualApprove,
  models: state.models,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
}

let apiKeyLabel: string | null = null

/** Replace the budget config; the service reads it on every call. */
function setBudget(budget: BudgetConfig): void {
  writeConfig({ ...getConfig(), budget })
}

function limit(
  id: string,
  scope: BudgetScope,
  amount: number,
): NonNullable<BudgetConfig["limits"]>[number] {
  return {
    id,
    label: `Limit ${id}`,
    scope,
    limit: amount,
    limitReset: "daily",
    action: "block",
  }
}

/** A usage row, as a billed call records it. */
function spend(
  nanoAiu: number,
  endpoint: "images" | "messages" = "images",
): void {
  recordTokenUsageEvent({
    endpoint,
    model: "gpt-image-test",
    source: "copilot",
    input_tokens: 1,
    total_nano_aiu: nanoAiu,
  })
}

beforeEach(async () => {
  consola.level = 1
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  __resetBudgetServiceForTests()
  __resetProviderWindowsForTests()
  writeConfig({})
  apiKeyLabel = null
  state.copilotToken = "test-token"
  state.githubToken = "test-github-token"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  state.models = undefined
})

afterEach(async () => {
  consola.level = 3
  __resetBudgetServiceForTests()
  await closeUsageStore()
  __resetProviderWindowsForTests()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  Object.assign(state, originalState)
  writeConfig(originalConfig)
})

/** What a promise rejects with; undefined when it resolves. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

// ── 402 on each wire ──────────────────────────────────────────────────

function withKey(app: Hono): Hono {
  const outer = new Hono()
  outer.use(traceIdMiddleware)
  outer.use(async (_c, next) => {
    const store = requestContext.getStore()
    if (store) store.usage.apiKeyLabel = apiKeyLabel
    await next()
  })
  outer.route("/", app)
  return outer
}

const postJson = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

interface OpenAiBudgetError {
  error: {
    message: string
    type: string
    code: string
    metadata: Record<string, unknown>
  }
}

describe("a spent limit answers 402", () => {
  test("on the OpenAI wire: insufficient_quota, never retried, with the limit's figures", async () => {
    setBudget({
      limits: [limit("images-daily", { kind: "plugin", id: "images" }, AIU)],
    })
    spend(AIU)
    let upstreamCalls = 0
    const app = withKey(
      new Hono().route(
        "/v1/images",
        createImagesRoutes({
          operations: fakeDispatch(() => {
            upstreamCalls += 1
            return Promise.reject(new Error("must not be called"))
          }),
        }),
      ),
    )

    const response = await postJson(app, "/v1/images/generations", {
      model: "gpt-image-test",
      prompt: "a red square",
      quality: "low",
    })

    expect(response.status).toBe(402)
    expect(response.headers.get("x-should-retry")).toBe("false")
    // The reset is hours away, so the client is told how long to wait.
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0)
    const body = (await response.json()) as OpenAiBudgetError
    expect(body.error).toMatchObject({
      type: "insufficient_quota",
      code: "budget_exceeded",
      metadata: {
        limit_source: "maximal_limit",
        scope: "plugin",
        scope_id: "images",
        limit_id: "images-daily",
        limit_credits: 1,
        spend_credits: 1,
        limit_usd: 0.01,
        spend_usd: 0.01,
        limit_nano_aiu: AIU,
        spend_nano_aiu: AIU,
        remedy_hint: "Raise or remove it in Maximal → Rules.",
      },
    })
    expect(body.error.message).toContain('Maximal rule "Limit images-daily"')
    expect(body.error.message).toContain("Maximal → Rules")
    expect(body.error.metadata.resets_at).toMatch(/T00:00:00\.000Z$/u)
    expect(upstreamCalls).toBe(0)
  })

  test("on the Anthropic wire: billing_error with the figures in headers", async () => {
    setBudget({ limits: [limit("all", { kind: "global" }, AIU)] })
    spend(AIU, "messages")
    const app = withKey(
      new Hono()
        .onError(proxyErrorHandler("anthropic"))
        .post("/v1/messages", async (c) => {
          await admitChat("messages")
          return c.json({ ok: true })
        }),
    )

    const response = await postJson(app, "/v1/messages", {})

    expect(response.status).toBe(402)
    expect(response.headers.get("x-should-retry")).toBe("false")
    expect(response.headers.get("x-maximal-budget-limit-id")).toBe("all")
    expect(response.headers.get("x-maximal-budget-scope")).toBe("global")
    expect(response.headers.get("x-maximal-budget-limit")).toBe(String(AIU))
    expect(response.headers.get("x-maximal-budget-used")).toBe(String(AIU))
    const body = (await response.json()) as {
      type: string
      error: { type: string; message: string }
    }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("billing_error")
    expect(body.error.message).toContain("is used up")
  })

  test("on the OpenAI chat wire the same refusal is insufficient_quota", async () => {
    setBudget({ limits: [limit("all", { kind: "global" }, AIU)] })
    spend(AIU, "messages")
    const app = withKey(
      new Hono()
        .onError(proxyErrorHandler("openai"))
        .post("/chat/completions", async (c) => {
          await admitChat("chat_completions")
          return c.json({ ok: true })
        }),
    )

    const response = await postJson(app, "/chat/completions", {})

    expect(response.status).toBe(402)
    expect(response.headers.get("x-should-retry")).toBe("false")
    expect(response.headers.has("x-maximal-budget-limit-id")).toBe(false)
    const body = (await response.json()) as OpenAiBudgetError
    expect(body.error.type).toBe("insufficient_quota")
    expect(body.error.code).toBe("budget_exceeded")
  })

  test("only the key a limit names is refused", async () => {
    setBudget({
      limits: [limit("ci", { kind: "key", id: "ci-key" }, 0)],
    })
    const app = withKey(
      new Hono()
        .onError(proxyErrorHandler("openai"))
        .post("/chat/completions", async (c) => {
          await admitChat("chat_completions")
          return c.json({ ok: true })
        }),
    )

    apiKeyLabel = "ci-key"
    expect((await postJson(app, "/chat/completions", {})).status).toBe(402)
    apiKeyLabel = "someone-else"
    expect((await postJson(app, "/chat/completions", {})).status).toBe(200)
  })

  test("spend recorded while the app runs reaches the next check", async () => {
    setBudget({ limits: [limit("all", { kind: "global" }, AIU)] })
    await admitChat("messages")

    spend(0.4 * AIU, "messages")
    await admitChat("messages")
    spend(0.6 * AIU, "messages")

    expect(await failure(admitChat("messages"))).toBeInstanceOf(
      BudgetExceededError,
    )
  })

  test("nothing is refused when no limit is set", async () => {
    spend(100 * AIU)
    const app = withKey(
      new Hono().route(
        "/v1/images",
        createImagesRoutes({
          operations: fakeDispatch(() =>
            Promise.resolve({ json: { created: 1, data: [] } }),
          ),
        }),
      ),
    )

    const response = await postJson(app, "/v1/images/generations", {
      model: "gpt-image-test",
      prompt: "x",
    })

    expect(response.status).toBe(200)
  })
})

// ── hold, commit, release around dispatch ─────────────────────────────

const noop = (): void => {}

interface Dispatched {
  operation: string
  body: unknown
}

function fakeDispatch(
  handler: () => Promise<{
    json: Record<string, unknown>
    cost?: { unit: "nano_aiu"; amount: number; estimated: boolean }
  }>,
  seen: Array<Dispatched> = [],
): OperationDispatch {
  return {
    resolve: (_operation, model) => ({
      pluginId: "core",
      binding: { provider: COPILOT_PROVIDER_ID, upstreamModel: model },
    }),
    dispatch: async (request) => {
      seen.push({ operation: request.operation, body: request.body })
      const result = await handler()
      return {
        json: result.json,
        usage: { input_tokens: 10, output_tokens: 20 },
        ...(result.cost ? { cost: result.cost } : {}),
      }
    },
    servedModels: () => [],
    subscribe: () => noop,
  }
}

async function globalSpend(): Promise<number> {
  const [sum] = await getNanoAiuSpend({ kind: "global" }, [
    { startMs: 0, endMs: null },
  ])
  return sum
}

const imageCall = (signal = new AbortController().signal) => ({
  operation: "images.generations" as const,
  model: "gpt-image-test",
  body: { model: "gpt-image-test", prompt: "x", quality: "low" },
  signal,
})

/** What a hold would see: the limit's room, read through a second call. */
async function heldAfterwards(): Promise<number> {
  const { getBudgetService } = await import("~/lib/budget/runtime")
  return getBudgetService().heldNanoAiu({ kind: "global" })
}

describe("an operation dispatch under a limit", () => {
  beforeEach(() => {
    setBudget({ limits: [limit("all", { kind: "global" }, 10 * AIU)] })
  })

  test("holds the estimate while the call runs, then settles with the provider's cost", async () => {
    let heldDuring = 0
    const operations = fakeDispatch(async () => {
      heldDuring = await heldAfterwards()
      return {
        json: { ok: true },
        cost: { unit: "nano_aiu", amount: 0.7 * AIU, estimated: false },
      }
    })

    const json = await runOperation(operations, imageCall())

    // A low-quality generation is estimated at 0.6 AI credits.
    expect(heldDuring).toBe(0.6 * AIU)
    expect(json).toEqual({ ok: true })
    expect(await heldAfterwards()).toBe(0)
    expect(await globalSpend()).toBe(0.7 * AIU)
  })

  test("a reply with no cost is booked at the estimate", async () => {
    const operations = fakeDispatch(() => Promise.resolve({ json: { ok: 1 } }))

    await runOperation(operations, imageCall())

    expect(await globalSpend()).toBe(0.6 * AIU)
    expect(await heldAfterwards()).toBe(0)
  })

  test("an upstream error releases the hold and books nothing", async () => {
    const operations = fakeDispatch(() =>
      Promise.reject(new Error("upstream 502")),
    )

    expect(await failure(runOperation(operations, imageCall()))).toEqual(
      new Error("upstream 502"),
    )

    expect(await heldAfterwards()).toBe(0)
    expect(await globalSpend()).toBe(0)
    // The room is back: the same call is admitted again.
    const retry = fakeDispatch(() => Promise.resolve({ json: { ok: 1 } }))
    expect(await runOperation(retry, imageCall())).toEqual({ ok: 1 })
  })

  test("an abandoned call releases its hold too", async () => {
    const controller = new AbortController()
    const operations = fakeDispatch(() => {
      controller.abort()
      return Promise.reject(new DOMException("aborted", "AbortError"))
    })

    const error = await failure(
      runOperation(operations, imageCall(controller.signal)),
    )
    expect(error).toBeInstanceOf(DOMException)

    expect(await heldAfterwards()).toBe(0)
  })

  test("a refused call never reaches the provider", async () => {
    setBudget({ limits: [limit("all", { kind: "global" }, 0.5 * AIU)] })
    const seen: Array<Dispatched> = []
    const operations = fakeDispatch(
      () => Promise.resolve({ json: { ok: 1 } }),
      seen,
    )

    const error = await failure(runOperation(operations, imageCall()))

    expect(error).toBeInstanceOf(BudgetExceededError)
    expect(seen).toHaveLength(0)
    expect(await heldAfterwards()).toBe(0)
  })

  test("concurrent calls hold against each other", async () => {
    setBudget({ limits: [limit("all", { kind: "global" }, AIU)] })
    const gate = Promise.withResolvers<undefined>()
    const slow = fakeDispatch(async () => {
      await gate.promise
      return {
        json: { ok: 1 },
        cost: { unit: "nano_aiu", amount: 0.6 * AIU, estimated: false },
      }
    })

    const first = runOperation(slow, imageCall())
    while ((await heldAfterwards()) === 0) await Bun.sleep(1)
    // 1 AI credit holds one 0.6 call; the second only waits on the first.
    const second = await runOperation(slow, imageCall()).catch(
      (error: unknown) => error,
    )
    gate.resolve(undefined)

    expect(second).toBeInstanceOf(BudgetExceededError)
    if (second instanceof BudgetExceededError) {
      expect(second.refusal.inFlight).toBe(true)
    }
    expect(await first).toEqual({ ok: 1 })
    expect(await globalSpend()).toBe(0.6 * AIU)
  })

  test("an operation with no estimate (decisions) is gated on spend, not held", async () => {
    setBudget({ limits: [limit("all", { kind: "global" }, AIU)] })
    const operations = fakeDispatch(() => Promise.resolve({ json: { ok: 1 } }))
    const decisions = {
      operation: "decisions" as const,
      model: "gpt-x",
      body: { model: "gpt-x" },
      signal: new AbortController().signal,
    }

    expect(await runOperation(operations, decisions)).toEqual({ ok: 1 })
    expect(await globalSpend()).toBe(0)

    spend(AIU)
    expect(await failure(runOperation(operations, decisions))).toBeInstanceOf(
      BudgetExceededError,
    )
  })
})

function toolText(run: { toolResult: { content: unknown } }): string {
  const { content } = run.toolResult
  return typeof content === "string" ? content : JSON.stringify(content)
}

// ── a server tool refused by a limit ──────────────────────────────────

describe("a server tool under a limit", () => {
  const toolUse = {
    type: "tool_use" as const,
    id: "toolu_1",
    name: "generate_image",
    input: { prompt: "a red square" },
  }
  const call = {
    signal: new AbortController().signal,
    model: "claude-test",
    client: "claude-code",
  }
  let executed = 0
  let running: Awaited<ReturnType<typeof startTestGateway>> | undefined

  async function withImagePlugin(): Promise<
    Awaited<ReturnType<typeof startTestGateway>>
  > {
    executed = 0
    const plugin = definePlugin(
      "images-tools",
      (ctx) => {
        ctx.serverTools.register({
          name: "generate_image",
          description: "Generate an image",
          input_schema: { type: "object", properties: {} },
          render: "hidden",
          offer: "always",
          execute: () => {
            executed += 1
            return Promise.resolve({
              content: [{ type: "text", text: "saved to /tmp/a.png" }],
            })
          },
        })
      },
      { kind: "model" },
    )
    running = await startTestGateway([plugin], ["images-tools"])
    return running
  }

  afterEach(async () => {
    const gateway = running
    running = undefined
    await gateway?.dispose()
  })

  test("the refusal is the tool's result, in words the model can relay", async () => {
    const { gateway } = await withImagePlugin()
    const [listing] = pluginServerToolListings(gateway)
    expect(listing.name).toBe("generate_image")

    // With no limit the tool runs.
    const first = await listing.run(toolUse, call)
    expect(first.ok).toBe(true)
    expect(executed).toBe(1)

    // A limit with no room for the plugin refuses the call, without running it.
    setBudget({
      limits: [limit("tools", { kind: "plugin", id: "images-tools" }, 0)],
    })
    const refused = await listing.run(toolUse, call)

    expect(executed).toBe(1)
    expect(refused.ok).toBe(false)
    expect(refused.toolResult).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_1",
      is_error: true,
    })
    const text = toolText(refused)
    expect(text).toStartWith('Not run: Maximal rule "Limit tools" is used up')
    expect(text).toContain("Maximal → Rules")
    expect(text).toContain("Don't retry this tool until the rule resets")
  })

  test("a global limit refuses it as well, and the tool never runs", async () => {
    const { gateway } = await withImagePlugin()
    setBudget({ limits: [limit("all", { kind: "global" }, AIU)] })
    spend(AIU, "messages")
    const [listing] = pluginServerToolListings(gateway)

    const run = await listing.run(toolUse, call)

    expect(run.ok).toBe(false)
    expect(executed).toBe(0)
    expect(toolText(run)).toContain("is used up")
  })

  test("a tool that errors releases its hold", async () => {
    const { gateway } = await withImagePlugin()
    setBudget({ limits: [limit("all", { kind: "global" }, 10 * AIU)] })
    const [listing] = pluginServerToolListings(gateway)
    // The plugin stops between the plan and the call.
    await gateway.reconcile({})

    const run = await listing.run(toolUse, call)

    expect(run.ok).toBe(false)
    expect(executed).toBe(0)
    expect(await heldAfterwards()).toBe(0)
  })
})
