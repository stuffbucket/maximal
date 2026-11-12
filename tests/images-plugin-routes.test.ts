/**
 * The image routes with the images plugin on and off: on, generations and
 * edits (JSON and multipart) relay through the plugin and record the provider
 * id; off, the model is "not turned on" (404 `model_not_enabled`) and never
 * reaches the upstream, and `/v1/models` stops listing image models. #604's
 * request/reply contract itself lives in `passthrough-routes.test.ts`.
 */

import * as images from "@stuffbucket/maximal-plugin-images"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { setModels, state } from "~/lib/runtime-state/state"
import { closeUsageStore } from "~/lib/token-usage"
import { createImagesRoutes } from "~/routes/images/route"
import { modelRoutes } from "~/routes/models/route"
import { tokenUsageRoute } from "~/routes/token-usage/route"

import { startTestGateway, type TestGateway } from "./helpers/plugins"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const MODEL = "gpt-image-2.5-flare"
const originalFetch = globalThis.fetch
const originalState = {
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  manualApprove: state.manualApprove,
  models: state.models,
  rateLimitSeconds: state.rateLimitSeconds,
}

const imagesReply = {
  created: 1_700_000_000,
  data: [{ b64_json: "aW1hZ2U=" }],
  usage: {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens: 272,
    total_tokens: 284,
  },
  copilot_usage: { total_nano_aiu: 5_000_000 },
}

interface Upstream {
  path: string
  contentType: string | null
  body: unknown
}

let gateway: TestGateway
let upstream: Array<Upstream>

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  state.copilotToken = "test-token"
  state.githubToken = "test-github-token"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.models = undefined
  upstream = []
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
    input: string,
    init: RequestInit,
  ) => {
    upstream.push({
      path: new URL(input).pathname,
      contentType: new Headers(init.headers).get("content-type"),
      body: init.body,
    })
    return Promise.resolve(Response.json(imagesReply))
  }) as unknown as typeof fetch
  gateway = await startTestGateway([images], ["images"])
})

afterEach(async () => {
  await gateway.dispose()
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  Object.assign(state, originalState)
})

function app(): Hono {
  const hono = new Hono()
  hono.route("/v1/images", createImagesRoutes())
  hono.route("/v1/models", modelRoutes)
  hono.route("/token-usage", tokenUsageRoute)
  return hono
}

const postJson = (hono: Hono, path: string, body: unknown) =>
  hono.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

function editForm(model: string): FormData {
  const form = new FormData()
  form.append("model", model)
  form.append("prompt", "make it blue")
  form.append(
    "image[]",
    new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }),
  )
  form.append(
    "image[]",
    new File([new Uint8Array([4, 5])], "b.png", { type: "image/png" }),
  )
  return form
}

async function setImagesEnabled(on: boolean): Promise<void> {
  await gateway.gateway.reconcile({ images: { enabled: on } })
}

async function usageRows(hono: Hono): Promise<Array<Record<string, unknown>>> {
  const response = await hono.request(
    "/token-usage/events?period=day&page=1&page_size=10",
  )
  return ((await response.json()) as { items: Array<Record<string, unknown>> })
    .items
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

describe("with the images plugin on", () => {
  test("generations relay through the plugin and record the provider id", async () => {
    const hono = app()

    const response = await postJson(hono, "/v1/images/generations", {
      model: MODEL,
      prompt: "a red square",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(imagesReply)
    expect(upstream.map((call) => call.path)).toEqual([
      "/v1/images/generations",
    ])
    expect(upstream[0].contentType).toBe("application/json")
    expect(JSON.parse(String(upstream[0].body))).toEqual({
      model: MODEL,
      prompt: "a red square",
    })
    const rows = await usageRows(hono)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      endpoint: "images",
      model: MODEL,
      source: "copilot",
      provider_name: "copilot",
      input_tokens: 10,
      cache_read_input_tokens: 2,
      output_tokens: 272,
    })
  })

  test("a multipart edit is re-sent as a form with a fresh boundary", async () => {
    const hono = app()

    const response = await hono.request("/v1/images/edits", {
      method: "POST",
      body: editForm(MODEL),
    })

    expect(response.status).toBe(200)
    expect(upstream[0].path).toBe("/v1/images/edits")
    expect(upstream[0].contentType).toBeNull()
    const sent = upstream[0].body
    expect(sent).toBeInstanceOf(FormData)
    const sentForm = sent as FormData
    expect(sentForm.get("model")).toBe(MODEL)
    const files = sentForm.getAll("image[]") as Array<File>
    expect(files.map((file) => file.name)).toEqual(["a.png", "b.png"])
    expect(Array.from(new Uint8Array(await files[0].arrayBuffer()))).toEqual([
      1, 2, 3,
    ])
    const encoded = new Request("http://x", { method: "POST", body: sentForm })
    expect(encoded.headers.get("content-type")).toStartWith(
      "multipart/form-data; boundary=",
    )
    expect((await usageRows(hono))[0]).toMatchObject({
      endpoint: "images",
      model: MODEL,
      provider_name: "copilot",
    })
  })

  test("a multipart edit under a namespaced id reaches the upstream under its own model id", async () => {
    const response = await app().request("/v1/images/edits", {
      method: "POST",
      body: editForm(`copilot/${MODEL}`),
    })

    expect(response.status).toBe(200)
    const sent = upstream[0].body as FormData
    expect(sent.get("model")).toBe(MODEL)
    expect(sent.getAll("image[]")).toHaveLength(2)
  })

  test("a JSON edit passes through as JSON", async () => {
    const payload = {
      model: MODEL,
      prompt: "make it blue",
      images: [{ image_url: "data:image/png;base64,AQID" }],
    }

    const response = await postJson(app(), "/v1/images/edits", payload)

    expect(response.status).toBe(200)
    expect(upstream[0].contentType).toBe("application/json")
    expect(JSON.parse(String(upstream[0].body))).toEqual(payload)
  })

  test("a model the plugin doesn't bind is a 404", async () => {
    const response = await postJson(app(), "/v1/images/generations", {
      model: "gpt-x",
      prompt: "x",
    })

    expect(response.status).toBe(404)
    expect(upstream).toEqual([])
  })

  test("/v1/models lists the image model", async () => {
    setModels({
      object: "list",
      data: [catalogModel(MODEL, "image"), catalogModel("gpt-5.4", "chat")],
    })

    const list = (await (await app().request("/v1/models")).json()) as {
      data: Array<{ id: string }>
    }

    expect(list.data.map((entry) => entry.id)).toEqual([MODEL, "gpt-5.4"])
  })
})

describe("with the images plugin off", () => {
  beforeEach(async () => {
    await setImagesEnabled(false)
  })

  for (const [path, operationPath] of [
    ["/v1/images/generations", "/v1/images/generations"],
    ["/v1/images/edits", "/v1/images/edits"],
  ] as const) {
    test(`${path}: 404 model_not_enabled, nothing reaches the upstream or the usage log`, async () => {
      const hono = app()

      const response = await postJson(hono, path, { model: MODEL, prompt: "x" })

      expect(response.status).toBe(404)
      expect(response.headers.get("x-should-retry")).toBe("false")
      const body = (await response.json()) as {
        error: { type: string; code: string; message: string }
      }
      expect(body.error).toMatchObject({
        type: "invalid_request_error",
        code: "model_not_enabled",
      })
      expect(body.error.message).toContain(`\`${MODEL}\``)
      expect(body.error.message).toContain(operationPath)
      expect(upstream).toEqual([])
      expect(await usageRows(hono)).toHaveLength(0)
    })
  }

  test("a multipart edit is a 404 too", async () => {
    const response = await app().request("/v1/images/edits", {
      method: "POST",
      body: editForm(MODEL),
    })

    expect(response.status).toBe(404)
    expect(upstream).toEqual([])
  })

  test("/v1/models stops listing image models", async () => {
    setModels({
      object: "list",
      data: [catalogModel(MODEL, "image"), catalogModel("gpt-5.4", "chat")],
    })

    const list = (await (await app().request("/v1/models")).json()) as {
      data: Array<{ id: string }>
    }

    expect(list.data.map((entry) => entry.id)).toEqual(["gpt-5.4"])
  })

  test("turning it back on serves it again", async () => {
    await setImagesEnabled(true)

    const response = await postJson(app(), "/v1/images/generations", {
      model: MODEL,
      prompt: "x",
    })

    expect(response.status).toBe(200)
  })
})
