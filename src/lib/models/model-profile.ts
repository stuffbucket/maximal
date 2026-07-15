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

import {
  isReasoningModel,
  modelSupportsVision,
} from "~/services/copilot/get-models"

export interface ModelProfile {
  /** Forward (client-facing) model id this profile was resolved for. */
  id: string
  /**
   * Does the model do extended reasoning? Drives two behaviors that used to be
   * derived independently and could drift: the models wire mapper reports
   * `thinking: supported`, and the Messages preprocessor strips raw sampling
   * params (temperature/top_p/top_k) that reasoning upstreams reject.
   */
  isReasoning: boolean
  /**
   * Does the model accept image / PDF document inputs? Copilot advertises one
   * `vision` flag covering both, so the wire mapper's `image_input` and
   * `pdf_input` both track this.
   */
  supportsVision: boolean
}

/**
 * Resolve the intrinsic profile for a catalog model. Pure over the model's
 * capabilities — no config I/O — so it is safe to call per-model in hot paths
 * (e.g. once per model when rendering the catalog) and trivial to unit test.
 */
export function resolveModelProfile(model: Model): ModelProfile {
  return {
    id: model.id,
    isReasoning: isReasoningModel(model),
    supportsVision: modelSupportsVision(model),
  }
}
