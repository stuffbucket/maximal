import type { PluginModule } from "@stuffbucket/maximal-plugin-sdk"

import { FigjamController, type FigjamPluginOptions } from "./controller"
import { Config, type FigjamConfig, FIGJAM_MANIFEST } from "./manifest"

/** Build the FigJam plugin module (the package entry exports the default instance). */
export function createFigjamPlugin(
  options: FigjamPluginOptions = {},
): PluginModule<FigjamConfig> {
  return {
    name: FIGJAM_MANIFEST.id,
    manifest: FIGJAM_MANIFEST,
    inject: ["surface", "storage", "host"],
    Config,
    apply: (ctx, config) => {
      const controller = new FigjamController(ctx, config, options)
      controller.start()
    },
  }
}
