/**
 * Codex's model catalog on GET /v1/models (`src/apps/codex/models-catalog.ts`).
 *
 * Codex asks for its own catalog shape by adding `?client_version=` — the
 * signal LiteLLM keys on too. Without it every client keeps exactly the shape
 * it gets today. With it, the response adds `models`: Codex `ModelInfo`
 * entries for the Copilot models Codex can drive (the Responses API ones).
 * A model Codex already knows keeps Codex's own tuned entry; anything else
 * gets Codex's own fallback prompt plus Copilot's limits and efforts.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import pinned from "~/apps/codex/data/codex-catalog.json" with { type: "json" }
import { getConfig, writeConfig } from "~/lib/config/config"
import { setModels } from "~/lib/runtime-state/state"
import { modelRoutes } from "~/routes/models/route"

const originalConfig = getConfig()

/** Fields Codex's `ModelInfo` decoder requires (no serde default, not an
 *  Option) at rust-v0.146.1 — missing any one fails the whole catalog. */
const REQUIRED_CODEX_FIELDS = [
  "slug",
  "display_name",
  "supported_reasoning_levels",
  "shell_type",
  "visibility",
  "supported_in_api",
  "priority",
  "base_instructions",
  "support_verbosity",
  "truncation_policy",
  "supports_parallel_tool_calls",
  "experimental_supported_tools",
]

function model(over: Partial<Model> & { id: string }): Model {
  return {
    name: over.id,
    vendor: "openai",
    version: "1",
    object: "model",
    model_picker_enabled: true,
    preview: false,
    supported_endpoints: ["/responses", "/chat/completions"],
    capabilities: {
      family: over.id,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      limits: { max_prompt_tokens: 272_000, max_output_tokens: 64_000 },
      supports: { tool_calls: true, streaming: true, vision: false },
    },
    ...over,
  }
}

const TERRA = model({
  id: "gpt-5.6-terra",
  name: "GPT-5.6 Terra",
  capabilities: {
    ...model({ id: "x" }).capabilities,
    limits: { max_prompt_tokens: 128_000, max_output_tokens: 64_000 },
    supports: {
      tool_calls: true,
      vision: true,
      reasoning_effort: ["low", "medium", "high", "xhigh"],
    },
  },
})
const GROK = model({
  id: "grok-4.7",
  name: "Grok 4.7",
  vendor: "xai",
  capabilities: {
    ...model({ id: "x" }).capabilities,
    limits: { max_prompt_tokens: 500_000, max_output_tokens: 128_000 },
    supports: {
      tool_calls: true,
      vision: true,
      reasoning_effort: ["low", "medium", "high"],
    },
  },
})
const CHAT_ONLY = model({
  id: "chat-only-model",
  supported_endpoints: ["/chat/completions"],
})
const EMBEDDING = model({
  id: "text-embedding-3-small",
  supported_endpoints: ["/embeddings"],
  capabilities: {
    ...model({ id: "x" }).capabilities,
    type: "embeddings",
  },
})

function buildApp() {
  const app = new Hono()
  app.route("/v1/models", modelRoutes)
  return app
}

type Entry = Record<string, unknown>

async function codexCatalog(): Promise<{ models: Array<Entry> } & Entry> {
  const res = await buildApp().request("/v1/models?client_version=0.146.1")
  expect(res.status).toBe(200)
  return (await res.json()) as { models: Array<Entry> } & Entry
}

function entry(models: Array<Entry>, slug: string): Entry {
  const found = models.find((m) => m.slug === slug)
  if (!found) throw new Error(`no catalog entry for ${slug}`)
  return found
}

beforeEach(() => {
  writeConfig({})
  setModels({ object: "list", data: [TERRA, GROK, CHAT_ONLY, EMBEDDING] })
})

afterAll(() => {
  writeConfig(originalConfig)
})

describe("GET /v1/models without Codex's signal", () => {
  test("keeps the OpenAI shape, embeddings included, and no Codex catalog", async () => {
    const res = await buildApp().request("/v1/models")
    const body = (await res.json()) as { data: Array<Entry> } & Entry
    expect(body.object).toBe("list")
    expect(body.models).toBeUndefined()
    expect(body.data.map((m) => m.id)).toContain("text-embedding-3-small")
  })
})

describe("GET /v1/models?client_version= (Codex)", () => {
  test("lists only models Codex can drive over the Responses API", async () => {
    const { models } = await codexCatalog()
    expect(models.map((m) => m.slug).sort()).toEqual(
      ["gpt-5.6-terra", "grok-4.7"].sort(),
    )
  })

  test("still carries the OpenAI list alongside, for any other reader", async () => {
    const body = await codexCatalog()
    expect(body.object).toBe("list")
    expect((body.data as Array<Entry>).map((m) => m.id)).toContain(
      "text-embedding-3-small",
    )
  })

  test("every entry has the fields Codex's decoder requires", async () => {
    const { models } = await codexCatalog()
    for (const m of models) {
      for (const field of REQUIRED_CODEX_FIELDS) {
        expect(m[field], `${String(m.slug)}.${field}`).toBeDefined()
      }
      expect(m.visibility).toBe("list")
      expect(m.supported_in_api).toBe(true)
    }
  })

  test("each model reviews with itself, never the absent codex-auto-review", async () => {
    const { models } = await codexCatalog()
    for (const m of models) expect(m.auto_review_model_override).toBe(m.slug)
  })

  test("a model Codex knows keeps Codex's own tuned entry", async () => {
    const { models } = await codexCatalog()
    const terra = entry(models, "gpt-5.6-terra")
    const bundled = (pinned.models as Array<Entry>).find(
      (m) => m.slug === "gpt-5.6-terra",
    )
    expect(terra.model_messages).toEqual(bundled?.model_messages)
    expect(terra.base_instructions).toBe(bundled?.base_instructions)
    expect(terra.tool_mode).toBe(bundled?.tool_mode)
    expect(terra.default_reasoning_level).toBe("medium")
  })

  test("a known model's efforts are clipped to the ones Copilot serves", async () => {
    const { models } = await codexCatalog()
    const efforts = (
      entry(models, "gpt-5.6-terra").supported_reasoning_levels as Array<{
        effort: string
      }>
    ).map((level) => level.effort)
    // Codex's own ladder goes on to max/ultra; Copilot serves up to xhigh.
    expect(efforts).toEqual(["low", "medium", "high", "xhigh"])
  })

  test("drops OpenAI-backend features a Copilot route can't honor", async () => {
    const { models } = await codexCatalog()
    for (const m of models) {
      expect(m.prefer_websockets).not.toBe(true)
      expect(m.use_responses_lite).not.toBe(true)
      expect(m.service_tiers ?? []).toEqual([])
      expect(m.additional_speed_tiers ?? []).toEqual([])
      expect(m.supports_search_tool).not.toBe(true)
    }
  })

  test("a known model's context window never exceeds what Copilot serves", async () => {
    const { models } = await codexCatalog()
    const terra = entry(models, "gpt-5.6-terra")
    expect(terra.context_window).toBe(128_000)
    expect(terra.max_context_window).toBe(128_000)
    expect(
      (terra.auto_compact_token_limit as number | undefined) ?? 0,
    ).toBeLessThanOrEqual(128_000)
  })

  test("an unknown model gets Codex's fallback prompt and Copilot's facts", async () => {
    const { models } = await codexCatalog()
    const grok = entry(models, "grok-4.7")
    expect(grok.base_instructions).toBe(pinned.fallbackInstructions)
    expect(grok.display_name).toBe("Grok 4.7")
    expect(grok.context_window).toBe(500_000)
    expect(grok.input_modalities).toEqual(["text", "image"])
    expect(
      (grok.supported_reasoning_levels as Array<{ effort: string }>).map(
        (level) => level.effort,
      ),
    ).toEqual(["low", "medium", "high"])
    expect(grok.default_reasoning_level).toBe("medium")
  })

  test("a model with no reasoning efforts advertises none", async () => {
    setModels({
      object: "list",
      data: [model({ id: "plain-model" })],
    })
    const { models } = await codexCatalog()
    const plain = entry(models, "plain-model")
    expect(plain.supported_reasoning_levels).toEqual([])
    expect(plain.default_reasoning_level).toBeUndefined()
  })
})
