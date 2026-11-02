import { describe, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import {
  isClaudeAutoModelEligible,
  resolveClaudeAutoModels,
} from "~/lib/models/claude-auto-models"

interface ModelOptions {
  family?: string
  vendor?: string
  type?: string
  picker?: boolean
  preview?: boolean
  toolCalls?: boolean
  streaming?: boolean
  endpoints?: Array<string>
  prices?: Record<string, number>
}

function model(id: string, options: ModelOptions = {}): Model {
  return {
    id,
    name: id,
    object: "model",
    version: "1",
    vendor: options.vendor ?? "",
    model_picker_enabled: options.picker ?? true,
    preview: options.preview ?? false,
    supported_endpoints: options.endpoints ?? ["/responses"],
    capabilities: {
      family: options.family ?? id,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: options.type ?? "chat",
      limits: {},
      supports: {
        tool_calls: options.toolCalls ?? true,
        streaming: options.streaming ?? true,
      },
    },
    ...(options.prices ? { billing: { token_prices: options.prices } } : {}),
  }
}

const haiku = model("claude-haiku-4.6", {
  family: "claude-haiku",
  vendor: "anthropic",
  endpoints: ["/v1/messages"],
})
const sonnet = model("claude-sonnet-4.7", {
  family: "claude-sonnet",
  vendor: "anthropic",
  endpoints: ["/v1/messages"],
})
const smallGpt = model("gpt-5.6-mini", {
  family: "gpt-5.6-mini",
  vendor: "openai",
})
const fullGpt = model("gpt-5.6", {
  family: "gpt-5.6",
  vendor: "openai",
})

describe("isClaudeAutoModelEligible", () => {
  test("accepts every endpoint the Messages ingress can route", () => {
    for (const endpoint of [
      "/v1/messages",
      "/responses",
      "/chat/completions",
    ]) {
      expect(
        isClaudeAutoModelEligible(
          model(`model-${endpoint}`, { endpoints: [endpoint] }),
        ),
      ).toBe(true)
    }
  })

  test("rejects embeddings and picker-disabled models", () => {
    expect(
      isClaudeAutoModelEligible(model("embedding", { type: "embeddings" })),
    ).toBe(false)
    expect(isClaudeAutoModelEligible(model("hidden", { picker: false }))).toBe(
      false,
    )
  })

  test("rejects internal Claude variants", () => {
    expect(isClaudeAutoModelEligible(model("claude-sonnet-4.7-high"))).toBe(
      false,
    )
    expect(
      isClaudeAutoModelEligible(model("claude-sonnet-4.7-1m-internal")),
    ).toBe(false)
  })

  test("requires tool calls, streaming, and a routable endpoint", () => {
    expect(
      isClaudeAutoModelEligible(model("no-tools", { toolCalls: false })),
    ).toBe(false)
    expect(
      isClaudeAutoModelEligible(model("no-stream", { streaming: false })),
    ).toBe(false)
    expect(
      isClaudeAutoModelEligible(
        model("unknown-endpoint", { endpoints: ["/audio"] }),
      ),
    ).toBe(false)
    expect(
      isClaudeAutoModelEligible(model("no-endpoints", { endpoints: [] })),
    ).toBe(false)
  })

  test("treats sparse catalog records as ineligible instead of throwing", () => {
    const sparse = {
      id: "sparse",
      model_picker_enabled: true,
    } as unknown as Model
    expect(isClaudeAutoModelEligible(sparse)).toBe(false)
  })
})

describe("resolveClaudeAutoModels", () => {
  test("chooses Haiku and Sonnet ahead of GPT fallbacks", () => {
    const result = resolveClaudeAutoModels({
      models: [smallGpt, fullGpt, sonnet, haiku],
    })
    expect(result.fast).toEqual({
      configured: null,
      effective: haiku.id,
      source: "automatic",
      status: "ready",
      reason: "haiku",
    })
    expect(result.capable).toEqual({
      configured: null,
      effective: sonnet.id,
      source: "automatic",
      status: "ready",
      reason: "sonnet",
    })
  })

  test("uses small GPT for fast and full GPT for capable when Claude tiers are absent", () => {
    const result = resolveClaudeAutoModels({ models: [fullGpt, smallGpt] })
    expect(result.fast.effective).toBe(smallGpt.id)
    expect(result.fast.reason).toBe("small-gpt")
    expect(result.capable.effective).toBe(fullGpt.id)
    expect(result.capable.reason).toBe("gpt")
  })

  test("falls back across GPT size buckets before giving up", () => {
    const onlyFull = resolveClaudeAutoModels({ models: [fullGpt] })
    expect(onlyFull.fast.effective).toBe(fullGpt.id)
    expect(onlyFull.fast.reason).toBe("gpt")

    const onlySmall = resolveClaudeAutoModels({ models: [smallGpt] })
    expect(onlySmall.capable.effective).toBe(smallGpt.id)
    expect(onlySmall.capable.reason).toBe("small-gpt")
  })

  test("recognizes GPT class from vendor, family, or id", () => {
    const vendor = model("quick-model", { family: "quick", vendor: "OpenAI" })
    const family = model("quick-family", {
      family: "gpt-fast",
      vendor: "other",
    })
    const id = model("gpt-special", { family: "other", vendor: "other" })
    for (const candidate of [vendor, family, id]) {
      expect(
        resolveClaudeAutoModels({ models: [candidate] }).fast.effective,
      ).toBe(candidate.id)
    }
  })

  test("keeps the previous automatic choice while it remains in the selected bucket", () => {
    const first = model("gpt-5.6-mini-a", { family: "gpt-mini" })
    const previous = model("gpt-5.6-mini-b", {
      family: "gpt-mini",
      preview: true,
      prices: { input: 1 },
    })
    const result = resolveClaudeAutoModels({
      models: [first, previous],
      previousAutomatic: { fast: previous.id },
    })
    expect(result.fast.effective).toBe(previous.id)
  })

  test("prefers stable models over previews", () => {
    const preview = model("gpt-mini-preview", {
      family: "gpt-mini",
      preview: true,
      prices: { input: 0, output: 0 },
    })
    const stable = model("gpt-mini-stable", {
      family: "gpt-mini",
      prices: { input: 2 },
    })
    expect(
      resolveClaudeAutoModels({ models: [preview, stable] }).fast.effective,
    ).toBe(stable.id)
  })

  test("prefers explicitly zero-priced models without comparing paid rates", () => {
    const paidLow = model("gpt-mini-paid-low", {
      family: "gpt-mini",
      prices: { input: 0.1 },
    })
    const free = model("gpt-mini-free", {
      family: "gpt-mini",
      prices: { input: 0, output: 0 },
    })
    const paidHigh = model("gpt-mini-paid-high", {
      family: "gpt-mini",
      prices: { input: 100 },
    })
    expect(
      resolveClaudeAutoModels({ models: [paidLow, free, paidHigh] }).fast
        .effective,
    ).toBe(free.id)
    expect(
      resolveClaudeAutoModels({ models: [paidLow, paidHigh] }).fast.effective,
    ).toBe(paidLow.id)
  })

  test("preserves upstream catalog order as the final tie-break", () => {
    const first = model("gpt-mini-z", { family: "gpt-mini" })
    const second = model("gpt-mini-a", { family: "gpt-mini" })
    expect(
      resolveClaudeAutoModels({ models: [first, second] }).fast.effective,
    ).toBe(first.id)
  })

  test("an eligible Maximal override wins over external and automatic values", () => {
    const result = resolveClaudeAutoModels({
      models: [haiku, sonnet, fullGpt],
      overrides: { fast: fullGpt.id },
      external: { fast: sonnet.id },
    })
    expect(result.fast).toEqual({
      configured: fullGpt.id,
      effective: fullGpt.id,
      source: "maximal-override",
      status: "ready",
      reason: "override",
    })
  })

  test("an external Claude Code setting wins when there is no Maximal override", () => {
    const result = resolveClaudeAutoModels({
      models: [haiku, fullGpt],
      external: { fast: fullGpt.id },
    })
    expect(result.fast).toEqual({
      configured: null,
      effective: fullGpt.id,
      source: "claude-code-setting",
      status: "ready",
      reason: "external-setting",
    })
  })

  test("keeps an unavailable override visible without silently falling back", () => {
    const result = resolveClaudeAutoModels({
      models: [haiku, sonnet],
      overrides: { fast: "gpt-retired" },
    })
    expect(result.fast).toEqual({
      configured: "gpt-retired",
      effective: null,
      source: "maximal-override",
      status: "unavailable",
      reason: "override-unavailable",
    })
  })

  test("reports an unavailable external setting while preserving its effective id", () => {
    const result = resolveClaudeAutoModels({
      models: [haiku, sonnet],
      external: { capable: "claude-sonnet-retired" },
    })
    expect(result.capable).toEqual({
      configured: null,
      effective: "claude-sonnet-retired",
      source: "claude-code-setting",
      status: "unavailable",
      reason: "external-unavailable",
    })
  })

  test("returns unresolved tiers instead of choosing an unrelated model", () => {
    const result = resolveClaudeAutoModels({ models: [] })
    expect(result.fast).toEqual({
      configured: null,
      effective: null,
      source: "none",
      status: "unresolved",
      reason: "no-match",
    })
    expect(result.capable).toEqual(result.fast)
    expect(result.eligibleModels).toEqual([])
  })
})
