/**
 * ModelProfile — the single resolved record of "the truth about a model."
 *
 * maximal performs on-the-fly compensation over a default behavior for each
 * model (see ADR-0016, docs/spec/model-protocol-strategy.md). Historically that
 * compensation was expressed as per-model conditionals scattered across the
 * transform sites — each pass reaching into `model.capabilities.supports.*`
 * with its own predicate, plus hardcoded `if (model.id === "…")` literals welded
 * into individual passes. Cyclomatic complexity accumulated monotonically: every
 * new model added branches in several places, and nothing garbage-collected the
 * old ones.
 *
 * This resolver is the seam that bounds that growth. A transform asks for the
 * resolved profile ONCE and branches on DATA (profile.isReasoning) instead of
 * MODEL IDENTITY (model.id === "gpt-5.6-sol"). A brand-new model is then handled
 * by default — it inherits behavior from its catalog capabilities — so onboarding
 * becomes a config/data edit rather than another `if`.
 *
 * SCOPE: this holds INTRINSIC, catalog-derived facts (the `base_model` analog in
 * models.dev terms). Authored per-model tuning (extra prompts, reasoning-effort
 * overrides, responses context-management) still lives behind the config
 * accessors and is being consolidated separately (#336); once that lands, the
 * resolved tuning merges in here too, completing the ModelProfile picture (#338).
 *
 * CANDIDATES TO ABSORB NEXT — the per-model literal branches this resolver is
 * meant to replace, each becoming a labeled profile field instead of inline
 * logic in a transform:
 *   - `blocksChatCompletions` — chat-completions/handler.ts (`id === "gpt-5.4"`);
 *     ideally derived from `supported_endpoints`, not a literal.
 *   - `forcesSummarizedThinking` — preprocess.ts (`model === "claude-opus-4.7"`).
 *   - `skipsProxyHeaderInjection` — create-messages.ts
 *     (`startsWith("claude-opus-4.8")` WAF quirk).
 */

import type { Model } from "~/services/copilot/get-models"

export interface ModelProfile {
  /** Forward (client-facing) model id this profile was resolved for. */
  id: string

  // ── Reasoning / thinking ─────────────────────────────────────────────────
  // NOTE: these are INTENTIONALLY flat, not an exclusive `budget | effort`
  // discriminated union. A Copilot-served adaptive-thinking model (Claude) uses
  // BOTH mechanisms at once: a token budget (max/minThinkingBudget) AND an
  // effort ladder (reasoningEffortLadder, which applyAdaptiveThinking clamps the
  // output_config.effort into). An exclusive union would drop the ladder for
  // adaptive models. Effort-only models (GPT-5.x) carry a ladder but no adaptive
  // thinking. So the two capabilities are independent flags, not variants.
  /**
   * Does the model do extended reasoning at all? `adaptive_thinking` OR a
   * non-empty effort ladder. Drives the wire `thinking: supported` flag and the
   * Messages sampling-param strip (reasoning upstreams reject temperature etc.).
   */
  isReasoning: boolean
  /** Adaptive (budget-based) thinking — gates the applyAdaptiveThinking pass. */
  supportsAdaptiveThinking: boolean
  /**
   * Ordered reasoning-effort ladder (e.g. ["low","medium","high"]) used to clamp
   * a requested effort. `undefined` — NOT `[]` — when the model declares none, so
   * the clamp is skipped exactly as the original `if (ladder && …)` guard did.
   */
  reasoningEffortLadder?: ReadonlyArray<string>
  /** Upper bound of the thinking budget (0 when unset). */
  maxThinkingBudget: number
  /** Floor of the thinking budget (1024 when unset — the historical default). */
  minThinkingBudget: number

  // ── Input / output capabilities ──────────────────────────────────────────
  /** Vision: covers image_input + pdf_input on the wire. */
  supportsVision: boolean
  /** Tool-calling — haiku-tier eligibility. */
  supportsToolCalls: boolean
  /** Structured outputs — the wire `structured_outputs.supported` flag. */
  supportsStructuredOutputs: boolean

  // ── Token limits ─────────────────────────────────────────────────────────
  /** Context window; wire `max_input_tokens` (0 when unset). */
  maxContextWindowTokens: number
  /** Max output tokens; wire `max_tokens`, caps the thinking budget (0 unset). */
  maxOutputTokens: number
  /** Max prompt tokens; the Responses compaction threshold input (0 when unset). */
  maxPromptTokens: number
}

/**
 * Resolve the intrinsic profile for a catalog model. Pure over the model's
 * capabilities — no config I/O — so it is safe to call per-model in hot paths
 * (e.g. once per model when rendering the catalog) and trivial to unit test.
 *
 * Reads capabilities DEFENSIVELY (mirroring the settings-list route): a sparse
 * or un-normalized entry — a missing `capabilities` / `limits` / `supports`
 * container, or an absent leaf — resolves to a CONSERVATIVE default (booleans
 * false, limits 0, the effort ladder undefined). An unmodeled capability is
 * thus treated as not-supported, never leaked as supported — the one inversion
 * of LLVM's permissive "unlisted = legal" default, because a proxy that forwards
 * an unsupported field upstream is a miscompile.
 */
export function resolveModelProfile(model: Model): ModelProfile {
  const capabilities =
    (model as { capabilities?: Partial<Model["capabilities"]> }).capabilities
    ?? {}
  const limits = capabilities.limits ?? {}
  const supports = capabilities.supports ?? {}
  const ladder = supports.reasoning_effort
  return {
    id: model.id,
    isReasoning:
      supports.adaptive_thinking === true || (ladder?.length ?? 0) > 0,
    supportsAdaptiveThinking: supports.adaptive_thinking === true,
    reasoningEffortLadder: ladder && ladder.length > 0 ? ladder : undefined,
    maxThinkingBudget: supports.max_thinking_budget ?? 0,
    minThinkingBudget: supports.min_thinking_budget ?? 1024,
    supportsVision: supports.vision === true,
    supportsToolCalls: supports.tool_calls === true,
    supportsStructuredOutputs: supports.structured_outputs === true,
    maxContextWindowTokens: limits.max_context_window_tokens ?? 0,
    maxOutputTokens: limits.max_output_tokens ?? 0,
    maxPromptTokens: limits.max_prompt_tokens ?? 0,
  }
}
