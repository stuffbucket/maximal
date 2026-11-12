/**
 * `@stuffbucket/maximal-plugin-figjam` — runs the FigJam bridge inside
 * Maximal, writes the Figma development plugin, and lets the person approve
 * FigJam panels from Integrations. Exports the plugin module (`name`,
 * `manifest`, `inject`, `Config`, `apply`).
 */
import { createFigjamPlugin } from "./plugin"

const plugin = createFigjamPlugin()

export const name = plugin.name
export const manifest = plugin.manifest
export const inject = plugin.inject
export const Config = plugin.Config
export const apply: typeof plugin.apply = (ctx, config) =>
  plugin.apply(ctx, config)

export { type FigjamPluginOptions, FIGMA_PLUGIN_DIR } from "./controller"
export {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_MAXIMAL_PORT,
  FIGJAM_MANIFEST,
  type FigjamConfig,
} from "./manifest"
export { createFigjamPlugin } from "./plugin"
export { IMPORT_INSTRUCTIONS } from "./status"
