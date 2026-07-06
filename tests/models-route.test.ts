/**
 * /settings/api/models — route-level coverage.
 *
 * Mocking strategy: stub the network layer only. `~/services/copilot/
 * get-models`'s `getModels()` returns a controllable fixture, so the
 * REAL `cacheModels()` (filter + setModels) runs on /refresh without
 * touching the network. GET tests seed `state.models` directly via the
 * real `setModels`. Nothing global to `~/lib/state` or `~/lib/utils` is
 * mocked, so this file can't bleed into siblings.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

const actualGetModels = await import("~/services/copilot/get-models")
let getModelsFixture: ModelsResponse = { object: "list", data: [] }
await mock.module("~/services/copilot/get-models", () => ({
  ...actualGetModels,
  getModels: () => Promise.resolve(getModelsFixture),
}))
// Restore the real module so this stub can't leak forward into a sibling
// test file (Bun keeps module mocks for the whole process). Awaited so the
// restore actually lands before the next file's static imports resolve.
afterAll(async () => {
  await mock.module("~/services/copilot/get-models", () => actualGetModels)
})

const { modelsRoutes } = await import("~/routes/settings/models")
const { setModels } = await import("~/lib/state")

interface ModelOverrides {
  id?: string
  name?: string
  type?: string
  pickerEnabled?: boolean
  preview?: boolean
  limits?: Model["capabilities"]["limits"]
  supports?: Model["capabilities"]["supports"]
}

function model(over: ModelOverrides = {}): Model {
  return {
    id: over.id ?? "m-1",
    name: over.name ?? "Model 1",
    vendor: "acme",
    version: "1",
    object: "model",
    model_picker_enabled: over.pickerEnabled ?? true,
    preview: over.preview ?? false,
    capabilities: {
      family: "acme-family",
      object: "model_capabilities",
      tokenizer: "o200k",
      type: over.type ?? "chat",
      limits: over.limits ?? {
        max_context_window_tokens: 200_000,
        max_output_tokens: 8_192,
      },
      supports: over.supports ?? { tool_calls: true, streaming: true },
    },
  }
}

function buildApp() {
  const app = new Hono()
  app.route("/models", modelsRoutes)
  return app
}

interface SummaryRow {
  id: string
  name: string
  type: string
  context_window_tokens: number | null
  max_output_tokens: number | null
  capabilities: {
    vision: boolean
    tool_calls: boolean
    streaming: boolean
    reasoning: boolean
  }
}

interface ListBody {
  models: Array<SummaryRow>
  count: number
  loaded_at: string | null
}

beforeEach(() => {
  getModelsFixture = { object: "list", data: [] }
})

describe("GET /models", () => {
  test("returns rows sorted by type then name, with count and loaded_at", async () => {
    setModels({
      object: "list",
      data: [
        model({ id: "z", name: "Zeta", type: "chat" }),
        model({ id: "a", name: "Alpha", type: "chat" }),
        model({ id: "e", name: "Embed", type: "embeddings" }),
      ],
    })
    const res = await buildApp().request("/models")
    expect(res.status).toBe(200)
    const body = (await res.json()) as ListBody
    // chat (< embeddings) first, alphabetical within type.
    expect(body.models.map((m) => m.id)).toEqual(["a", "z", "e"])
    expect(body.count).toBe(3)
    expect(typeof body.loaded_at).toBe("string")
  })

  test("derives capability flags and nulls missing limits", async () => {
    setModels({
      object: "list",
      data: [
        model({
          id: "reason-effort",
          limits: {},
          supports: { reasoning_effort: ["low", "high"] },
        }),
        model({
          id: "adaptive",
          supports: { adaptive_thinking: true, vision: true },
        }),
        model({ id: "plain", supports: {} }),
      ],
    })
    const res = await buildApp().request("/models")
    const body = (await res.json()) as ListBody
    const byId = Object.fromEntries(body.models.map((m) => [m.id, m]))

    // reasoning is true via either reasoning_effort ladder or adaptive_thinking.
    expect(byId["reason-effort"].capabilities.reasoning).toBe(true)
    expect(byId["reason-effort"].context_window_tokens).toBeNull()
    expect(byId["reason-effort"].max_output_tokens).toBeNull()
    expect(byId["adaptive"].capabilities.reasoning).toBe(true)
    expect(byId["adaptive"].capabilities.vision).toBe(true)
    // absent flags default to false, not undefined.
    expect(byId["plain"].capabilities).toEqual({
      vision: false,
      tool_calls: false,
      streaming: false,
      reasoning: false,
    })
  })

  test("empty cache yields an empty list, not an error", async () => {
    setModels({ object: "list", data: [] })
    const res = await buildApp().request("/models")
    const body = (await res.json()) as ListBody
    expect(body.models).toEqual([])
    expect(body.count).toBe(0)
  })
})

describe("POST /models/refresh", () => {
  // NOTE: a sibling test file (start-run-server) globally stubs
  // `~/lib/utils.cacheModels` to a no-op, and Bun's `mock.module`
  // persists across files — so this test must NOT assert that refresh
  // *changed* the data (whether the real fetch runs is order-dependent).
  // We pre-seed `state` AND the upstream fixture to the SAME already-
  // filtered set, so the response is identical under either cacheModels.
  // The picker/embeddings filter itself is cacheModels' concern, exercised
  // where that function is unit-tested.
  test("returns 200 and a schema-valid list of the current models", async () => {
    const current = {
      object: "list" as const,
      data: [
        model({ id: "kept-chat", name: "Chat", type: "chat" }),
        model({ id: "kept-embed", name: "Embed", type: "embeddings" }),
      ],
    }
    setModels(current)
    getModelsFixture = current
    const res = await buildApp().request("/models/refresh", { method: "POST" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ListBody
    expect(body.models.map((m) => m.id)).toEqual(["kept-chat", "kept-embed"])
    expect(body.count).toBe(2)
  })
})
