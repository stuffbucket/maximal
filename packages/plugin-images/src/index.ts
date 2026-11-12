/**
 * `@stuffbucket/maximal-plugin-images` — serves the `images.generations` and
 * `images.edits` operations (`/v1/images/generations`, `/v1/images/edits`):
 * each configured binding names a client-facing model and the provider model
 * that answers it. An edit may be JSON or a multipart form; the form is
 * re-sent as a form. Exports the plugin module (`name`, `manifest`, `inject`,
 * `Config`, `apply`).
 */
import type { Context, PluginModule } from "@stuffbucket/maximal-plugin-sdk"

import {
  bindingsStatus,
  relayOperation,
  responsesUsage,
} from "@stuffbucket/maximal-plugin-sdk"

import { IMAGES_MANIFEST, type ImagesConfig } from "./manifest"

export const name = IMAGES_MANIFEST.id

export const inject = ["operations", "providers", "surface"] as const

const GENERATIONS_PATH = "/v1/images/generations"
const EDITS_PATH = "/v1/images/edits"

export const apply: PluginModule<ImagesConfig>["apply"] = (
  ctx: Context,
  config: ImagesConfig,
) => {
  ctx.operations.register({
    operation: "images.generations",
    bindings: config.bindings,
    handle: (request) =>
      relayOperation(ctx, request, {
        path: GENERATIONS_PATH,
        errorMessage: "Failed to generate images",
        usage: (reply) => responsesUsage(reply.usage),
      }),
  })
  ctx.operations.register({
    operation: "images.edits",
    bindings: config.bindings,
    handle: (request) =>
      relayOperation(ctx, request, {
        path: EDITS_PATH,
        errorMessage: "Failed to edit images",
        usage: (reply) => responsesUsage(reply.usage),
      }),
  })

  const refresh = () =>
    ctx.surface.setStatus(
      bindingsStatus(
        ctx,
        config.bindings,
        `${GENERATIONS_PATH} and ${EDITS_PATH}`,
      ),
    )
  refresh()
  // The catalog (and so "is the model offered to this account") changes after
  // sign-in and on every refresh.
  for (const providerId of new Set(
    config.bindings.map((binding) => binding.provider),
  )) {
    const provider = ctx.providers.get(providerId)
    if (provider) ctx.effect(() => provider.onCatalogChange(refresh), "catalog")
  }
}

export { Config, IMAGES_MANIFEST as manifest } from "./manifest"
