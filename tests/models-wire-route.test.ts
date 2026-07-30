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

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { setModels } from "~/lib/runtime-state/state"
import { modelRoutes } from "~/routes/models/route"

// Stub the network layer so the route's on-demand prime (primeModelsCache →
// cacheModels → getModels) never hits the real network. It rejects: the prime
// is best-effort (warn + serve empty), so the route still 200s. Restored in
// afterAll so it can't leak into a sibling file (Bun keeps mocks process-wide).
// NB: a sibling file globally no-ops cacheModels itself, so this file must not
// assert the prime *repopulated* the cache (order-dependent) — only that an
// unloadable catalog never 5xxes. The repopulation path is unit-tested in
// tests/refresh-models.test.ts with injected fns.
const actualGetModels = await import("~/services/copilot/get-models")
await mock.module("~/services/copilot/get-models", () => ({
  ...actualGetModels,
  getModels: () => Promise.reject(new Error("models endpoint down")),
}))
afterAll(async () => {
  await mock.module("~/services/copilot/get-models", () => actualGetModels)
})

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
  }
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
    // image_input and pdf_input both track the single `vision` flag (this fixture
    // is vision-capable), so both report supported.
    expect(entry.capabilities).toEqual({
      image_input: { supported: true },
      pdf_input: { supported: true },
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

describe("GET /v1/models — empty-catalog on-demand recovery", () => {
  test("an unloadable catalog yields an empty 200 list, never a 5xx", async () => {
    setModels({ object: "list", data: [] }) // primed-but-empty catalog
    // modelsCached() === 0 triggers a best-effort prime; the mocked getModels
    // rejects, so primeModelsCache warns and the route serves an empty list —
    // it must NOT relay a 500 (clients don't hard-depend on the catalog).
    const res = await buildApp().request("/v1/models")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data?: Array<unknown> }
    expect(body.data ?? []).toEqual([])
  })
})
