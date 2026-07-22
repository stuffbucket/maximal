/**
 * Resolving the "small / fast" model Claude Code should use for its haiku
 * tier (ANTHROPIC_DEFAULT_HAIKU_MODEL).
 *
 * This tier is NOT just for warmups — Claude Code routes background and
 * subagent work here, and that work makes tool calls. A weak model
 * (historically the default `gpt-5-mini`) produces malformed tool calls —
 * e.g. dropping a required field on a `SendMessage`-style tool — which the
 * client then rejects with a Zod `invalid_union` error. The haiku tier must
 * therefore be a *tool-competent* model.
 *
 * Rather than hardcode a model ID that rots as the catalog changes, we resolve
 * from the live model list by capability + family class:
 *   1. An explicitly configured / pre-set value always wins (honor the user).
 *   2. Otherwise prefer a Claude "haiku"-class model that supports tool calls.
 *   3. Otherwise any small tool-capable model.
 * The caller decides the final fallback when the catalog is empty.
 */

import type { Model } from "~/services/copilot/get-models"

import { resolveModelProfile } from "~/lib/models/model-profile"

/** A model is usable for the tool-calling haiku tier only if it can call tools. */
function supportsToolCalls(model: Model): boolean {
  return resolveModelProfile(model).supportsToolCalls
}

/** Claude haiku-class models identify their family as "claude" + a haiku name. */
function isHaikuClass(model: Model): boolean {
  const family = model.capabilities.family.toLowerCase()
  const id = model.id.toLowerCase()
  return (
    (family.includes("claude") || id.startsWith("claude"))
    && (family.includes("haiku") || id.includes("haiku"))
  )
}

/**
 * Choose the best tool-competent "small/fast" model for the haiku tier.
 *
 * @param models   the live model catalog (e.g. `state.models?.data`)
 * @param configured  an explicitly configured/pre-set model ID, if any
 * @returns the resolved model ID, or `undefined` if nothing suitable exists
 *          (the caller supplies the ultimate fallback)
 */
export function resolveSmallToolModel(
  models: Array<Model> | undefined,
  configured?: string,
): string | undefined {
  // 1. An explicit choice always wins — never override the user.
  if (configured && configured.trim().length > 0) {
    return configured
  }

  const catalog = models ?? []

  // 2. Prefer a tool-capable Claude haiku-class model (tracks the class, not a
  //    frozen string, so it follows catalog updates like haiku 4.5 → 4.6).
  const haiku = catalog.find(
    (model) => isHaikuClass(model) && supportsToolCalls(model),
  )
  if (haiku) {
    return haiku.id
  }

  // 3. Fall back to any tool-capable model so subagent tool calls still work.
  const toolCapable = catalog.find((model) => supportsToolCalls(model))
  return toolCapable?.id
}
