/**
 * The decisions and SystemOne routes with their plugins on and off: on, the
 * route relays through the plugin and records the provider id; off, the model
 * is "not turned on" (404 `model_not_enabled`) and never reaches the upstream,
 * and `/v1/models` stops listing it. The default-on migration is covered in
 * `plugins-default-on.test.ts`.
 */

import * as decisions from "@stuffbucket/maximal-plugin-decisions"
import * as systemone from "@stuffbucket/maximal-plugin-systemone"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { setModels, state } from "~/lib/runtime-state/state"
import { closeUsageStore } from "~/lib/token-usage"
import { createDecisionsRoutes } from "~/routes/decisions/route"
import { modelRoutes } from "~/routes/models/route"
import { createSystemOneRoutes } from "~/routes/systemone/route"
import { tokenUsageRoute } from "~/routes/token-usage/route"

import { startTestGateway, type TestGateway } from "./helpers/plugins"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const originalFetch = globalThis.fetch
const originalState = {
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  manualApprove: state.manualApprove,
  models: state.models,
  rateLimitSeconds: state.rateLimitSeconds,
}

let gateway: TestGateway
let upstreamCalls: Array<string>

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  state.copilotToken = "test-token"
  state.githubToken = "test-github-token"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.models = undefined
  upstreamCalls = []
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
    input: string,
  ) => {
    upstreamCalls.push(new URL(input).pathname)
    return Promise.resolve(Response.json(replies[new URL(input).pathname]))
  }) as unknown as typeof fetch
  gateway = await startTestGateway(
    [decisions, systemone],
    ["decisions", "systemone"],
  )
})

afterEach(async () => {
  await gateway.dispose()
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  Object.assign(state, originalState)
})

const replies: Record<string, unknown> = {
  "/v1/decisions": {
    model: "gpt-6-luna",
    answers: [],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  },
  "/v1/systemone": {
    model: "dev-microsoft-decision-1.1",
    answers: {},
    usage: { input_tokens: 6, output_tokens: 1 },
  },
}

const cases = [
  {
    plugin: "decisions",
    path: "/v1/decisions",
    model: "gpt-6-luna-decisions",
    endpoint: "decisions",
    other: "systemone",
  },
  {
    plugin: "systemone",
    path: "/v1/systemone",
    model: "microsoft-decision-1",
    endpoint: "systemone",
    other: "decisions",
  },
] as const

function app(): Hono {
  const hono = new Hono()
  hono.route("/v1/decisions", createDecisionsRoutes())
  hono.route("/v1/systemone", createSystemOneRoutes())
  hono.route("/v1/models", modelRoutes)
  hono.route("/token-usage", tokenUsageRoute)
  return hono
}

async function modelIds(): Promise<Array<string>> {
  const response = await app().request("/v1/models")
  const list = (await response.json()) as { data: Array<{ id: string }> }
  return list.data.map((entry) => entry.id)
}

const post = (hono: Hono, path: string, body: unknown) =>
  hono.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

async function enabled(plugin: string, on: boolean): Promise<void> {
  const other = plugin === "decisions" ? "systemone" : "decisions"
  await gateway.gateway.reconcile({
    [plugin]: { enabled: on },
    [other]: { enabled: true },
  })
}

function catalogModel(id: string, type: string): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: id,
    model_picker_enabled: false,
    supported_endpoints: [],
    capabilities: {
      family: id,
      type,
      tokenizer: "o200k_base",
      object: "model_capabilities",
      limits: {},
      supports: {},
    },
  }
}

for (const { plugin, path, model, endpoint, other } of cases) {
  describe(`${path} with the ${plugin} plugin`, () => {
    test("on: relays through the plugin and records the provider id", async () => {
      const hono = app()

      const response = await post(hono, path, { model, input: "x" })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(replies[path])
      expect(upstreamCalls).toEqual([path])
      const events = await hono.request(
        "/token-usage/events?period=day&page=1&page_size=10",
      )
      const page = (await events.json()) as {
        items: Array<Record<string, unknown>>
      }
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({
        endpoint,
        model,
        source: "copilot",
        provider_name: "copilot",
      })
    })

    test("on: a namespaced id reaches the upstream under its own model id", async () => {
      const captured: Array<unknown> = []
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
        _input: string,
        init: RequestInit,
      ) => {
        captured.push(
          typeof init.body === "string" ? JSON.parse(init.body) : init.body,
        )
        return Promise.resolve(Response.json(replies[path]))
      }) as unknown as typeof fetch

      const response = await post(app(), path, {
        model: `copilot/${model}`,
        input: "x",
      })

      expect(response.status).toBe(200)
      expect(captured).toEqual([{ model, input: "x" }])
    })

    test("off: 404 model_not_enabled, nothing reaches the upstream, nothing is recorded", async () => {
      await enabled(plugin, false)
      const hono = app()

      const response = await post(hono, path, { model, input: "x" })

      expect(response.status).toBe(404)
      expect(response.headers.get("x-should-retry")).toBe("false")
      const body = (await response.json()) as {
        error: { type: string; code: string; message: string }
      }
      expect(body.error).toMatchObject({
        type: "invalid_request_error",
        code: "model_not_enabled",
      })
      expect(body.error.message).toContain(`\`${model}\``)
      expect(body.error.message).toContain(path)
      expect(upstreamCalls).toEqual([])
      const events = await hono.request(
        "/token-usage/events?period=day&page=1&page_size=10",
      )
      const page = (await events.json()) as { items: Array<unknown> }
      expect(page.items).toHaveLength(0)
    })

    test("off, then on again: served again", async () => {
      await enabled(plugin, false)
      await enabled(plugin, true)

      const response = await post(app(), path, { model, input: "x" })

      expect(response.status).toBe(200)
    })

    test("a model the plugin doesn't serve is a 404 too", async () => {
      const response = await post(app(), path, { model: "gpt-x" })

      expect(response.status).toBe(404)
      expect(upstreamCalls).toEqual([])
    })

    test("the other plugin's model isn't served here", async () => {
      const otherModel = cases.find((entry) => entry.plugin === other)?.model
      const response = await post(app(), path, { model: otherModel })

      expect(response.status).toBe(404)
    })

    test("/v1/models lists the model only while the plugin is on", async () => {
      setModels({
        object: "list",
        data: [
          catalogModel("gpt-6-luna-decisions", "decisions"),
          catalogModel("microsoft-decision-1", "decisions"),
          catalogModel("gpt-5.4", "chat"),
        ],
      })
      const ids = modelIds

      expect(await ids()).toEqual([
        "gpt-6-luna-decisions",
        "microsoft-decision-1",
        "gpt-5.4",
      ])

      await enabled(plugin, false)

      const remaining = await ids()
      expect(remaining).not.toContain(model)
      // The other plugin's model and chat models are untouched.
      expect(remaining).toContain(
        cases.find((entry) => entry.plugin === other)?.model ?? "",
      )
      expect(remaining).toContain("gpt-5.4")
    })
  })
}

describe("an enabled plugin whose model the account lacks", () => {
  test("the upstream's refusal gets the plan advice", async () => {
    state.models = {
      object: "list",
      data: [catalogModel("gpt-5.4", "chat")],
    }
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: "Model is not supported for this request.",
              code: "model_not_supported",
              param: "model",
              type: "invalid_request_error",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      )) as unknown as typeof fetch

    const response = await post(app(), "/v1/systemone", {
      model: "microsoft-decision-1",
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain("on your plan")
    expect(body.error.message).toContain(
      "Model is not supported for this request. [model_not_supported]",
    )
  })
})

describe("with no plugin gateway running", () => {
  test("every operation is unavailable (404), and /v1/models filters nothing", async () => {
    await gateway.dispose()
    setModels({
      object: "list",
      data: [catalogModel("gpt-6-luna-decisions", "decisions")],
    })
    const hono = app()

    const response = await post(hono, "/v1/decisions", {
      model: "gpt-6-luna-decisions",
    })
    expect(response.status).toBe(404)

    const list = (await (await hono.request("/v1/models")).json()) as {
      data: Array<{ id: string }>
    }
    expect(list.data.map((entry) => entry.id)).toEqual(["gpt-6-luna-decisions"])
  })
})
