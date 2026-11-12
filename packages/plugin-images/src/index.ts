/**
 * `@stuffbucket/maximal-plugin-images` — serves the `images.generations` and
 * `images.edits` operations (`/v1/images/generations`, `/v1/images/edits`):
 * each configured binding names a client-facing model and the provider model
 * that answers it. An edit may be JSON or a multipart form; the form is
 * re-sent as a form. It also gives Claude Code the `generate_image` and
 * `edit_image` server tools, which save files and answer with their paths
 * (`tools.ts`); the first billed call waits for the person's approval
 * (`approval.ts`). Exports the plugin module (`name`, `manifest`, `inject`,
 * `Config`, `apply`).
 */
import type { Context, PluginModule } from "@stuffbucket/maximal-plugin-sdk"

import { bindingsStatus, relayOperation } from "@stuffbucket/maximal-plugin-sdk"
import path from "node:path"

import { createApproval } from "./approval"
import { IMAGES_MANIFEST, type ImagesConfig } from "./manifest"
import {
  EDITS_PATH,
  EDITS_SPEC,
  GENERATIONS_PATH,
  GENERATIONS_SPEC,
} from "./specs"
import { imageTools } from "./tools"

export const name = IMAGES_MANIFEST.id

export const inject = [
  "operations",
  "providers",
  "serverTools",
  "storage",
  "surface",
] as const

/** The folder under the plugin's storage where the tools save images by default. */
export const DEFAULT_OUTPUT_FOLDER = "output"

export const apply: PluginModule<ImagesConfig>["apply"] = async (
  ctx: Context,
  config: ImagesConfig,
) => {
  ctx.operations.register({
    operation: "images.generations",
    bindings: config.bindings,
    handle: (request) => relayOperation(ctx, request, GENERATIONS_SPEC),
  })
  ctx.operations.register({
    operation: "images.edits",
    bindings: config.bindings,
    handle: (request) => relayOperation(ctx, request, EDITS_SPEC),
  })

  const approval = await createApproval(
    ctx,
    config.generateImage || config.editImage,
    () => {
      refresh()
    },
  )
  const refresh = () =>
    ctx.surface.setStatus(
      approval.decorate(
        bindingsStatus(
          ctx,
          config.bindings,
          `${GENERATIONS_PATH} and ${EDITS_PATH}`,
        ),
      ),
    )
  refresh()

  const [binding] = config.bindings
  for (const tool of imageTools(
    ctx,
    {
      binding,
      bindings: config.bindings,
      outputDir:
        config.outputDir ?? path.join(ctx.storage.dir, DEFAULT_OUTPUT_FOLDER),
      gate: approval.gate,
    },
    { generate: config.generateImage, edit: config.editImage },
  )) {
    ctx.serverTools.register(tool)
  }

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
