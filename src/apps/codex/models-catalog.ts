/**
 * Codex's own model catalog, built from the Copilot models Codex can drive.
 *
 * Codex asks `/models?client_version=…` for `{ models: [ModelInfo] }` and
 * merges the answer into its bundled catalog, slug by slug. Every entry must
 * carry Codex's system prompt, so — like LiteLLM and opencodex — we answer
 * from a pinned snapshot of Codex's own catalog (`data/codex-catalog.json`,
 * refreshed by `scripts/pin-codex-catalog.ts`):
 *
 *   - a model Codex already knows keeps Codex's tuned entry (prompt, tools),
 *     with the backend-specific parts a Copilot route can't honor removed and
 *     its limits and efforts clipped to what Copilot actually serves;
 *   - any other model gets Codex's own fallback prompt — what Codex uses for
 *     an unknown model anyway — plus Copilot's limits and efforts.
 *
 * Each model reviews with itself (`auto_review_model_override`). Codex's
 * automatic permission review runs at low effort and would otherwise ask for
 * `codex-auto-review`, which Copilot doesn't serve; a review doesn't need a
 * bigger model than the task.
 */

import type { Model } from "~/services/copilot/get-models"

import pinned from "./data/codex-catalog.json" with { type: "json" }

/** A Codex `ModelInfo` entry. Kept loose: a known model passes Codex's own
 *  fields through, so the shape tracks whatever the pinned release has. */
export type CodexModelInfo = Record<string, unknown> & { slug: string }

interface ReasoningLevel {
  effort: string
  description: string
}

const RESPONSES_ENDPOINT = "/responses"

const BUNDLED = new Map(
  (pinned.models as Array<CodexModelInfo>).map((entry) => [entry.slug, entry]),
)

/** Codex's descriptions for the efforts Copilot reports. */
const EFFORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  none: "No reasoning",
  minimal: "Minimal reasoning for the fastest responses",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
}

/** Settings in Codex's entries that assume OpenAI's own backend: WebSocket
 *  transport, Responses Lite, paid service tiers, hosted search. */
const OPENAI_BACKEND_ONLY: Readonly<CodexModelInfo> = {
  slug: "",
  prefer_websockets: false,
  use_responses_lite: false,
  service_tiers: [],
  additional_speed_tiers: [],
  default_service_tier: null,
  supports_search_tool: false,
}

/** Copilot's input-token limit for a model, if it states one. */
function inputLimit(model: Model): number | undefined {
  const { limits } = model.capabilities
  return limits.max_prompt_tokens ?? limits.max_context_window_tokens
}

function copilotEfforts(model: Model): Array<string> {
  return model.capabilities.supports.reasoning_effort ?? []
}

/** Keep the levels Copilot serves, in Codex's order and wording. */
function clipLevels(
  levels: Array<ReasoningLevel>,
  served: Array<string>,
): Array<ReasoningLevel> {
  return levels.filter((level) => served.includes(level.effort))
}

function defaultEffort(
  levels: Array<ReasoningLevel>,
  preferred: unknown,
): string | undefined {
  const efforts = levels.map((level) => level.effort)
  if (typeof preferred === "string" && efforts.includes(preferred)) {
    return preferred
  }
  return efforts.includes("medium") ? "medium" : efforts[0]
}

/** Clamp a token count to Copilot's limit; keep it when Copilot states none. */
function clamp(value: unknown, limit: number | undefined): number | undefined {
  const n = typeof value === "number" ? value : undefined
  if (limit === undefined) return n
  return n === undefined ? limit : Math.min(n, limit)
}

function fromBundled(template: CodexModelInfo, model: Model): CodexModelInfo {
  const limit = inputLimit(model)
  const levels = clipLevels(
    template.supported_reasoning_levels as Array<ReasoningLevel>,
    copilotEfforts(model),
  )
  const entry: CodexModelInfo = {
    ...template,
    ...OPENAI_BACKEND_ONLY,
    slug: model.id,
    visibility: "list",
    supported_reasoning_levels: levels,
    context_window: clamp(template.context_window, limit),
    max_context_window: clamp(template.max_context_window, limit),
  }
  const effort = defaultEffort(levels, template.default_reasoning_level)
  if (effort) entry.default_reasoning_level = effort
  else delete entry.default_reasoning_level
  const compact = entry.auto_compact_token_limit
  if (typeof compact === "number" && limit !== undefined && compact > limit) {
    delete entry.auto_compact_token_limit
  }
  return entry
}

/** Codex's fallback for an unknown model (`model_info_from_slug`), with the
 *  facts Copilot gives us filled in. */
function fromCopilot(model: Model): CodexModelInfo {
  const limit = inputLimit(model)
  const levels = copilotEfforts(model).map((effort) => ({
    effort,
    description: EFFORT_DESCRIPTIONS[effort] ?? effort,
  }))
  const effort = defaultEffort(levels, undefined)
  return {
    ...OPENAI_BACKEND_ONLY,
    slug: model.id,
    display_name: model.name,
    description: model.description ?? null,
    ...(effort ? { default_reasoning_level: effort } : {}),
    supported_reasoning_levels: levels,
    shell_type: "default",
    visibility: "list",
    supported_in_api: true,
    priority: 99,
    availability_nux: null,
    upgrade: null,
    base_instructions: pinned.fallbackInstructions,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: "bytes", limit: 10_000 },
    supports_parallel_tool_calls: false,
    ...(limit === undefined ?
      {}
    : { context_window: limit, max_context_window: limit }),
    experimental_supported_tools: [],
    input_modalities:
      model.capabilities.supports.vision === true ?
        ["text", "image"]
      : ["text"],
  }
}

/** Codex can drive a model only over the Responses API. */
function drivableByCodex(model: Model): boolean {
  return model.supported_endpoints?.includes(RESPONSES_ENDPOINT) === true
}

export function codexModelCatalog(models: Array<Model>): Array<CodexModelInfo> {
  return models
    .filter((model) => drivableByCodex(model))
    .map((model) => {
      const template = BUNDLED.get(model.id)
      const entry = template ? fromBundled(template, model) : fromCopilot(model)
      entry.auto_review_model_override = model.id
      return entry
    })
}

/** Codex marks its catalog requests with `?client_version=`; nothing else
 *  sends it, so every other client keeps the shape it gets today. */
export function wantsCodexCatalog(url: string): boolean {
  return new URL(url).searchParams.has("client_version")
}
