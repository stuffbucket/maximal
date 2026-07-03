/**
 * Wire contract for GET /models and /v1/models (`src/routes/models/route.ts`).
 *
 * The endpoint serves one catalog in the shape the client's protocol expects:
 * OpenAI by default, Anthropic when signalled (anthropic-version header or an
 * anthropic/claude user-agent). Neither shape may leak raw Copilot fields
 * (billing, capabilities internals, policy, model_picker_*, supported_endpoints)
 * — the leak that shipped when the handler spread `...model`, which can make a
 * strict client (Claude Desktop's picker) reject the list and render empty.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { setModels } from "~/lib/state"
import { modelRoutes } from "~/routes/models/route"

const LEAK_VECTORS = [
  "billing",
  "capabilities", // OpenAI entries must not carry it; Anthropic carries a DIFFERENT shape (checked separately)
  "policy",
  "vendor",
  "name",
  "version",
  "preview",
  "model_picker_enabled",
  "supported_endpoints",
]

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
    billing: { is_premium: true, multiplier: 1 },
    policy: { state: "enabled", terms: "..." },
    supported_endpoints: ["/v1/messages"],
    capabilities: {
      family: "claude-opus-4.6",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      limits: {
        max_context_window_tokens: 1_000_000,
        max_output_tokens: 64_000,
      },
      supports: {
        tool_calls: true,
        streaming: true,
        vision: true,
        structured_outputs: true,
        adaptive_thinking: true,
      },
    },
    ...over,
  } as unknown as Model
}

function buildApp() {
  const app = new Hono()
  app.route("/v1/models", modelRoutes)
  return app
}

interface Entry {
  [k: string]: unknown
}

beforeEach(() => {
  setModels({ object: "list", data: [richModel()] })
})

describe("GET /v1/models — OpenAI default (no protocol signal)", () => {
  test("returns the OpenAI list shape with only OpenAI fields", async () => {
    const res = await buildApp().request("/v1/models")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { object: string; data: Array<Entry> }
    expect(body.object).toBe("list")
    const entry = body.data[0]
    expect(Object.keys(entry).sort()).toEqual(
      ["created", "id", "object", "owned_by"].sort(),
    )
    expect(entry.id).toBe("claude-opus-4-6-20260301")
    expect(entry.object).toBe("model")
    expect(entry.owned_by).toBe("anthropic")
    for (const leaked of LEAK_VECTORS) expect(entry[leaked]).toBeUndefined()
  })

  test("an openai/* user-agent still gets OpenAI shape", async () => {
    const res = await buildApp().request("/v1/models", {
      headers: { "user-agent": "openai/python 1.0" },
    })
    const body = (await res.json()) as { object?: string }
    expect(body.object).toBe("list")
  })
})

describe("GET /v1/models — Anthropic shape on signal", () => {
  test("anthropic-version header yields the Anthropic Models envelope", async () => {
    const res = await buildApp().request("/v1/models", {
      headers: { "anthropic-version": "2023-06-01" },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      object?: string
      data: Array<Entry>
      first_id: string | null
      has_more: boolean
      last_id: string | null
    }
    // Anthropic envelope: no object:"list"; pagination cursors present.
    expect(body.object).toBeUndefined()
    expect(body.has_more).toBe(false)
    expect(body.first_id).toBe("claude-opus-4-6-20260301")
    expect(body.last_id).toBe("claude-opus-4-6-20260301")

    const entry = body.data[0]
    expect(entry.type).toBe("model")
    expect(entry.display_name).toBe("Claude Opus 4.6")
    expect(entry.max_input_tokens).toBe(1_000_000)
    expect(entry.max_tokens).toBe(64_000)
    // Anthropic capability shape ({supported:boolean}), derived from Copilot supports.
    expect(entry.capabilities).toEqual({
      image_input: { supported: true },
      pdf_input: { supported: false },
      structured_outputs: { supported: true },
      thinking: { supported: true },
    })
    // OpenAI-only fields absent.
    expect(entry.object).toBeUndefined()
    expect(entry.created).toBeUndefined()
    expect(entry.owned_by).toBeUndefined()
    // Raw Copilot leak vectors absent (billing/policy/vendor/etc.).
    for (const leaked of ["billing", "policy", "vendor", "name", "version"]) {
      expect(entry[leaked]).toBeUndefined()
    }
  })

  test("an anthropic/* user-agent also yields the Anthropic envelope", async () => {
    const res = await buildApp().request("/v1/models", {
      headers: { "user-agent": "anthropic/typescript 0.30" },
    })
    const body = (await res.json()) as { object?: string; data: Array<Entry> }
    expect(body.object).toBeUndefined()
    expect(body.data[0].type).toBe("model")
  })
})
