import {
  auth,
  checkResourceAllowed,
  OAuthError,
  refreshAuthorization,
  type FetchLike,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client"

import type { McpOAuthManifest } from "../manifest"
import type {
  AuthEnv,
  AuthStrategy,
  ConnectorAccount,
  CredentialNotice,
  TokenProvider,
} from "./token-provider"

import { ConnectorError, isAbort, signedOut } from "../errors"
import { abortable } from "../util"
import { signInPage, stoppedSignIn } from "./entra"
import { startLoopbackRedirect, type LoopbackRedirect } from "./loopback"
import { SealedCache } from "./sealed-cache"
import { signInNotSavedNotice } from "./token-provider"

/**
 * Storage file holding this connector's OAuth state, encrypted with a key
 * kept in the OS credential store (see `SealedCache`).
 */
export const OAUTH_FILE = "oauth.sealed.json"

/** The plaintext state older versions wrote; moved into `OAUTH_FILE` on first start. */
export const LEGACY_OAUTH_FILE = "oauth.json"

/** Entry name (before its random key id) of the state's key in the OS credential store. */
const OAUTH_KEY = "mcp-oauth"

/** Refresh an access token this close to its expiry. */
const REFRESH_MARGIN_MS = 60_000

/** What the OAuth state holds. Tokens never leave this connector. */
interface OAuthRecord {
  /** Client registered dynamically (absent with a manifest `clientId`). */
  client?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
  /** Epoch ms; absent when the server sent no `expires_in`. */
  expiresAt?: number
  discovery?: OAuthDiscoveryState
  /** RFC 8707 resource indicator the tokens are bound to. */
  resource?: string
  account?: ConnectorAccount
}

export interface McpOAuthOptions {
  /** MCP endpoint (the protected resource). */
  endpoint: string
  clientId?: string
  scopes?: ReadonlyArray<string>
  displayName: string
  /** The connector's private storage: holds the sealed state file. */
  store: AuthEnv["store"]
  /** The OS credential store: holds the state's key (tests: an in-memory fake). */
  secrets: AuthEnv["secrets"]
  /** `AuthEnv.scope`; without one this provider's in-memory sign-in is its own. */
  scope?: string
  /** Called once if the credential store stops answering. */
  onStoreTimeout?: (notice: CredentialNotice) => void
  openBrowser(url: string): Promise<void>
  toError(error: unknown): ConnectorError
  logger?: AuthEnv["logger"]
  signInTimeoutMs: number
  /** Loopback redirect port; `0` (default) picks a free one (RFC 8252 §7.3). */
  redirectPort?: number
  fetch?: FetchLike
  now?: () => number
  /** Aborts when the plugin unloads; a shared refresh runs under this, not a caller's signal. */
  lifetime?: AbortSignal
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ?
      (value as Record<string, unknown>)
    : undefined
}

/** Identity claims of an OIDC `id_token`, when the server sent one (not verified: display only). */
function idTokenAccount(
  idToken: string | undefined,
): ConnectorAccount | undefined {
  const payload = idToken?.split(".")[1]
  if (!payload) return undefined
  try {
    const claims = record(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    )
    if (!claims) return undefined
    const username = [claims.preferred_username, claims.email, claims.upn].find(
      (value): value is string => typeof value === "string" && value !== "",
    )
    const account: ConnectorAccount = {}
    if (username) account.username = username
    if (typeof claims.name === "string") account.name = claims.name
    if (typeof claims.tid === "string") account.tenantId = claims.tid
    return account
  } catch {
    return undefined
  }
}

const RESIGN_IN = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
])

/**
 * MCP Authorization (spec 2025-06-18 and later): protected-resource metadata
 * (RFC 9728) → authorization-server metadata (RFC 8414 / OIDC discovery) →
 * authorization code + PKCE through a loopback redirect, with the RFC 8707
 * `resource` indicator on every authorization and token request, and silent
 * refresh. Uses a static `clientId` when given; otherwise registers
 * dynamically (RFC 7591) when the server advertises it. Discovery, PKCE and
 * the token exchange are the MCP SDK's `auth()`; refresh uses the persisted
 * discovery result.
 */
export function createMcpOAuthTokenProvider(
  options: McpOAuthOptions,
): TokenProvider {
  return new McpOAuthTokenProvider(options)
}

/** Sign-in state kept only for one interactive sign-in. */
type Pending = Partial<
  Pick<OAuthRecord, "client" | "tokens" | "discovery" | "resource">
>

interface ProviderParams {
  options: McpOAuthOptions
  redirectUri: string
  state: string
  openBrowser: (url: URL) => Promise<void>
  /** A client registered dynamically by an earlier sign-in. */
  registered: StoredOAuthClientInformation | undefined
}

/** The SDK's `OAuthClientProvider` for one interactive sign-in. */
function interactiveProvider(
  params: ProviderParams,
): OAuthClientProvider & { pending: Pending } {
  const { options, redirectUri } = params
  let verifier: string | undefined
  const pending: Pending =
    params.registered && !options.clientId ? { client: params.registered } : {}
  const metadata: OAuthClientMetadata = {
    client_name: "Maximal",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(options.scopes?.length ? { scope: options.scopes.join(" ") } : {}),
  }
  return {
    pending,
    redirectUrl: redirectUri,
    clientMetadata: metadata,
    state: () => params.state,
    // A static client is stamped with the AS it is used against (SEP-2352).
    clientInformation: (ctx) =>
      options.clientId ?
        { client_id: options.clientId, ...(ctx ? { issuer: ctx.issuer } : {}) }
      : pending.client,
    saveClientInformation(info) {
      // A static client id never needs saving; a registered one does.
      if (!options.clientId) pending.client = info
    },
    tokens: () => pending.tokens,
    saveTokens(tokens) {
      pending.tokens = tokens
    },
    redirectToAuthorization: (url) => params.openBrowser(url),
    saveCodeVerifier(codeVerifier) {
      verifier = codeVerifier
    },
    codeVerifier() {
      if (!verifier) throw new Error("No PKCE code verifier for this sign-in.")
      return verifier
    },
    saveDiscoveryState(discovery) {
      pending.discovery = discovery
    },
    discoveryState: () => pending.discovery,
    saveResourceUrl(resource) {
      pending.resource = resource
    },
    // RFC 8707: always name the MCP server as the resource, even when it
    // publishes no protected-resource metadata.
    validateResourceURL(serverUrl, resource) {
      if (
        resource
        && !checkResourceAllowed({
          requestedResource: serverUrl,
          configuredResource: resource,
        })
      ) {
        throw new ConnectorError(
          "upstream",
          `${options.displayName} advertised protected resource ${resource}, which does not match ${String(serverUrl)}.`,
        )
      }
      return Promise.resolve(new URL(resource ?? serverUrl))
    },
  }
}

/** The authorization code (and `iss`) from the redirect, or why there is none. */
function callbackCode(
  params: URLSearchParams,
  expected: { state: string; displayName: string },
): { code: string; iss?: string } {
  const failed = (detail: string) =>
    new ConnectorError(
      "upstream",
      `${expected.displayName} sign-in failed: ${detail}`,
    )
  const error = params.get("error")
  if (error === "access_denied")
    throw new ConnectorError("sign-in-cancelled", "Sign-in was cancelled.")
  if (error) throw failed(params.get("error_description") ?? error)
  if (params.get("state") !== expected.state)
    throw failed("the authorization response did not match this sign-in.")
  const code = params.get("code")
  if (!code) throw failed("no authorization code.")
  const iss = params.get("iss")
  return { code, ...(iss ? { iss } : {}) }
}

class McpOAuthTokenProvider implements TokenProvider {
  readonly #options: McpOAuthOptions
  readonly #now: () => number
  #cached: OAuthRecord | undefined
  /** The refresh in flight, shared by every caller (each applies its own abort). */
  #refreshing: Promise<string | undefined> | undefined
  /**
   * Bumped by sign-in and sign-out: a refresh that started before must not
   * write its tokens over the newer state.
   */
  #epoch = 0

  readonly #state: SealedCache

  constructor(options: McpOAuthOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#state = new SealedCache({
      store: options.store,
      secrets: options.secrets,
      file: OAUTH_FILE,
      legacyFile: LEGACY_OAUTH_FILE,
      keyName: OAUTH_KEY,
      scope: `${options.scope ?? crypto.randomUUID()}:${OAUTH_FILE}`,
      ...(options.onStoreTimeout ? { onTimeout: options.onStoreTimeout } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    })
    // Move older plaintext state off disk now, not at the first token lookup.
    this.#state.migrate().catch((error: unknown) => {
      options.logger?.warn(
        `Could not move the plaintext ${LEGACY_OAUTH_FILE}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  credentialNotice(): CredentialNotice | undefined {
    return this.#state.memoryOnly
  }

  async account(): Promise<ConnectorAccount | undefined> {
    const current = await this.#load()
    return current.tokens ? (current.account ?? {}) : undefined
  }

  async getToken(signal?: AbortSignal): Promise<string> {
    for (;;) {
      signal?.throwIfAborted()
      const current = await this.#load()
      const tokens = current.tokens
      if (!tokens) throw signedOut()
      if (
        current.expiresAt === undefined
        || current.expiresAt - this.#now() > REFRESH_MARGIN_MS
      )
        return tokens.access_token
      if (!tokens.refresh_token) throw this.#expired()
      let refreshing = this.#refreshing
      if (!refreshing) {
        const started = this.#refresh(current)
        refreshing = started
        this.#refreshing = started
        started
          .finally(() => {
            if (this.#refreshing === started) this.#refreshing = undefined
          })
          .catch(() => {})
      }
      // `undefined`: the account changed meanwhile; look again.
      const token = await abortable(refreshing, signal)
      if (token !== undefined) return token
    }
  }

  async invalidate(rejected?: string): Promise<boolean> {
    // Another request's refresh is running, or already replaced the token.
    if (this.#refreshing) return true
    const current = await this.#load()
    if (!current.tokens?.refresh_token) return false
    if (rejected !== undefined && current.tokens.access_token !== rejected)
      return true
    await this.#save({ ...current, expiresAt: 0 })
    return true
  }

  async signIn(signal: AbortSignal): Promise<ConnectorAccount> {
    const options = this.#options
    const timeout = AbortSignal.timeout(options.signInTimeoutMs)
    const stop = AbortSignal.any([signal, timeout])
    // Not bumped here: the current account's refreshes keep saving until this one finishes.
    const epoch = this.#epoch
    const state = crypto.randomUUID()
    let loopback: LoopbackRedirect | undefined
    try {
      loopback = await startLoopbackRedirect(
        {
          ...(options.redirectPort === undefined ?
            {}
          : { port: options.redirectPort }),
          state,
          page: (ok) => signInPage(options.displayName, ok),
        },
        stop,
      )
      const pending = await this.#authorize(loopback, state, stop)
      return await this.#finish(pending, epoch)
    } catch (error) {
      if (!stop.aborted) throw options.toError(error)
      throw stoppedSignIn(
        timeout.aborted && !signal.aborted,
        options.signInTimeoutMs,
        error,
      )
    } finally {
      await loopback?.close()
    }
  }

  async signOut(): Promise<void> {
    this.#switch()
    this.#cached = {}
    await this.#state.clear()
  }

  /** The account changes: drop the shared refresh and outdate saves already under way. */
  #switch(): void {
    this.#refreshing = undefined
    this.#epoch++
  }

  /** Discovery, (registration,) browser authorization and the code exchange — the SDK's `auth()`. */
  async #authorize(
    loopback: LoopbackRedirect,
    state: string,
    stop: AbortSignal,
  ): Promise<Pending> {
    const options = this.#options
    const provider = interactiveProvider({
      options,
      redirectUri: loopback.redirectUri,
      state,
      openBrowser: async (url) => {
        stop.throwIfAborted()
        await options.openBrowser(url.href)
      },
      registered: (await this.#load()).client,
    })
    const common = {
      serverUrl: options.endpoint,
      ...(options.scopes?.length ? { scope: options.scopes.join(" ") } : {}),
      ...(options.fetch ? { fetchFn: options.fetch } : {}),
    }
    const first = await abortable(auth(provider, common), stop)
    if (first !== "AUTHORIZED") {
      const callback = callbackCode(await loopback.result, {
        state,
        displayName: options.displayName,
      })
      await abortable(
        auth(provider, {
          ...common,
          authorizationCode: callback.code,
          ...(callback.iss ? { iss: callback.iss } : {}),
        }),
        stop,
      )
    }
    return provider.pending
  }

  async #finish(pending: Pending, epoch: number): Promise<ConnectorAccount> {
    const tokens = pending.tokens
    if (!tokens)
      throw new ConnectorError(
        "upstream",
        `${this.#options.displayName} sign-in finished without tokens.`,
      )
    const issuer =
      pending.discovery?.authorizationServerMetadata?.issuer
      ?? pending.discovery?.authorizationServerUrl
    const account: ConnectorAccount = {
      ...idTokenAccount(tokens.id_token),
      ...(issuer ? { issuer } : {}),
    }
    const { tokens: _tokens, ...kept } = pending
    // Signed out (or in again) while this sign-in ran: it no longer counts.
    if (epoch !== this.#epoch) throw stoppedSignIn(false, 0, undefined)
    // Refreshes still running belong to the previous account: drop their results.
    this.#switch()
    await this.#save(this.#withTokens({ ...kept, account }, tokens))
    return account
  }

  #expired(cause?: unknown): ConnectorError {
    return signedOut(
      `Your ${this.#options.displayName} sign-in has expired. Sign in again.`,
      cause,
    )
  }

  async #load(): Promise<OAuthRecord> {
    if (this.#cached) return this.#cached
    const text = await this.#state.read()
    let parsed: OAuthRecord = {}
    if (text) {
      try {
        parsed = record(JSON.parse(text)) ?? {}
      } catch {
        this.#options.logger?.warn(
          "Ignoring unreadable OAuth state; sign in again.",
        )
      }
    }
    this.#cached ??= parsed
    return this.#cached
  }

  async #save(next: OAuthRecord): Promise<void> {
    this.#cached = next
    await this.#state.write(`${JSON.stringify(next)}\n`)
  }

  #withTokens(current: OAuthRecord, tokens: StoredOAuthTokens): OAuthRecord {
    const next: OAuthRecord = { ...current, tokens }
    if (typeof tokens.expires_in === "number")
      next.expiresAt = this.#now() + tokens.expires_in * 1000
    else delete next.expiresAt
    return next
  }

  /**
   * Exchange the refresh token, under the plugin's lifetime rather than any
   * caller's signal, and always persist the result (servers rotate refresh
   * tokens). `undefined` when the account changed meanwhile: the result is
   * dropped.
   */
  async #refresh(current: OAuthRecord): Promise<string | undefined> {
    const options = this.#options
    const epoch = this.#epoch
    const refreshToken = current.tokens?.refresh_token
    const discovery = current.discovery
    const client =
      options.clientId ? { client_id: options.clientId } : current.client
    if (!refreshToken || !discovery || !client) throw this.#expired()
    const lifetime = options.lifetime
    try {
      const tokens = await abortable(
        refreshAuthorization(discovery.authorizationServerUrl, {
          metadata: discovery.authorizationServerMetadata,
          clientInformation: client,
          refreshToken,
          ...(current.resource ? { resource: new URL(current.resource) } : {}),
          fetchFn: withSignal(options.fetch, lifetime),
        }),
        lifetime,
      )
      if (epoch !== this.#epoch) return undefined
      await this.#save(
        this.#withTokens(current, { ...current.tokens, ...tokens }),
      )
      return tokens.access_token
    } catch (error) {
      if (isAbort(error, lifetime)) throw error
      if (epoch !== this.#epoch) return undefined
      if (error instanceof OAuthError && RESIGN_IN.has(error.code)) {
        const { tokens: _tokens, expiresAt: _expiresAt, ...rest } = current
        await this.#save(rest)
        throw this.#expired(error)
      }
      throw options.toError(error)
    }
  }
}

/** `fetch` bound to `signal` (combined with the request's own). */
function withSignal(
  base: FetchLike | undefined,
  signal: AbortSignal | undefined,
): FetchLike {
  const plain: FetchLike = base ?? ((url, init) => fetch(url, init))
  if (!signal) return plain
  return (url, init) =>
    plain(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    })
}

/** Options for `mcpOAuth` beyond the manifest. */
export interface McpOAuthOverrides {
  redirectPort?: number
}

/** MCP Authorization spec sign-in for a remote MCP server. */
export function mcpOAuth(
  manifest: McpOAuthManifest,
  overrides: McpOAuthOverrides = {},
): AuthStrategy {
  return {
    type: "mcp-oauth",
    interactive: true,
    signInWaiting: "Finish signing in in the browser window that opened.",
    create(env) {
      return createMcpOAuthTokenProvider({
        endpoint: env.endpoint,
        ...(manifest.clientId ? { clientId: manifest.clientId } : {}),
        ...(manifest.scopes ? { scopes: manifest.scopes } : {}),
        displayName: env.displayName,
        store: env.store,
        secrets: env.secrets,
        scope: env.scope,
        onStoreTimeout: (notice) => {
          env.notify(signInNotSavedNotice(env.displayName, notice))
        },
        openBrowser: env.openBrowser,
        toError: env.toError,
        logger: env.logger,
        signInTimeoutMs: env.signInTimeoutMs,
        ...(env.fetch ? { fetch: env.fetch } : {}),
        ...(env.lifetime ? { lifetime: env.lifetime } : {}),
        ...(overrides.redirectPort === undefined ?
          {}
        : { redirectPort: overrides.redirectPort }),
      })
    },
  }
}
