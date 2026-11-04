/**
 * `@stuffbucket/maximal-plugin-workiq` — Microsoft Work IQ as a maximal
 * connector, built on `@stuffbucket/maximal-connector-kit`. Exports the
 * plugin module (`name`, `manifest`, `inject`, `Config`, `apply`).
 */
import { createWorkIqPlugin } from "./plugin"

const plugin = createWorkIqPlugin()

export const name = plugin.name
export const manifest = plugin.manifest
export const inject = plugin.inject
export const Config = plugin.Config
export const apply: typeof plugin.apply = (ctx, config) =>
  plugin.apply(ctx, config)

export {
  DEFAULT_AUTHORITY,
  DEFAULT_ENDPOINT,
  REDIRECT_URI,
  TERMS_URL,
  WORKIQ_CLIENT_ID,
  WORKIQ_MANIFEST,
  WORKIQ_SCOPES,
} from "./manifest"
export { createWorkIqPlugin, type WorkIqPluginOptions } from "./plugin"
export {
  inspectWorkIqResult,
  primaryPath,
  WORKIQ_LIMITS,
  WORKIQ_THROTTLE,
  workIqKind,
  workIqLane,
} from "./throttle"
export { WORKIQ_ERRORS, WORKIQ_WORDING } from "./wording"
