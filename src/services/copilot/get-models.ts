import consola from "consola"

import { copilotBaseUrl, copilotModelsHeaders } from "~/lib/config/api-config"
import { HTTPError } from "~/lib/errors/error"
import { GITHUB_API_TIMEOUT_MS } from "~/lib/http/http-timeouts"
import { sendRequest } from "~/lib/http/send-request"
import { state } from "~/lib/runtime-state/state"

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
    data: parsed.data.map((model) => normalizeModel(model as Model)),
  }
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
