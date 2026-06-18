/**
 * Regression test for the malformed-model crash.
 *
 * Copilot's `/models` catalog is not uniform: some entries omit
 * `capabilities.limits` (or `capabilities` / `capabilities.supports`)
 * entirely, even though the static `Model` type declares them required.
 * `toSummary` in src/routes/settings/models.ts used to read
 * `capabilities.limits.max_context_window_tokens` unguarded, so a single
 * malformed model threw "undefined is not an object" and blanked the
 * entire Models list in the UI (the route returned a 500 error envelope).
 *
 * These tests pin the route's tolerance: one malformed model must not
 * take down the whole list — the endpoint returns 200 and renders every
 * model, collapsing the missing fields to null/false.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { createAuthMiddleware } from "~/lib/request-auth"
import { setModels, state } from "~/lib/state"
import { settingsApiRoutes } from "~/routes/settings/api"

function buildApp() {
  const app = new Hono()
  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => [],
      allowUnauthenticatedPaths: ["/", "/usage-viewer"],
    }),
  )
  app.route("/settings/api", settingsApiRoutes)
  return app
}

// A well-formed model and a malformed one (no `capabilities.limits`,
// no `supports`) — the exact shape that crashed the route in the field.
const wellFormed = {
  id: "claude-opus-4-6-20260301",
  name: "Claude Opus 4.6",
  object: "model",
  vendor: "anthropic",
  version: "1",
  model_picker_enabled: true,
  preview: false,
  capabilities: {
    family: "claude-opus-4.6",
    object: "model_capabilities",
    type: "chat",
    tokenizer: "o200k_base",
    limits: { max_context_window_tokens: 200000, max_output_tokens: 64000 },
    supports: { vision: true, tool_calls: true, streaming: true },
  },
}
const malformed = {
  id: "broken-model",
  name: "Broken Model",
  object: "model",
  vendor: "unknown",
  version: "1",
  model_picker_enabled: true,
  preview: false,
  // capabilities present but missing `limits` and `supports`.
  capabilities: {
    family: "broken",
    object: "model_capabilities",
    type: "chat",
    tokenizer: "o200k_base",
  },
}

const savedModels = state.models

afterEach(() => {
  // Restore whatever the suite started with so we don't poison neighbors.
  if (savedModels) setModels(savedModels)
  else state.models = undefined
})

describe("GET /settings/api/models — malformed catalog tolerance", () => {
  test("a model missing capabilities.limits does not 500 the whole list", async () => {
    setModels({
      object: "list",
      data: [malformed, wellFormed],
    } as unknown as ModelsResponse)

    const app = buildApp()
    const res = await app.request("/settings/api/models")

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      count: number
      models: Array<{
        id: string
        context_window_tokens: number | null
        max_output_tokens: number | null
        capabilities: { vision: boolean; tool_calls: boolean }
      }>
    }

    // Both models render — the malformed one is not dropped.
    expect(body.count).toBe(2)
    const broken = body.models.find((m) => m.id === "broken-model")
    expect(broken).toBeDefined()
    // Missing limits collapse to null; missing supports collapse to false.
    expect(broken?.context_window_tokens).toBeNull()
    expect(broken?.max_output_tokens).toBeNull()
    expect(broken?.capabilities.vision).toBe(false)
    expect(broken?.capabilities.tool_calls).toBe(false)

    // The well-formed model keeps its real values.
    const ok = body.models.find((m) => m.id === "claude-opus-4-6-20260301")
    expect(ok?.context_window_tokens).toBe(200000)
    expect(ok?.capabilities.vision).toBe(true)
  })

  test("a model missing capabilities entirely is still tolerated", async () => {
    const noCaps = {
      id: "no-caps",
      name: "No Caps",
      object: "model",
      vendor: "unknown",
      version: "1",
      model_picker_enabled: true,
      preview: false,
    }
    setModels({
      object: "list",
      data: [noCaps, wellFormed],
    } as unknown as ModelsResponse)

    const app = buildApp()
    const res = await app.request("/settings/api/models")

    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number }
    expect(body.count).toBe(2)
  })
})
