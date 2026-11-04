import type { PluginLogger } from "@stuffbucket/maximal-plugin-sdk"

import {
  LogLevel,
  PublicClientApplication,
  type AccountInfo,
  type ICachePlugin,
  type INetworkModule,
  type TokenCacheContext,
} from "@azure/msal-node"

import type { EntraAuthManifest } from "../manifest"
import type {
  AuthStrategy,
  ConnectorAccount,
  TextStore,
  TokenProvider,
} from "./token-provider"

import { ConnectorError, isAbort, signedOut } from "../errors"
import { abortable, escapeHtml } from "../util"

/** Storage file holding MSAL's serialized token cache (0600 via `ctx.storage`). */
export const TOKEN_CACHE_FILE = "msal-token-cache.json"

/** Reuse an access token until it is this close to expiry. */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000

/** How long an interactive sign-in may take before it is abandoned. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000

export interface MsalTokenProviderOptions {
  clientId: string
  authority: string
  scopes: ReadonlyArray<string>
  store: TextStore
  /** Opens the authorize URL in the system browser (`ctx.host.openExternal`). */
  openBrowser: (url: string) => Promise<void>
  /** Classifies MSAL failures with the connector's wording. */
  toError: (error: unknown) => ConnectorError
  /** Shown on the browser page after sign-in (default "the service"). */
  displayName?: string
  logger?: PluginLogger
  /** Default 5 minutes. */
  signInTimeoutMs?: number
  /**
   * Loopback port of the registered redirect. Sign-in fails with
   * `port-in-use` rather than use another port. `0` or absent: any free port.
   */
  preferredPort?: number
  /** MSAL seams for offline tests: HTTP client and pre-resolved authority metadata. */
  networkClient?: INetworkModule
  cloudDiscoveryMetadata?: string
  authorityMetadata?: string
}

/** Browser page shown on the loopback redirect after sign-in. */
export function signInPage(displayName: string, ok: boolean): string {
  const name = escapeHtml(displayName)
  const heading = ok ? `Signed in to ${name}` : `${name} sign-in did not finish`
  const text =
    ok ?
      "You can close this window and return to Maximal."
    : "Return to Maximal for details."
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>
<body style="font-family:system-ui,sans-serif;margin:3rem"><h1>${heading}</h1>
<p>${text}</p></body></html>`
}

/** MSAL cache persistence over the plugin's private storage. */
export function storageCachePlugin(
  store: TextStore,
  file = TOKEN_CACHE_FILE,
): ICachePlugin {
  return {
    async beforeCacheAccess(context: TokenCacheContext) {
      const text = await store.readText(file)
      if (text) context.tokenCache.deserialize(text)
    },
    async afterCacheAccess(context: TokenCacheContext) {
      if (context.cacheHasChanged)
        await store.writeText(file, context.tokenCache.serialize())
    },
  }
}

function toAccount(account: AccountInfo): ConnectorAccount {
  return {
    username: account.username,
    ...(account.name ? { name: account.name } : {}),
    ...(account.tenantId ? { tenantId: account.tenantId } : {}),
  }
}

/**
 * Ask MSAL's loopback listener to stop waiting: it only finishes on a
 * form_post to `/`, so post an OAuth error response to it.
 */
async function releaseLoopback(redirectUri: string): Promise<void> {
  try {
    const url = new URL(redirectUri)
    url.hostname = "127.0.0.1"
    url.pathname = "/"
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "error=access_denied&error_description=Sign-in%20cancelled",
      signal: AbortSignal.timeout(2000),
    })
    await response.text()
  } catch {
    // The listener is already gone.
  }
}

function createClient(
  options: MsalTokenProviderOptions,
): PublicClientApplication {
  const logger = options.logger
  return new PublicClientApplication({
    auth: {
      clientId: options.clientId,
      authority: options.authority,
      ...(options.cloudDiscoveryMetadata ?
        { cloudDiscoveryMetadata: options.cloudDiscoveryMetadata }
      : {}),
      ...(options.authorityMetadata ?
        { authorityMetadata: options.authorityMetadata }
      : {}),
    },
    cache: { cachePlugin: storageCachePlugin(options.store) },
    system: {
      ...(options.networkClient ?
        { networkClient: options.networkClient }
      : {}),
      loggerOptions: {
        piiLoggingEnabled: false,
        logLevel: LogLevel.Warning,
        loggerCallback(level, message, containsPii) {
          if (containsPii || !logger) return
          if (level === LogLevel.Error) logger.warn(`msal: ${message}`)
          else logger.debug(`msal: ${message}`)
        },
      },
    },
  })
}

/**
 * Microsoft Entra sign-in with `@azure/msal-node`: interactive auth code +
 * PKCE through a loopback redirect, silent refresh for every token request,
 * and the token cache persisted to plugin storage. Only the most recently
 * signed-in account is kept.
 */
export function createMsalTokenProvider(
  options: MsalTokenProviderOptions,
): TokenProvider {
  return new MsalTokenProvider(options)
}

interface Acquisition {
  promise: Promise<string>
  epoch: number
  generation: number
}

class MsalTokenProvider implements TokenProvider {
  readonly #options: MsalTokenProviderOptions
  readonly #scopes: Array<string>
  readonly #pca: PublicClientApplication
  /** Last silent result, so per-request token lookups skip MSAL's cache I/O. */
  #memo: { token: string; expiresAt: number } | undefined
  /** The upstream rejected a token: the next acquisition skips MSAL's access-token cache. */
  #forceRefresh = false
  /** The token most recently invalidated (concurrent 401s for it share one refresh). */
  #rejected: string | undefined
  /**
   * Bumped whenever cached tokens become stale (a rejection, sign-in,
   * sign-out): an acquisition started before only memoizes, and is only
   * joined, if unchanged.
   */
  #epoch = 0
  /** Bumped on sign-in and sign-out: a token from before belongs to another account. */
  #generation = 0
  /** The silent acquisition in flight; concurrent lookups share it. */
  #inflight: Acquisition | undefined
  /** What the user last chose in this session: an account (sign-in) or none (sign-out). */
  #chosen: { account?: AccountInfo } | undefined

  constructor(options: MsalTokenProviderOptions) {
    this.#options = options
    this.#scopes = [...options.scopes]
    this.#pca = createClient(options)
  }

  async account(): Promise<ConnectorAccount | undefined> {
    const account = (await this.#accounts()).at(0)
    return account ? toAccount(account) : undefined
  }

  async getToken(signal?: AbortSignal): Promise<string> {
    for (;;) {
      signal?.throwIfAborted()
      const memo = this.#memo
      if (memo && memo.expiresAt - Date.now() > TOKEN_REUSE_MARGIN_MS)
        return memo.token
      const entry =
        this.#inflight?.epoch === this.#epoch ? this.#inflight : this.#acquire()
      let token: string
      try {
        token = await abortable(entry.promise, signal)
      } catch (error) {
        if (isAbort(error, signal)) throw error
        throw this.#options.toError(error)
      }
      // Signed in as someone else (or out) meanwhile: look again.
      if (entry.generation === this.#generation) return token
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- the contract is async; nothing to await here
  async invalidate(rejected?: string): Promise<boolean> {
    const memo = this.#memo
    // A newer token already replaced the rejected one.
    if (rejected !== undefined && memo && memo.token !== rejected) return true
    // Another request already reported this token; its refresh is shared.
    if (rejected !== undefined && !memo && rejected === this.#rejected) {
      // Unless that refresh is still running, the next lookup refreshes.
      if (this.#inflight?.epoch !== this.#epoch) this.#forceRefresh = true
      return true
    }
    this.#memo = undefined
    this.#forceRefresh = true
    this.#rejected = rejected
    this.#epoch++
    return true
  }

  async signIn(signal: AbortSignal): Promise<ConnectorAccount> {
    // Until this sign-in finishes, the current account stays as it is.
    this.#chosen = undefined
    this.#switched()
    // Like agent-kit's `login` (no prompt: the browser's session decides),
    // except that signing in again offers the account picker.
    const switching = (await this.#accounts()).length > 0
    const account = await interactiveSignIn(this.#pca, this.#options, {
      signal,
      switching,
    })
    this.#chosen = { account }
    this.#switched()
    await this.#forgetStale()
    this.#switched()
    return toAccount(account)
  }

  async signOut(): Promise<void> {
    this.#chosen = {}
    this.#switched()
    await this.#forgetStale()
    this.#switched()
  }

  async #accounts(): Promise<Array<AccountInfo>> {
    return await this.#pca.getTokenCache().getAllAccounts()
  }

  /**
   * Keep only the account the user chose (none after sign-out, deleting
   * the cache file). Also run after an acquisition that straddled a
   * sign-in or sign-out, which may have written the old account back into
   * MSAL's cache.
   */
  async #forgetStale(): Promise<void> {
    if (!this.#chosen) return
    const keep = this.#chosen.account?.homeAccountId
    const cache = this.#pca.getTokenCache()
    for (const account of await this.#accounts())
      if (account.homeAccountId !== keep) await cache.removeAccount(account)
    if (keep === undefined) await this.#options.store.delete(TOKEN_CACHE_FILE)
  }

  /** The account changed: nothing cached or in flight may be handed out. */
  #switched(): void {
    this.#memo = undefined
    this.#inflight = undefined
    this.#forceRefresh = false
    this.#rejected = undefined
    this.#epoch++
    this.#generation++
  }

  /** One silent acquisition (not tied to any caller's signal), shared by concurrent lookups. */
  #acquire(): Acquisition {
    const refresh = this.#forceRefresh
    this.#forceRefresh = false
    const epoch = this.#epoch
    const generation = this.#generation
    const promise = (async () => {
      try {
        const account = (await this.#accounts()).at(0)
        if (!account) throw signedOut()
        const result = await this.#pca.acquireTokenSilent({
          scopes: this.#scopes,
          account,
          ...(refresh ? { forceRefresh: true } : {}),
        })
        if (!result.accessToken) throw this.#expired()
        if (epoch === this.#epoch)
          this.#memo = {
            token: result.accessToken,
            expiresAt: result.expiresOn?.getTime() ?? 0,
          }
        return result.accessToken
      } finally {
        if (generation !== this.#generation) await this.#forgetStale()
      }
    })()
    const entry: Acquisition = { promise, epoch, generation }
    this.#inflight = entry
    promise
      .finally(() => {
        if (this.#inflight === entry) this.#inflight = undefined
      })
      .catch(() => {})
    return entry
  }

  #expired(): ConnectorError {
    return signedOut(
      `Your ${this.#options.displayName ?? "connector"} sign-in has expired. Sign in again.`,
    )
  }
}

/** Fail when MSAL moved off the registered redirect port (Entra would reject it). */
function assertRedirectPort(redirectUri: string, required: number): void {
  if (redirectPort(redirectUri) === required) return
  throw new ConnectorError(
    "port-in-use",
    `Sign-in needs local port ${required} (its registered redirect is http://localhost:${required}), but another program is using it. Close that program — for example another sign-in that is still waiting — and try again.`,
  )
}

/** Why an interactive sign-in stopped early (abort or timeout). */
export function stoppedSignIn(
  timedOut: boolean,
  timeoutMs: number,
  cause: unknown,
): ConnectorError {
  if (timedOut)
    return new ConnectorError(
      "sign-in-timeout",
      `Sign-in timed out after ${Math.round(timeoutMs / 60_000) || 1} minute(s). Try again.`,
    )
  return new ConnectorError("sign-in-cancelled", "Sign-in was cancelled.", {
    cause,
  })
}

/** MSAL's interactive auth code + PKCE flow through its loopback listener. */
async function interactiveSignIn(
  pca: PublicClientApplication,
  options: MsalTokenProviderOptions,
  request: { signal: AbortSignal; switching: boolean },
): Promise<AccountInfo> {
  const { signal } = request
  const timeoutMs = options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  const stop = AbortSignal.any([signal, timeout.signal])
  const required = options.preferredPort
  const name = options.displayName ?? "the service"
  let redirectUri: string | undefined
  const interactive = pca.acquireTokenInteractive({
    scopes: [...options.scopes],
    ...(request.switching ? { prompt: "select_account" } : {}),
    ...(required === undefined ? {} : { preferredPort: required }),
    successTemplate: signInPage(name, true),
    errorTemplate: signInPage(name, false),
    openBrowser: async (url) => {
      redirectUri = new URL(url).searchParams.get("redirect_uri") ?? ""
      stop.throwIfAborted()
      // MSAL silently moves to a random port when the preferred one is busy.
      if (required) assertRedirectPort(redirectUri, required)
      await options.openBrowser(url)
    },
  })
  try {
    const result = await abortable(interactive, stop)
    if (!result.account)
      throw new ConnectorError(
        "upstream",
        "Sign-in finished without an account.",
      )
    return result.account
  } catch (error) {
    if (!stop.aborted) throw options.toError(error)
    if (redirectUri) await releaseLoopback(redirectUri)
    throw stoppedSignIn(
      timeout.signal.aborted && !signal.aborted,
      timeoutMs,
      error,
    )
  } finally {
    clearTimeout(timer)
  }
}

/** Port of a loopback redirect URI (`http://localhost:12798` → 12798), if it names one. */
function redirectPort(redirectUri: string): number | undefined {
  try {
    const port = new URL(redirectUri).port
    return port ? Number(port) : undefined
  } catch {
    return undefined
  }
}

/** Options for `entraAuth` beyond the manifest (tests: MSAL network seams, port). */
export type EntraAuthOverrides = Pick<
  MsalTokenProviderOptions,
  | "networkClient"
  | "cloudDiscoveryMetadata"
  | "authorityMetadata"
  | "preferredPort"
>

/**
 * Microsoft Entra sign-in (MSAL public client). `config.authority`, when the
 * connector's config has one, replaces the manifest's authority.
 */
export function entraAuth(
  manifest: EntraAuthManifest,
  overrides: EntraAuthOverrides = {},
): AuthStrategy {
  return {
    type: "entra",
    interactive: true,
    signInPrompt: "Sign in with your work or school account",
    signInWaiting:
      "Finish signing in with your work or school account in the browser window that opened.",
    create(env) {
      const authority =
        typeof env.config.authority === "string" ?
          env.config.authority
        : manifest.authority
      const port = overrides.preferredPort ?? redirectPort(manifest.redirectUri)
      return createMsalTokenProvider({
        clientId: manifest.clientId,
        authority,
        scopes: manifest.scopes,
        store: env.store,
        openBrowser: env.openBrowser,
        toError: env.toError,
        displayName: env.displayName,
        logger: env.logger,
        signInTimeoutMs: env.signInTimeoutMs,
        ...overrides,
        ...(port === undefined ? {} : { preferredPort: port }),
      })
    },
  }
}
