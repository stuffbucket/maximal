/**
 * Wire DTOs for the model-listing endpoints (`/models`, `/v1/models`).
 *
 * maximal serves one catalog to clients speaking different protocols, so the
 * response SHAPE must match the client's protocol — not leak the raw Copilot
 * model (which carries `billing`, `policy`, capability internals, etc.).
 *
 * Two explicit mappers convert a Copilot `Model` to a protocol wire shape:
 *   - `toOpenAiModel` / `openAiModelList` — the historical documented default
 *     (OpenAI `object:"list"` envelope). Used for OpenAI-style clients (Codex,
 *     the openai SDK, LiteLLM) and as the fallback when no protocol is signalled.
 *   - `toAnthropicModel` / `anthropicModelList` — the Anthropic Models API shape
 *     (`{data, first_id, has_more, last_id}`, entries with `type:"model"`,
 *     `display_name`, `created_at`, `max_input_tokens`, `max_tokens`, and a
 *     structured `capabilities` object). Used for Anthropic clients (Claude
 *     Desktop, the anthropic SDK), detected via the `anthropic-version` header
 *     or an anthropic/claude user-agent.
 *
 * Neither mapper spreads the source model, so no Copilot-internal field can
 * reach a client. See docs/spec/wire/models-wire-prd.md and ADR references.
 */

import type { Model } from "~/services/copilot/get-models"

import { forwardId } from "~/lib/models/anthropic-id-rewrite"

const EPOCH_ISO = new Date(0).toISOString()

// ── OpenAI shape ───────────────────────────────────────────────────────────

export interface OpenAiModel {
  id: string
  object: "model"
  created: number
  owned_by: string
}

export interface OpenAiModelList {
  object: "list"
  data: Array<OpenAiModel>
  has_more: false
}

export function toOpenAiModel(model: Model): OpenAiModel {
  return {
    id: forwardId(model.id),
    object: "model",
    created: 0,
    owned_by: model.vendor,
  }
}

export function openAiModelList(models: Array<Model>): OpenAiModelList {
  return {
    object: "list",
    data: models.map((model) => toOpenAiModel(model)),
    has_more: false,
  }
}

// ── Anthropic shape ──────────────────────────────────────────────────────────

interface CapabilitySupport {
  supported: boolean
}

export interface AnthropicModel {
  id: string
  type: "model"
  display_name: string
  created_at: string
  max_input_tokens: number
  max_tokens: number
  capabilities: {
    image_input: CapabilitySupport
    pdf_input: CapabilitySupport
    structured_outputs: CapabilitySupport
    thinking: CapabilitySupport
  }
}

export interface AnthropicModelList {
  data: Array<AnthropicModel>
  first_id: string | null
  has_more: boolean
  last_id: string | null
}

export function toAnthropicModel(model: Model): AnthropicModel {
  const { limits, supports } = model.capabilities
  const thinkingSupported =
    supports.adaptive_thinking === true
    || (supports.reasoning_effort?.length ?? 0) > 0
  return {
    id: forwardId(model.id),
    type: "model",
    display_name: model.name,
    // Anthropic permits an epoch when the release date is unknown; the Copilot
    // catalog doesn't carry one.
    created_at: EPOCH_ISO,
    max_input_tokens: limits.max_context_window_tokens ?? 0,
    max_tokens: limits.max_output_tokens ?? 0,
    capabilities: {
      image_input: { supported: supports.vision === true },
      pdf_input: { supported: false },
      structured_outputs: { supported: supports.structured_outputs === true },
      thinking: { supported: thinkingSupported },
    },
  }
}

export function anthropicModelList(models: Array<Model>): AnthropicModelList {
  const data = models.map((model) => toAnthropicModel(model))
  return {
    data,
    first_id: data[0]?.id ?? null,
    has_more: false,
    last_id: data.at(-1)?.id ?? null,
  }
}

// ── Protocol negotiation ─────────────────────────────────────────────────────

/**
 * Decide which wire shape a client wants. Anthropic clients send an
 * `anthropic-version` header on every request; Claude Desktop / the anthropic
 * SDK also carry an `anthropic/…` or `claude…` user-agent. Anything else —
 * including no signal at all — gets the historical OpenAI default.
 */
export function prefersAnthropicModels(headers: Headers): boolean {
  if (headers.get("anthropic-version")) return true
  const ua = headers.get("user-agent")?.toLowerCase() ?? ""
  return ua.startsWith("anthropic/") || ua.startsWith("claude")
}
