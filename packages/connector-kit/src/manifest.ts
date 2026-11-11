/**
 * The manifest shapes this kit reads, narrowed from the SDK's
 * `PluginManifest` to remote MCP connectors.
 */
import type {
  ConnectorAuth,
  ConnectorManifest,
  ConnectorTerms,
  PluginManifest,
} from "@stuffbucket/maximal-plugin-sdk"

/** Microsoft Entra public client (MSAL, auth code + PKCE via a loopback redirect). */
export type EntraAuthManifest = Extract<ConnectorAuth, { type: "entra" }>

/** MCP Authorization spec (RFC 9728 → RFC 8414/OIDC → PKCE, RFC 8707 `resource`). */
export type McpOAuthManifest = Extract<ConnectorAuth, { type: "mcp-oauth" }>

export type NoAuthManifest = Extract<ConnectorAuth, { type: "none" }>

export type ConnectorAuthManifest = ConnectorAuth
export type ConnectorTermsManifest = ConnectorTerms
export type ConnectorManifestSection = ConnectorManifest

/** A plugin manifest of `kind: "connector"` with its `connector` section. */
export type RemoteMcpConnectorManifest = PluginManifest & {
  kind: "connector"
  connector: ConnectorManifest
}
