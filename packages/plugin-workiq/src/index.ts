/**
 * `@stuffbucket/maximal-plugin-workiq` — Microsoft Work IQ as a maximal
 * plugin. Exports the plugin module (`name`, `meta`, `inject`, `Config`,
 * `apply`); the logic lives in the modules re-exported below.
 */
import { Config as ConfigSchema } from "./config"
import { createWorkIqPlugin } from "./plugin"

const plugin = createWorkIqPlugin()

export const Config = ConfigSchema
export type Config = ConfigSchema
export const apply: typeof plugin.apply = (ctx, config) =>
  plugin.apply(ctx, config)

export { TOKEN_CACHE_FILE } from "./auth/msal"
export type { TokenProvider, WorkIqAccount } from "./auth/token-provider"
export {
  DEFAULT_AUTHORITY,
  DEFAULT_ENDPOINT,
  TERMS_URL,
  WORKIQ_CLIENT_ID,
  WORKIQ_SCOPES,
} from "./config"
export { WorkIqError, type WorkIqErrorCode } from "./errors"
export {
  createWorkIqPlugin,
  INJECT as inject,
  META as meta,
  PLUGIN_ID as name,
  type TokenProviderEnv,
  type WorkIqPluginOptions,
} from "./plugin"
export { ACTION_IDS, STATUS_CODES, TERMS_FILE } from "./state"
