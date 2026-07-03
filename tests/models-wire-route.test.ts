/**
 * Wire contract for GET /models and /v1/models (`src/routes/models/route.ts`).
 *
 * Locks the documented response shape (docs/spec/wire/models-wire-prd.md): each
 * entry exposes ONLY id/object/type/created/created_at/owned_by/display_name.
 * Regression guard for the leak where `...model` spread raw Copilot fields
 * (billing, capabilities, policy, model_picker_*, supported_endpoints, …) into
 * the response — which broke the contract and could make a strict client
 * (Claude Desktop's picker) reject the list and render empty.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { setModels } from "~/lib/state"
import { modelRoutes } from "~/routes/models/route"

const DOCUMENTED_KEYS = [
  "created",
  "created_at",
  "display_name",
  "id",
  "object",
  "owned_by",
  "type",
].sort()

/** A model carrying the full raw Copilot field set the upstream returns. */
function richModel(over: Partial<Model> = {}): Model {
  return {
    id: over.id ?? "claude-opus-4.6",
    name: over.name ?? "Claude Opus 4.6",
    vendor: "anthropic",
    version: "1",
    object: "model",
    model_picker_enabled: true,
    preview: false,
    // Fields that must NOT leak to clients:
    billing: { is_premium: true, multiplier: 1 },
    policy: { state: "enabled", terms: "..." },
    supported_endpoints: ["/v1/messages"],
    capabilities: {
      family: "claude-opus-4.6",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      limits: { max_context_window_tokens: 1_000_000 },
      supports: { tool_calls: true, streaming: true },
    },
    ...over,
  } as unknown as Model
}

function buildApp() {
  const app = new Hono()
  app.route("/v1/models", modelRoutes)
  return app
}

interface ModelEntry {
  id: string
  object: string
  type: string
  display_name: string
  owned_by: string
  [k: string]: unknown
}
interface ListBody {
  object: string
  data: Array<ModelEntry>
  has_more: boolean
}

beforeEach(() => {
  setModels({ object: "list", data: [richModel()] })
})

describe("GET /v1/models — documented wire shape", () => {
  test("exposes ONLY the documented fields; no raw Copilot fields leak", async () => {
    const res = await buildApp().request("/v1/models")
    expect(res.status).toBe(200)
    const body = (await res.json()) as ListBody
    expect(body.object).toBe("list")
    expect(body.has_more).toBe(false)
    expect(body.data.length).toBe(1)

    const entry = body.data[0]
    expect(Object.keys(entry).sort()).toEqual(DOCUMENTED_KEYS)

    // Spot-check the leak vectors explicitly.
    for (const leaked of [
      "billing",
      "capabilities",
      "policy",
      "vendor",
      "name",
      "version",
      "preview",
      "model_picker_enabled",
      "supported_endpoints",
    ]) {
      expect(entry[leaked]).toBeUndefined()
    }
  })

  test("maps id/owned_by/display_name from the Copilot model", async () => {
    const res = await buildApp().request("/v1/models")
    const entry = ((await res.json()) as ListBody).data[0]
    // forwardId rewrites the dotted id to the sentinel-dated form.
    expect(entry.id).toBe("claude-opus-4-6-20260301")
    expect(entry.object).toBe("model")
    expect(entry.type).toBe("model")
    expect(entry.owned_by).toBe("anthropic")
    expect(entry.display_name).toBe("Claude Opus 4.6")
  })
})
