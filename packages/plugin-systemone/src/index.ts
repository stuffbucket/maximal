/**
 * `@stuffbucket/maximal-plugin-systemone` — serves the `systemone` operation
 * (`/v1/systemone`): each configured binding names a client-facing model and
 * the provider model that answers it. Exports the plugin module (`name`,
 * `manifest`, `inject`, `Config`, `apply`).
 */
import type { Context, PluginModule } from "@stuffbucket/maximal-plugin-sdk"

import {
  bindingsStatus,
  plainUsage,
  relayOperation,
  serverToolWhileAvailable,
} from "@stuffbucket/maximal-plugin-sdk"

import { classifyTool } from "./classify"
import { SYSTEMONE_MANIFEST, type SystemOneConfig } from "./manifest"

export const name = SYSTEMONE_MANIFEST.id

export const inject = [
  "operations",
  "providers",
  "serverTools",
  "surface",
] as const

const PATH = "/v1/systemone"

export const apply: PluginModule<SystemOneConfig>["apply"] = (
  ctx: Context,
  config: SystemOneConfig,
) => {
  ctx.operations.register({
    operation: "systemone",
    bindings: config.bindings,
    handle: (request) =>
      relayOperation(ctx, request, {
        path: PATH,
        errorMessage: "Failed to create SystemOne decisions",
        usage: (reply) => plainUsage(reply.usage),
      }),
  })

  const tool =
    config.tools.classify ?
      serverToolWhileAvailable(
        ctx,
        config.bindings,
        classifyTool(ctx, config, PATH),
      )
    : undefined
  // The tool is offered to Claude only while the model is.
  const refresh = () => {
    ctx.surface.setStatus(bindingsStatus(ctx, config.bindings, PATH))
    tool?.sync()
  }
  refresh()
  // The catalog (and so "is the model on this account's plan") changes after
  // sign-in and on every refresh.
  for (const providerId of new Set(
    config.bindings.map((binding) => binding.provider),
  )) {
    const provider = ctx.providers.get(providerId)
    if (provider) ctx.effect(() => provider.onCatalogChange(refresh), "catalog")
  }
}

export { Config, SYSTEMONE_MANIFEST as manifest } from "./manifest"
