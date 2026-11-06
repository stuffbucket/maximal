/**
 * `@stuffbucket/maximal-connector-kit` — build a maximal connector for a
 * remote MCP server from a manifest. `defineRemoteMcpConnector(manifest,
 * options)` returns a complete plugin module (`name`, `manifest`, `inject`,
 * `Config`, `apply`, and the optional `defaultToolPermission` /
 * `migrateSettings`).
 */
export { authStrategyFor } from "./auth"
export {
  createMsalTokenProvider,
  entraAuth,
  type EntraAuthOverrides,
  LEGACY_TOKEN_CACHE_FILE,
  type MsalTokenProviderOptions,
  SIGN_IN_TIMEOUT_MS,
  TOKEN_CACHE_FILE,
} from "./auth/entra"
export {
  createMcpOAuthTokenProvider,
  mcpOAuth,
  type McpOAuthOptions,
  type McpOAuthOverrides,
  OAUTH_FILE,
} from "./auth/mcp-oauth"
export { noAuth } from "./auth/none"
export { SECRET_SERVICE, type SecretStore } from "./auth/secret-store"
export type {
  AuthEnv,
  AuthStrategy,
  ConnectorAccount,
  CredentialNotice,
  TextStore,
  TokenProvider,
} from "./auth/token-provider"
export {
  ADVANCED,
  configJsonSchema,
  type ConnectorConfig,
  connectorConfigSchema,
} from "./config"
export {
  CONNECTOR_INJECT,
  defineRemoteMcpConnector,
  type RemoteMcpConnectorModule,
  type RemoteMcpConnectorOptions,
} from "./define"
export {
  type BusyDetails,
  type BusyReason,
  ConnectorError,
  type ConnectorErrorCode,
  type ConnectorErrorWording,
  type ConnectorMessageCode,
  type ErrorContext,
  signedOut,
  toConnectorError,
  UpstreamHttpError,
  worded,
} from "./errors"
export type {
  ConnectorAuthManifest,
  ConnectorManifestSection,
  ConnectorTermsManifest,
  EntraAuthManifest,
  McpOAuthManifest,
  NoAuthManifest,
  RemoteMcpConnectorManifest,
} from "./manifest"
export {
  ACTION_IDS,
  type ControllerWording,
  STATUS_CODES,
  TERMS_FILE,
} from "./state"
export { mirrorTools } from "./tools"
export {
  type BatchTool,
  type InspectedCall,
  kindFromAnnotations,
  resultBody,
  type ResultThrottle,
  type ThrottleHooks,
  type ToolKind,
} from "./upstream/classify"
export type { NegotiatedProtocol, UpstreamTool } from "./upstream/connection"
export {
  GuardedUpstream,
  type GuardedUpstreamOptions,
} from "./upstream/guarded"
export {
  type AcquireOptions,
  ConnectorLimiter,
  DEFAULT_LANE,
  type Lease,
  type LimiterReason,
  LimiterRejection,
  type LimiterSnapshot,
  type WaitInfo,
} from "./upstream/limiter"
export {
  DEFAULT_LIMITS,
  DEFAULT_RETRY_DELAYS_MS,
  type ResolvedLimits,
  resolveLimits,
  type RetryPolicy,
} from "./upstream/limits"
export { backoffDelay } from "./upstream/retry"
export { parseRetryAfter } from "./upstream/retry-after"
export type { Clock, Random, Sleep } from "./util"
export type {
  ConnectorLaneLimits,
  ConnectorLimits,
  ConnectorRetryLimits,
} from "@stuffbucket/maximal-plugin-sdk"
