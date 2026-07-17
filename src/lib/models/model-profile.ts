/**
 * ModelProfile — the single resolved record of "the truth about a model."
 *
 * maximal performs on-the-fly compensation over a default behavior for each
 * model. Historically that compensation was expressed as per-model conditionals
 * scattered across the transform sites — each pass reaching into
 * `model.capabilities.supports.*` with its own predicate. Cyclomatic complexity
 * accumulated monotonically: every new model added branches in several places.
 *
 * This resolver is the seam that bounds that growth. A transform asks for the
 * resolved profile ONCE and branches on DATA (`profile.isReasoning`) instead of
 * MODEL IDENTITY. A brand-new model is handled by default from its catalog
 * capabilities, so onboarding becomes a data edit rather than another `if`.
 *
 * SCOPE: this holds INTRINSIC, catalog-derived facts. Authored per-model tuning
 * (extra prompts, reasoning-effort overrides) stays behind the config accessors.
 * NOTE: default reasoning EFFORT is deliberately NOT resolved here — that policy
 * lives in `getReasoningEffortForModel` / `defaultReasoningEffortForModel`
 * (config.ts). This record is capability facts only.
 *
 * Reads capabilities DEFENSIVELY (mirroring the settings-list route): a sparse
 * or un-normalized entry — a missing container or absent leaf — resolves to a
 * CONSERVATIVE default (booleans false), so an unmodeled capability is treated
 * as not-supported, never leaked upstream as supported.
 */

import type { Model } from "~/services/copilot/get-models"

export interface ModelProfile {
  /** Forward (client-facing) model id this profile was resolved for. */
  id: string
  /**
   * Does the model do extended reasoning? `adaptive_thinking` OR a non-empty
   * reasoning-effort ladder. Drives the wire `thinking: supported` flag and the
   * Messages sampling-param strip (reasoning upstreams reject temperature etc.).
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
 * and trivial to unit test.
 */
export function resolveModelProfile(model: Model): ModelProfile {
  const capabilities =
    (model as { capabilities?: Partial<Model["capabilities"]> }).capabilities
    ?? {}
  const supports = capabilities.supports ?? {}
  return {
    id: model.id,
    isReasoning:
      supports.adaptive_thinking === true
      || (supports.reasoning_effort?.length ?? 0) > 0,
    supportsVision: supports.vision === true,
  }
}
