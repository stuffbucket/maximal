/**
 * `@stuffbucket/maximal-plugin-decisions` — serves the `decisions` operation
 * (`/v1/decisions`, the OpenAI Decisions API): each configured binding names
 * a client-facing model and the provider model that answers it. Exports the
 * plugin module (`name`, `manifest`, `inject`, `Config`, `apply`).
 */
import type { Context, PluginModule } from "@stuffbucket/maximal-plugin-sdk"

import {
  bindingsStatus,
  relayOperation,
  responsesUsage,
} from "@stuffbucket/maximal-plugin-sdk"

import { DECISIONS_MANIFEST, type DecisionsConfig } from "./manifest"

export const name = DECISIONS_MANIFEST.id

export const inject = ["operations", "providers", "surface"] as const

const PATH = "/v1/decisions"

export const apply: PluginModule<DecisionsConfig>["apply"] = (
  ctx: Context,
  config: DecisionsConfig,
) => {
  ctx.operations.register({
    operation: "decisions",
    bindings: config.bindings,
    handle: (request) =>
      relayOperation(ctx, request, {
        path: PATH,
        errorMessage: "Failed to create decisions",
        usage: (reply) => responsesUsage(reply.usage),
      }),
  })

  const refresh = () =>
    ctx.surface.setStatus(bindingsStatus(ctx, config.bindings, PATH))
  refresh()
  // The catalog (and so "is the model offered to this account") changes
  // after sign-in and on every refresh.
  for (const providerId of new Set(
    config.bindings.map((binding) => binding.provider),
  )) {
    const provider = ctx.providers.get(providerId)
    if (provider) ctx.effect(() => provider.onCatalogChange(refresh), "catalog")
  }
}

export { Config, DECISIONS_MANIFEST as manifest } from "./manifest"
