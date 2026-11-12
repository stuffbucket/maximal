/**
 * The pass-through routes dispatch through an `OperationDispatch`: a model the
 * registry can't resolve is a 404 in OpenAI's format (never reaching the
 * upstream), and a served one is recorded against the provider that served it.
 */

import type {
  ModelOperation,
  OperationDispatch,
  OperationRequest,
  OperationResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { state } from "~/lib/runtime-state/state"
import { closeUsageStore } from "~/lib/token-usage"
import { createDecisionsRoutes } from "~/routes/decisions/route"
import { createImagesRoutes } from "~/routes/images/route"
import { createSystemOneRoutes } from "~/routes/systemone/route"
import { tokenUsageRoute } from "~/routes/token-usage/route"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

const originalState = {
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  manualApprove: state.manualApprove,
  rateLimitSeconds: state.rateLimitSeconds,
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  state.copilotToken = "test-token"
  state.githubToken = "test-github-token"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
})

afterEach(async () => {
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  Object.assign(state, originalState)
})

const noUnsubscribe = (): void => {}

interface FakeDispatch extends OperationDispatch {
  dispatched: Array<Omit<OperationRequest, "binding">>
}

/** A dispatch serving only `served` (operation → model), through `provider`. */
function fakeDispatch(
  served: Partial<Record<ModelOperation, string>>,
  provider = "acme",
  result: OperationResult = { json: { ok: true }, usage: { input_tokens: 3 } },
): FakeDispatch {
  const dispatched: FakeDispatch["dispatched"] = []
  return {
    dispatched,
    resolve: (operation, model) =>
      served[operation] === model ?
        { pluginId: "fake", binding: { provider, upstreamModel: model } }
      : undefined,
    dispatch: (request) => {
      dispatched.push(request)
      return Promise.resolve(result)
    },
    servedModels: () => [],
    subscribe: () => noUnsubscribe,
  }
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

function appWith(operations: OperationDispatch): Hono {
  const app = new Hono()
  app.route("/v1/images", createImagesRoutes({ operations }))
  app.route("/v1/decisions", createDecisionsRoutes({ operations }))
  app.route("/v1/systemone", createSystemOneRoutes({ operations }))
  app.route("/token-usage", tokenUsageRoute)
  return app
}

describe("an operation the registry can't resolve", () => {
  const paths = [
    "/v1/images/generations",
    "/v1/images/edits",
    "/v1/decisions",
    "/v1/systemone",
  ]

  for (const path of paths) {
    test(`${path} answers 404 model_not_enabled and never dispatches`, async () => {
      const operations = fakeDispatch({})
      const app = appWith(operations)

      const response = await post(app, path, { model: "gone-model" })

      expect(response.status).toBe(404)
      expect(response.headers.get("x-should-retry")).toBe("false")
      const body = (await response.json()) as {
        error: { type: string; code: string; message: string }
      }
      expect(body.error.type).toBe("invalid_request_error")
      expect(body.error.code).toBe("model_not_enabled")
      expect(body.error.message).toContain("`gone-model`")
      expect(body.error.message).toContain(path)
      expect(operations.dispatched).toEqual([])
    })
  }

  test("a multipart edit for an unserved model is a 404 too", async () => {
    const operations = fakeDispatch({})
    const form = new FormData()
    form.append("model", "gone-model")
    form.append("prompt", "x")

    const response = await appWith(operations).request("/v1/images/edits", {
      method: "POST",
      body: form,
    })

    expect(response.status).toBe(404)
    expect(operations.dispatched).toEqual([])
  })

  test("a missing model is unserved too", async () => {
    const response = await post(appWith(fakeDispatch({})), "/v1/decisions", {})
    expect(response.status).toBe(404)
  })

  test("is refused before approval is asked for", async () => {
    state.manualApprove = true
    // With approval on, an admitted request would block waiting for the user;
    // a 404 must come back without asking.
    const response = await post(appWith(fakeDispatch({})), "/v1/systemone", {
      model: "gone-model",
    })
    expect(response.status).toBe(404)
  })
})

describe("an operation the registry serves", () => {
  test("dispatches the parsed body and records usage against the serving provider", async () => {
    const operations = fakeDispatch({ decisions: "served-model" }, "acme", {
      json: { answers: [] },
      usage: { input_tokens: 7, output_tokens: 2 },
      cost: { unit: "nano_aiu", amount: 42, estimated: false },
    })
    const app = appWith(operations)
    const payload = { model: "served-model", questions: [] }

    const response = await post(app, "/v1/decisions", payload)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ answers: [] })
    expect(operations.dispatched).toHaveLength(1)
    expect(operations.dispatched[0]).toMatchObject({
      operation: "decisions",
      model: "served-model",
      body: payload,
      origin: { kind: "http" },
    })
    const events = await app.request(
      "/token-usage/events?period=day&page=1&page_size=10",
    )
    const page = (await events.json()) as {
      items: Array<Record<string, unknown>>
    }
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      endpoint: "decisions",
      model: "served-model",
      source: "provider",
      provider_name: "acme",
      input_tokens: 7,
      output_tokens: 2,
    })
  })

  test("records Copilot-served calls as source copilot with the provider id", async () => {
    const app = appWith(fakeDispatch({ systemone: "m" }, "copilot"))

    await post(app, "/v1/systemone", { model: "m" })

    const events = await app.request(
      "/token-usage/events?period=day&page=1&page_size=10",
    )
    const page = (await events.json()) as {
      items: Array<Record<string, unknown>>
    }
    expect(page.items[0]).toMatchObject({
      endpoint: "systemone",
      source: "copilot",
      provider_name: "copilot",
    })
  })
})
