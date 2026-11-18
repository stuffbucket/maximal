import type {
  Model,
  TokenPriceTier,
  TokenPrices,
} from "~/services/copilot/get-models"

import { DEFAULT_CREDIT_USD } from "~/lib/budget/units"
import { isVariantId } from "~/lib/models/anthropic-id-rewrite"

interface PiRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface PiCost extends PiRates {
  known: true
  tiers?: Array<PiRates & { inputTokensAbove: number }>
}

export interface PiModel {
  id: string
  name: string
  api: "anthropic-messages" | "openai-responses" | "openai-completions"
  baseUrl: string
  reasoning: boolean
  input: Array<"text" | "image">
  contextWindow: number
  maxTokens: number
  cost?: PiCost
  thinkingLevelMap?: Record<string, string | null>
  inputLimits?: { images: { maxPerRequest: number } }
  compat?: {
    maxTokensField?: "max_tokens"
    supportsReasoningEffort?: boolean
    forceAdaptiveThinking?: boolean
  }
}

function rate(
  source: TokenPriceTier | TokenPrices,
  key: string,
  legacy: string,
): number | undefined {
  const value = source[key] ?? source[legacy]
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ?
      value
    : undefined
}

function rates(
  source: TokenPriceTier | TokenPrices,
  batchSize: number,
  creditUsd: number,
): PiRates | undefined {
  const input = rate(source, "input_price", "input")
  const output = rate(source, "output_price", "output")
  const cacheRead = rate(source, "cache_read_price", "cache_read")
  const cacheWrite = rate(source, "cache_write_price", "cache_write")
  if (
    input === undefined
    || output === undefined
    || cacheRead === undefined
    || cacheWrite === undefined
  )
    return
  // Copilot uses batch_size=0 for explicitly zero-priced entries. Never divide
  // a nonzero price by zero, and never turn incomplete metadata into free access.
  const allZero =
    input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0
  if (batchSize <= 0 && !allZero) return
  const factor = allZero ? 0 : (creditUsd * 1_000_000) / batchSize
  return {
    input: input * factor,
    output: output * factor,
    cacheRead: cacheRead * factor,
    cacheWrite: cacheWrite * factor,
  }
}

function piCost(model: Model, creditUsd: number): PiCost | undefined {
  const prices = model.billing?.token_prices
  if (!prices) return
  const batchSize = prices.batch_size ?? 1_000_000
  if (!Number.isFinite(batchSize) || batchSize < 0) return
  const base = prices.default ?? prices
  const baseRates = rates(base, batchSize, creditUsd)
  if (!baseRates) return
  const longRates =
    prices.long_context && rates(prices.long_context, batchSize, creditUsd)
  const threshold = prices.default?.max_prompt_tokens
  const hasDifferentTier =
    longRates
    && Object.entries(longRates).some(
      ([key, value]) => value !== baseRates[key as keyof PiRates],
    )
  return {
    ...baseRates,
    known: true,
    ...((
      hasDifferentTier
      && threshold !== undefined
      && Number.isFinite(threshold)
      && threshold > 0
    ) ?
      {
        tiers: [{ ...longRates, inputTokensAbove: threshold }],
      }
    : {}),
  }
}

/** Project the current Copilot catalog into Pi's model definitions, never a hard-coded model list. */
export function projectPiModels(
  models: ReadonlyArray<Model>,
  baseUrl: string,
  creditUsd = DEFAULT_CREDIT_USD,
): Array<PiModel> {
  if (!Number.isFinite(creditUsd) || creditUsd <= 0)
    throw new Error("Invalid USD per AI credit")
  const url = new URL(baseUrl)
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(
      "Pi's Maximal base URL must be an HTTP(S) URL without credentials or a query",
    )
  }
  const root = url.href.replace(/\/+$/u, "").replace(/\/v1$/u, "")
  return models
    .flatMap((model) => {
      const projected = projectModel(model, root, creditUsd)
      return projected ? [projected] : []
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
}

function apiFor(model: Model): PiModel["api"] | undefined {
  const { supports, type } = model.capabilities
  if (
    type !== "chat"
    || isVariantId(model.id)
    || !supports.tool_calls
    || !supports.streaming
  )
    return
  const endpoints = model.supported_endpoints ?? []
  if (endpoints.includes("/v1/messages")) return "anthropic-messages"
  if (endpoints.includes("/responses")) return "openai-responses"
  if (endpoints.includes("/chat/completions")) return "openai-completions"
  return undefined
}

function thinkingLevels(
  efforts: ReadonlyArray<string>,
): Record<string, string | null> {
  return Object.fromEntries(
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => {
      const effort = level === "off" ? "none" : level
      return [level, efforts.includes(effort) ? effort : null]
    }),
  )
}

function compatFor(api: PiModel["api"], model: Model): PiModel["compat"] {
  const supports = model.capabilities.supports
  if (api === "openai-completions") {
    return {
      maxTokensField: "max_tokens",
      supportsReasoningEffort: (supports.reasoning_effort?.length ?? 0) > 0,
    }
  }
  if (api === "anthropic-messages" && supports.adaptive_thinking)
    return { forceAdaptiveThinking: true }
  return undefined
}

function projectModel(
  model: Model,
  root: string,
  creditUsd: number,
): PiModel | undefined {
  const api = apiFor(model)
  if (!api) return
  const { supports, limits } = model.capabilities
  const contextWindow =
    limits.max_context_window_tokens ?? limits.max_prompt_tokens
  const maxTokens = limits.max_output_tokens
  if (!contextWindow || contextWindow <= 0 || !maxTokens || maxTokens <= 0)
    return
  const efforts = supports.reasoning_effort ?? []
  const cost = piCost(model, creditUsd)
  const compat = compatFor(api, model)
  return {
    id: model.id,
    name: model.name
      .replace(/^MAI-Code-/u, "MAI Code ")
      .replaceAll(/-Flash\b/gu, " Flash"),
    api,
    baseUrl: api === "anthropic-messages" ? root : `${root}/v1`,
    reasoning: supports.adaptive_thinking === true || efforts.length > 0,
    input: supports.vision ? ["text", "image"] : ["text"],
    contextWindow,
    maxTokens,
    ...(cost ? { cost } : {}),
    ...(efforts.length > 0 ?
      { thinkingLevelMap: thinkingLevels(efforts) }
    : {}),
    ...(limits.vision?.max_prompt_images ?
      {
        inputLimits: {
          images: { maxPerRequest: limits.vision.max_prompt_images },
        },
      }
    : {}),
    ...(compat ? { compat } : {}),
  }
}
