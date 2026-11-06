import consola from "consola"
import { z } from "zod"

import { copilotBaseUrl, copilotModelsHeaders } from "~/lib/config/api-config"
import { HTTPError } from "~/lib/errors/error"
import { GITHUB_API_TIMEOUT_MS } from "~/lib/http/http-timeouts"
import { sendRequest } from "~/lib/http/send-request"
import { state } from "~/lib/runtime-state/state"

const tokenPriceTierSchema = z
  .object({
    cache_read_price: z.number().optional(),
    cache_write_1h_price: z.number().optional(),
    cache_write_price: z.number().optional(),
    input_price: z.number().optional(),
    max_prompt_tokens: z.number().optional(),
    output_price: z.number().optional(),
  })
  .catchall(z.number())

const tokenPricesSchema = z
  .object({
    batch_size: z.number().optional(),
    default: tokenPriceTierSchema.optional(),
    long_context: tokenPriceTierSchema.optional(),
    preferred_tier: z.string().optional(),
    input: z.number().optional(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
    output: z.number().optional(),
  })
  .catchall(z.union([z.number(), z.string(), tokenPriceTierSchema, z.null()]))

const modelSchema = z
  .object({
    id: z.string(),
    model_picker_enabled: z.boolean(),
    name: z.string(),
    object: z.string(),
    preview: z.boolean(),
    vendor: z.string(),
    version: z.string(),
    is_chat_default: z.boolean().optional(),
    is_chat_fallback: z.boolean().optional(),
    model_picker_category: z.string().optional(),
    model_picker_price_category: z.string().optional(),
    description: z.string().optional(),
    info_messages: z
      .array(z.object({ code: z.string(), message: z.string() }))
      .optional(),
    policy: z.object({ state: z.string(), terms: z.string() }).optional(),
    supported_endpoints: z.array(z.string()).optional(),
    billing: z
      .object({
        auto_discount: z.number().optional(),
        restricted_to: z.array(z.string()).optional(),
        is_premium: z.boolean().optional(),
        multiplier: z.number().optional(),
        token_prices: tokenPricesSchema.optional(),
      })
      .optional(),
    capabilities: z
      .object({
        family: z.string().optional(),
        object: z.string().optional(),
        tokenizer: z.string().optional(),
        type: z.string().optional(),
        limits: z
          .object({
            max_context_window_tokens: z.number().optional(),
            max_non_streaming_output_tokens: z.number().optional(),
            max_output_tokens: z.number().optional(),
            max_prompt_tokens: z.number().optional(),
            max_inputs: z.number().optional(),
            vision: z
              .object({
                max_prompt_image_size: z.number().optional(),
                max_prompt_images: z.number().optional(),
                supported_media_types: z.array(z.string()).optional(),
              })
              .optional(),
          })
          .loose()
          .optional(),
        supports: z
          .object({
            max_thinking_budget: z.number().optional(),
            min_thinking_budget: z.number().optional(),
            tool_calls: z.boolean().optional(),
            parallel_tool_calls: z.boolean().optional(),
            dimensions: z.boolean().optional(),
            streaming: z.boolean().optional(),
            structured_outputs: z.boolean().optional(),
            vision: z.boolean().optional(),
            adaptive_thinking: z.boolean().optional(),
            context_editing: z.boolean().optional(),
            prediction: z.boolean().optional(),
            reasoning_effort: z.array(z.string()).optional(),
            tool_search: z.boolean().optional(),
          })
          .loose()
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose()

export const getModels = async () => {
  consola.info(`Fetching models from ${copilotBaseUrl(state)}/models`)
  const response = await sendRequest(`${copilotBaseUrl(state)}/models`, {
    headers: copilotModelsHeaders(state),
    // Bounded like the other auth/discovery fetches — cacheModels runs on the
    // cold-boot critical path, so an unbounded hang here would stall boot.
    timeoutMs: GITHUB_API_TIMEOUT_MS,
  })

  if (!response.ok) {
    const errorText = await response.clone().text()

    consola.error("Failed to get models response body", errorText)

    throw new HTTPError("Failed to get models", response)
  }

  return normalizeModelsResponse(await response.json())
}

export function normalizeModelsResponse(raw: unknown): ModelsResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new TypeError("Invalid Copilot models response: expected an object")
  }

  const parsed = raw as Record<string, unknown>
  if (!Array.isArray(parsed.data)) {
    throw new TypeError(
      "Invalid Copilot models response: expected a data array",
    )
  }

  return {
    ...parsed,
    object: typeof parsed.object === "string" ? parsed.object : "list",
    data: parsed.data.map((model) => parseModel(model)),
  }
}

function parseModel(raw: unknown): Model {
  const parsed = modelSchema.parse(raw)
  const capabilities = parsed.capabilities ?? {}
  return normalizeModel({
    ...parsed,
    capabilities: {
      ...capabilities,
      family: capabilities.family ?? "",
      type: capabilities.type ?? "",
      tokenizer: capabilities.tokenizer ?? "o200k_base",
      object: capabilities.object ?? "model_capabilities",
      limits: capabilities.limits ?? {},
      supports: capabilities.supports ?? {},
    },
  })
}

/**
 * Copilot's catalog is not uniform: some entries omit `capabilities`, or
 * `capabilities.limits` / `capabilities.supports`, even though the static
 * `Model` type declares them required. The rest of the app trusts that
 * shape — the boot-time model filter, thinking-budget math, `max_tokens`
 * auto-fill — so a single sparse entry used to throw and take down the
 * whole critical path (a failed catalog refresh leaves no usable models).
 *
 * Normalize once here, at the single fetch boundary every consumer reads
 * through, so the container objects are guaranteed present. We deliberately
 * do NOT invent leaf values: a genuinely-absent `max_context_window_tokens`
 * stays `undefined` so the UI renders it as "missing" rather than a made-up
 * number. The principle: secondary metadata gaps degrade gracefully; they
 * never error out the critical path.
 */
export function normalizeModel(raw: Model): Model {
  const capabilities =
    (raw as { capabilities?: Partial<ModelCapabilities> }).capabilities ?? {}
  return {
    ...raw,
    capabilities: {
      family: capabilities.family ?? "",
      type: capabilities.type ?? "",
      tokenizer: capabilities.tokenizer ?? "o200k_base",
      object: capabilities.object ?? "model_capabilities",
      limits: capabilities.limits ?? {},
      supports: capabilities.supports ?? {},
    },
  }
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_non_streaming_output_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
  vision?: {
    max_prompt_image_size?: number
    max_prompt_images?: number
    supported_media_types?: Array<string>
  }
}

interface ModelSupports {
  max_thinking_budget?: number
  min_thinking_budget?: number
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  streaming?: boolean
  structured_outputs?: boolean
  vision?: boolean
  adaptive_thinking?: boolean
  context_editing?: boolean
  prediction?: boolean
  reasoning_effort?: Array<string>
  tool_search?: boolean
  [key: string]: unknown
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  is_chat_default?: boolean
  is_chat_fallback?: boolean
  model_picker_category?: string
  model_picker_enabled: boolean
  model_picker_price_category?: string
  name: string
  description?: string
  object: string
  preview: boolean
  vendor: string
  version: string
  info_messages?: Array<{
    code: string
    message: string
  }>
  policy?: {
    state: string
    terms: string
  }
  supported_endpoints?: Array<string>
  /** Per-model billing metadata — Copilot-specific (see ADR-0016,
   *  divergence 1). A second provider would carry its own price sheet or
   *  none; nothing here transfers.
   *
   *  PRIMARY signal: `token_prices`. Since the 2026-06-01 per-token billing
   *  change, Copilot advertises per-model rates here. A model with any
   *  non-zero rate is paid — this is what pricing/premium inference should
   *  key on (see `resolveIsPaid` in `src/lib/token-usage/index.ts`).
   *
   *  LEGACY fallback: `is_premium` / `multiplier`. Under usage-based billing
   *  Copilot warns the multiplier no longer applies and `is_premium === false`
   *  no longer means "free" (e.g. gpt-5-mini is cheap-but-not-free). These are
   *  retained only for annual-plan accounts that still lack `token_prices`.
   *  (The actual per-request cost is `copilot_usage.total_nano_aiu` on
   *  completions — captured separately, not from this field.) */
  billing?: {
    auto_discount?: number
    restricted_to?: Array<string>
    /** LEGACY. Premium-quota flag; unreliable under usage-based billing. */
    is_premium?: boolean
    /** LEGACY. Per-model multiplier; retained for annual plans only. */
    multiplier?: number
    /** PRIMARY. Per-model token rates. Copilot currently nests rates under
     *  `default` and optional context tiers; older catalogs used flat keys. */
    token_prices?: TokenPrices
  }
}

/** One pricing tier from the current Copilot catalog. Rates are advertised
 * separately for the default and long-context windows. `max_prompt_tokens` is
 * a threshold, not a price, and must not affect paid/free classification. */
export interface TokenPriceTier {
  cache_read_price?: number
  cache_write_1h_price?: number
  cache_write_price?: number
  input_price?: number
  max_prompt_tokens?: number
  output_price?: number
  [key: string]: number | undefined
}

/** Copilot's per-model `token_prices` (ADR-0016 divergence 1). The current
 * schema nests rates under `default` and optional context tiers. Flat keys are
 * retained for compatibility with older catalogs. `preferred_tier` is routing
 * metadata, not a rate. */
export interface TokenPrices {
  batch_size?: number
  default?: TokenPriceTier
  long_context?: TokenPriceTier
  preferred_tier?: string
  input?: number
  cache_read?: number
  cache_write?: number
  output?: number
  [key: string]: number | string | TokenPriceTier | null | undefined
}

const legacyPriceKeys = new Set([
  "input",
  "cache_read",
  "cache_write",
  "output",
])

/**
 * Interpret a model's `token_prices` as the paid/free signal.
 *
 * Returns:
 *   - `true`  — at least one advertised rate is > 0 ⇒ the model is paid.
 *   - `false` — rates are present and every finite rate is 0.
 *   - `null`  — no usable rates; fall back to the legacy `is_premium` signal.
 *
 * Counts and thresholds (`batch_size`, `max_prompt_tokens`) are deliberately
 * excluded: they are positive even for models whose actual token rates are 0.
 */
export function pricedModelIsPaid(
  prices: TokenPrices | null | undefined,
): boolean | null {
  if (!prices) return null

  const rates: Array<number> = []
  for (const [key, value] of Object.entries(prices)) {
    if (
      typeof value === "number"
      && Number.isFinite(value)
      && (legacyPriceKeys.has(key) || key.endsWith("_price"))
    ) {
      rates.push(value)
      continue
    }

    if (typeof value !== "object" || value === null) continue
    for (const [tierKey, rate] of Object.entries(value)) {
      if (
        tierKey.endsWith("_price")
        && typeof rate === "number"
        && Number.isFinite(rate)
      ) {
        rates.push(rate)
      }
    }
  }

  if (rates.length === 0) return null
  return rates.some((rate) => rate > 0)
}
