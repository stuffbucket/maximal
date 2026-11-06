import type { FetchLike } from "@modelcontextprotocol/client"
import type {
  PluginLogger,
  PluginNotice,
} from "@stuffbucket/maximal-plugin-sdk"

import type { ConnectorError } from "../errors"
import type { SecretStore } from "./secret-store"

/** Who the connector is signed in as (whatever the identity provider tells us). */
export interface ConnectorAccount {
  /** UPN / email, e.g. `ada@contoso.com`, when the provider reveals one. */
  username?: string
  name?: string
  /** Entra tenant id (GUID). */
  tenantId?: string
  /** Authorization server that issued the tokens (MCP OAuth). */
  issuer?: string
}

/** Why a sign-in won't survive a restart (no usable OS credential store). */
export interface CredentialNotice {
  /** Short status fact value. */
  fact: string
  /** What happened and what to do, for the status detail. */
  detail: string
}

/**
 * Everything a connector needs from an identity provider. Credentials live
 * in the connector's own `ctx.storage` (sealed with a key in the OS
 * credential store, for Entra) and never leave the provider except as the
 * upstream `Authorization` header.
 */
export interface TokenProvider {
  /** The cached account, if any (no network). */
  account(): Promise<ConnectorAccount | undefined>
  /**
   * A fresh access token, acquired silently (cache or refresh token), or
   * `undefined` when the upstream needs none. Rejects with a `signed-out`
   * `ConnectorError` when the user must sign in interactively.
   */
  getToken(signal?: AbortSignal): Promise<string | undefined>
  /** Interactive sign-in in the system browser. Rejects when `signal` aborts. */
  signIn(signal: AbortSignal): Promise<ConnectorAccount>
  /** Forget every account and delete the persisted credentials. */
  signOut(): Promise<void>
  /**
   * The upstream rejected `rejected` (HTTP 401), or — without it — the
   * caller wants a fresh token. Return `true` when the next `getToken` may
   * yield a different one (refresh, or a newer token already replaced the
   * rejected one), so the request is retried once. Concurrent 401s for the
   * same token share one refresh.
   */
  invalidate?(rejected?: string): Promise<boolean>
  /** Set when credentials are kept in memory only, and why. */
  credentialNotice?(): CredentialNotice | undefined
}

/** Text persistence credentials need (a subset of `ctx.storage`). */
export interface TextStore {
  readText(name: string): Promise<string | undefined>
  writeText(name: string, text: string): Promise<void>
  delete(name: string): Promise<void>
}

/** What a strategy gets to build its `TokenProvider` for one plugin instance. */
export interface AuthEnv {
  /** Connector display name (for messages and the sign-in pages). */
  displayName: string
  /** The configured MCP endpoint (the OAuth protected resource). */
  endpoint: string
  /** Validated plugin config (e.g. `authority` for Entra). */
  config: Readonly<Record<string, unknown>>
  /** The connector's private storage. */
  store: TextStore
  /** The OS credential store, scoped to this connector. */
  secrets: SecretStore
  /**
   * Identifies this connector's data across rebuilds in one process (its id
   * and data directory): a sign-in kept in memory outlives turning it off and on.
   */
  scope: string
  /** Raise a one-off native notification (`ctx.surface.notify`). Never throws. */
  notify: (notice: PluginNotice) => void
  /** Opens a URL in the system browser (`ctx.host.openExternal`). */
  openBrowser: (url: string) => Promise<void>
  logger: PluginLogger
  signInTimeoutMs: number
  /** Base fetch for identity-provider HTTP (default global `fetch`). */
  fetch?: FetchLike
  /** Classify a failure with the connector's wording. */
  toError: (error: unknown) => ConnectorError
  /**
   * Aborts when the plugin unloads. Background work shared by several
   * callers (a token refresh) runs under this, not under one caller's signal.
   */
  lifetime?: AbortSignal
}

/** How a connector signs in. Built-ins: `entraAuth`, `mcpOAuth`, `noAuth`. */
export interface AuthStrategy {
  /** `entra`, `mcp-oauth`, `none`, or a custom label (tests). */
  readonly type: string
  /** `false` when there is nothing to sign in to (no sign-in/sign-out actions). */
  readonly interactive: boolean
  /** `signin-needed` status summary. */
  readonly signInPrompt?: string
  /** Status detail while the browser sign-in is pending. */
  readonly signInWaiting?: string
  create(env: AuthEnv): TokenProvider
}

/** Notice code when the OS credential store stopped answering. */
export const SIGN_IN_NOT_SAVED = "sign-in-not-saved"

/** The notice for a credential-store timeout: the sign-in lasts until restart. */
export function signInNotSavedNotice(
  displayName: string,
  notice: CredentialNotice,
): PluginNotice {
  return {
    code: SIGN_IN_NOT_SAVED,
    message: `${displayName}: ${notice.detail}`,
    params: { connector: displayName },
  }
}
