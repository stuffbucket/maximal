/**
 * The pass-through routes: `/v1/images/{generations,edits}`, `/v1/decisions`
 * and `/v1/systemone`. Each relays the request to the Copilot endpoint of the
 * same path and its JSON reply back unchanged, records usage against the
 * request's model, and answers errors through the OpenAI-wire error handler.
 *
 * Upstream calls are injected through the route factories; the wire tests
 * that need the real service stub `fetch` and restore it after each test.
 */

import * as decisions from "@stuffbucket/maximal-plugin-decisions"
import * as images from "@stuffbucket/maximal-plugin-images"
import * as systemone from "@stuffbucket/maximal-plugin-systemone"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/runtime-state/state"
import { closeUsageStore } from "~/lib/token-usage"
import { createDecisionsRoutes } from "~/routes/decisions/route"
import { createImagesRoutes } from "~/routes/images/route"
import { createSystemOneRoutes } from "~/routes/systemone/route"
import { tokenUsageRoute } from "~/routes/token-usage/route"

import { startTestGateway, type TestGateway } from "./helpers/plugins"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

const originalFetch = globalThis.fetch
const originalState = {
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  lastRequestTimestamp: state.lastRequestTimestamp,
  lastUpstreamRejection: state.lastUpstreamRejection,
  manualApprove: state.manualApprove,
  models: state.models,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  state.copilotToken = "test-token"
  state.githubToken = "test-github-token"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  state.models = undefined
})

afterEach(async () => {
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  Object.assign(state, originalState)
})

/** The model ids the tests below send to the image routes, besides the
 *  plugin's default. The images plugin serves what its bindings name, so the
 *  tests bind them like a user would in Settings. */
const IMAGE_TEST_MODELS = [
  "gpt-image-2.5-flare",
  "gpt-image-test",
  "gpt-6-luna-decisions",
  "gpt-x",
]

/** The decisions, SystemOne and images plugins on, installed as the running
 *  gateway the routes dispatch through. */
let plugins: TestGateway | undefined
beforeEach(async () => {
  const started = await startTestGateway(
    [decisions, systemone, images],
    ["decisions", "systemone", "images"],
  )
  await started.gateway.updateConfig("images", {
    bindings: IMAGE_TEST_MODELS.map((model) => ({
      model,
      provider: "copilot",
      upstreamModel: model,
    })),
  })
  plugins = started
})
afterEach(async () => {
  const started = plugins
  plugins = undefined
  await started?.dispose()
})

interface UsageRow {
  endpoint: string
  model: string
  input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  total_tokens: number
}

function withUsage(routes: Array<[string, Hono]>): Hono {
  const app = new Hono()
  for (const [path, route] of routes) app.route(path, route)
  app.route("/token-usage", tokenUsageRoute)
  return app
}

async function usageRows(app: Hono): Promise<Array<UsageRow>> {
  const response = await app.request(
    "/token-usage/events?period=day&page=1&page_size=10",
  )
  const page = (await response.json()) as { items: Array<UsageRow> }
  return page.items
}

/** The recorded cost, which only the summary carries. */
async function recordedNanoAiu(app: Hono): Promise<number> {
  const response = await app.request("/token-usage?period=day")
  const summary = (await response.json()) as {
    totals: { total_nano_aiu: number }
  }
  return summary.totals.total_nano_aiu
}

const postJson = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

/** Copilot's validation-error shape: JSON text under `text/plain`. */
function upstream400Response(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "model gpt-x is not supported via this endpoint",
        code: "model_not_supported",
      },
    }),
    { status: 400, headers: { "content-type": "text/plain" } },
  )
}

/** A hidden catalog entry serving `endpoints`. */
function catalogModel(id: string, endpoints: Array<string>): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: id,
    model_picker_enabled: false,
    supported_endpoints: endpoints,
    capabilities: {
      family: id,
      type: "decisions",
      tokenizer: "o200k_base",
      object: "model_capabilities",
      limits: {},
      supports: {},
    },
  }
}

interface CapturedFetch {
  url: string
  headers: Headers
  body: unknown
}

/** Replace `fetch` with one that records the request and answers `reply`. */
function captureFetch(reply: () => Response): Array<CapturedFetch> {
  const calls: Array<CapturedFetch> = []
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
    input: string,
    init: RequestInit,
  ) => {
    calls.push({
      url: input,
      headers: new Headers(init.headers),
      body: init.body,
    })
    return Promise.resolve(reply())
  }) as unknown as typeof fetch
  return calls
}

const imagesResult = {
  created: 1_700_000_000,
  background: "opaque",
  data: [{ b64_json: "aW1hZ2U=" }],
  output_format: "jpeg",
  quality: "low",
  size: "1024x1024",
  usage: {
    input_tokens: 12,
    input_tokens_details: {
      cached_tokens: 2,
      image_tokens: 0,
      text_tokens: 12,
    },
    output_tokens: 272,
    output_tokens_details: { image_tokens: 272, text_tokens: 0 },
    total_tokens: 284,
  },
  copilot_usage: {
    token_details: [{ token_type: "output", token_count: 272 }],
    total_nano_aiu: 5_000_000,
  },
}

describe("POST /v1/images/generations", () => {
  test("relays the reply unchanged and records usage against the request model", async () => {
    const calls = captureFetch(() =>
      Response.json(structuredClone(imagesResult)),
    )
    const app = withUsage([["/v1/images", createImagesRoutes()]])
    const payload = {
      model: "gpt-image-test",
      prompt: "a red square",
      size: "1024x1024",
      quality: "low",
      output_format: "jpeg",
    }

    const response = await postJson(app, "/v1/images/generations", payload)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(imagesResult)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0].body))).toEqual(payload)
    const rows = await usageRows(app)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      endpoint: "images",
      model: "gpt-image-test",
      input_tokens: 10,
      cache_read_input_tokens: 2,
      output_tokens: 272,
      total_tokens: 284,
    })
    expect(await recordedNanoAiu(app)).toBe(5_000_000)
  })

  test("an upstream 400 comes back in OpenAI's error format", async () => {
    captureFetch(upstream400Response)
    const app = withUsage([["/v1/images", createImagesRoutes()]])

    const response = await postJson(app, "/v1/images/generations", {
      model: "gpt-x",
      prompt: "x",
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain("not supported via this endpoint")
    expect(await usageRows(app)).toHaveLength(0)
  })

  test("the real service posts JSON to Copilot's /v1 path and relays a 400", async () => {
    const calls = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { message: "streaming image generation is not supported" },
          }),
          { status: 400, headers: { "content-type": "text/plain" } },
        ),
    )
    const app = withUsage([["/v1/images", createImagesRoutes()]])

    const response = await postJson(app, "/v1/images/generations", {
      model: "gpt-image-test",
      prompt: "x",
      stream: true,
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain(
      "streaming image generation is not supported",
    )
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0].url).pathname).toBe("/v1/images/generations")
    expect(calls[0].headers.get("content-type")).toBe("application/json")
    expect(calls[0].headers.get("authorization")).toBe("Bearer test-token")
    expect(JSON.parse(String(calls[0].body))).toEqual({
      model: "gpt-image-test",
      prompt: "x",
      stream: true,
    })
  })

  test("a model that doesn't serve the endpoint gets endpoint advice, not plan advice", async () => {
    state.models = {
      object: "list",
      data: [
        catalogModel("gpt-6-luna-decisions", ["/v1/decisions"]),
        catalogModel("gpt-image-2.5-flare", [
          "/v1/images/generations",
          "/v1/images/edits",
        ]),
      ],
    }
    captureFetch(
      () =>
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
    )
    const app = withUsage([["/v1/images", createImagesRoutes()]])

    const response = await postJson(app, "/v1/images/generations", {
      model: "gpt-6-luna-decisions",
      prompt: "x",
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toStartWith(
      "`gpt-6-luna-decisions` doesn't support `/v1/images/generations` "
        + "(it serves `/v1/decisions`).\n\n"
        + "Models that do: `gpt-image-2.5-flare`.",
    )
    expect(body.error.message).not.toContain("on your plan")
    expect(body.error.message).toContain(
      "Model is not supported for this request. [model_not_supported]",
    )
  })

  test("refuses while signed out, in OpenAI's format", async () => {
    state.githubToken = undefined
    const calls = captureFetch(() => Response.json(imagesResult))
    const app = withUsage([["/v1/images", createImagesRoutes()]])

    const response = await postJson(app, "/v1/images/generations", {
      model: "gpt-image-test",
      prompt: "x",
    })

    expect(response.status).toBe(503)
    expect(response.headers.get("x-should-retry")).toBe("false")
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("maximal_not_signed_in")
    expect(calls).toHaveLength(0)
  })
})

describe("POST /v1/images/edits", () => {
  test("re-sends a multipart form with its images and model, under a fresh multipart type", async () => {
    const calls = captureFetch(() => Response.json(imagesResult))
    const app = withUsage([["/v1/images", createImagesRoutes()]])
    const form = new FormData()
    form.append("model", "gpt-image-test")
    form.append("prompt", "make it blue")
    form.append(
      "image[]",
      new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }),
    )
    form.append(
      "image[]",
      new File([new Uint8Array([4, 5])], "b.png", { type: "image/png" }),
    )

    const response = await app.request("/v1/images/edits", {
      method: "POST",
      body: form,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(imagesResult)
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0].url).pathname).toBe("/v1/images/edits")
    // The base headers' application/json is gone; fetch writes the multipart
    // type with the boundary of the body it encodes.
    expect(calls[0].headers.get("content-type")).toBeNull()
    const sent = calls[0].body
    expect(sent).toBeInstanceOf(FormData)
    const sentForm = sent as FormData
    expect(sentForm.get("model")).toBe("gpt-image-test")
    expect(sentForm.get("prompt")).toBe("make it blue")
    const images = sentForm.getAll("image[]") as Array<File>
    expect(images.map((file) => file.name)).toEqual(["a.png", "b.png"])
    expect(Array.from(new Uint8Array(await images[0].arrayBuffer()))).toEqual([
      1, 2, 3,
    ])
    const encoded = new Request("http://x", { method: "POST", body: sentForm })
    expect(encoded.headers.get("content-type")).toStartWith(
      "multipart/form-data; boundary=",
    )
    const rows = await usageRows(app)
    expect(rows[0]).toMatchObject({
      endpoint: "images",
      model: "gpt-image-test",
    })
  })

  test("passes a JSON edit through as JSON", async () => {
    const calls = captureFetch(() => Response.json(imagesResult))
    const app = withUsage([["/v1/images", createImagesRoutes()]])
    const payload = {
      model: "gpt-image-test",
      prompt: "make it blue",
      images: [{ image_url: "data:image/png;base64,AQID" }],
    }

    const response = await postJson(app, "/v1/images/edits", payload)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(imagesResult)
    expect(calls[0].headers.get("content-type")).toBe("application/json")
    expect(JSON.parse(String(calls[0].body))).toEqual(payload)
    const rows = await usageRows(app)
    expect(rows[0]).toMatchObject({
      endpoint: "images",
      model: "gpt-image-test",
    })
  })
})

describe("POST /v1/decisions", () => {
  const decisionsResult = {
    model: "gpt-6-luna",
    answers: [{ question: "q1", answer: "yes" }],
    usage: {
      input_tokens: 40,
      input_tokens_details: { cached_tokens: 8 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 45,
    },
  }

  test("relays the reply unchanged and records usage against the request model", async () => {
    captureFetch(() => Response.json(structuredClone(decisionsResult)))
    const app = withUsage([["/v1/decisions", createDecisionsRoutes()]])

    const response = await postJson(app, "/v1/decisions", {
      model: "gpt-6-luna-decisions",
      input: "Is the sky blue?",
      questions: [{ id: "q1" }],
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(decisionsResult)
    const rows = await usageRows(app)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      endpoint: "decisions",
      model: "gpt-6-luna-decisions",
      input_tokens: 32,
      cache_read_input_tokens: 8,
      output_tokens: 5,
      total_tokens: 45,
    })
  })

  test("an upstream 400 comes back in OpenAI's error format", async () => {
    captureFetch(upstream400Response)
    const app = withUsage([["/v1/decisions", createDecisionsRoutes()]])

    const response = await postJson(app, "/v1/decisions", {
      model: "gpt-6-luna-decisions",
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain("not supported via this endpoint")
  })

  test("refuses while signed out", async () => {
    state.githubToken = undefined
    const app = withUsage([["/v1/decisions", createDecisionsRoutes()]])

    const response = await postJson(app, "/v1/decisions", { model: "x" })

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("maximal_not_signed_in")
  })
})

describe("POST /v1/systemone", () => {
  const systemOneResult = {
    model: "dev-microsoft-decision-1.1",
    answers: { is_done: { value: true } },
    usage: { input_tokens: 30, output_tokens: 4 },
  }

  test("relays the reply unchanged and records usage against the request model", async () => {
    captureFetch(() => Response.json(structuredClone(systemOneResult)))
    const app = withUsage([["/v1/systemone", createSystemOneRoutes()]])

    const response = await postJson(app, "/v1/systemone", {
      model: "microsoft-decision-1",
      state: "The task finished.",
      questions: { is_done: { type: "boolean", instructions: "Done?" } },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(systemOneResult)
    const rows = await usageRows(app)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      endpoint: "systemone",
      model: "microsoft-decision-1",
      input_tokens: 30,
      output_tokens: 4,
      total_tokens: 34,
    })
  })

  test("the real service posts to Copilot's /v1/systemone", async () => {
    const calls = captureFetch(() => Response.json(systemOneResult))
    const app = withUsage([["/v1/systemone", createSystemOneRoutes()]])

    const response = await postJson(app, "/v1/systemone", {
      model: "microsoft-decision-1",
    })

    expect(response.status).toBe(200)
    expect(new URL(calls[0].url).pathname).toBe("/v1/systemone")
  })

  test("an upstream 400 comes back in OpenAI's error format", async () => {
    captureFetch(upstream400Response)
    const app = withUsage([["/v1/systemone", createSystemOneRoutes()]])

    const response = await postJson(app, "/v1/systemone", {
      model: "microsoft-decision-1",
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain("not supported via this endpoint")
  })

  test("refuses while signed out", async () => {
    state.githubToken = undefined
    const app = withUsage([["/v1/systemone", createSystemOneRoutes()]])

    const response = await postJson(app, "/v1/systemone", { model: "x" })

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("maximal_not_signed_in")
  })
})
