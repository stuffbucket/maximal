import consola from "consola"

import { copilotBaseUrl, copilotModelsHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { GITHUB_API_TIMEOUT_MS } from "~/lib/http-timeouts"
import { sendRequest } from "~/lib/send-request"
import { state } from "~/lib/state"

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

  const parsed = (await response.json()) as Partial<ModelsResponse>
  return {
    ...parsed,
    object: parsed.object ?? "list",
    data: (parsed.data ?? []).map((model) => normalizeModel(model)),
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
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
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
  reasoning_effort?: Array<string>
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
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
  supported_endpoints?: Array<string>
  /** Per-model billing metadata. `is_premium` flags whether the model
   *  counts against premium quota. `multiplier` is legacy — under
   *  usage-based billing Copilot warns it no longer applies (the real
   *  per-request cost is `copilot_usage.total_nano_aiu` on completions). */
  billing?: {
    is_premium?: boolean
    multiplier?: number
  }
}
