import type { PluginLogger } from "@stuffbucket/maximal-plugin-sdk"

import {
  LogLevel,
  PublicClientApplication,
  type AccountInfo,
  type ICachePlugin,
  type INetworkModule,
  type TokenCacheContext,
} from "@azure/msal-node"

import type { TextStore, TokenProvider, WorkIqAccount } from "./token-provider"

import { REDIRECT_PORT, WORKIQ_CLIENT_ID, WORKIQ_SCOPES } from "../config"
import { isAbort, signedOut, toWorkIqError, WorkIqError } from "../errors"
import { abortable } from "../util"

/** Storage file holding MSAL's serialized token cache (0600 via `ctx.storage`). */
export const TOKEN_CACHE_FILE = "msal-token-cache.json"

/** Reuse an access token until it is this close to expiry. */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000

/** How long an interactive sign-in may take before it is abandoned. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000

export interface MsalTokenProviderOptions {
  authority: string
  store: TextStore
  /** Opens the authorize URL in the system browser (`ctx.host.openExternal`). */
  openBrowser: (url: string) => Promise<void>
  logger?: PluginLogger
  clientId?: string
  scopes?: ReadonlyArray<string>
  /** Default 5 minutes. */
  signInTimeoutMs?: number
  /** Loopback port; default 12798 (the registered redirect). `0` picks a free port. */
  preferredPort?: number
  /** MSAL seams for offline tests: HTTP client and pre-resolved authority metadata. */
  networkClient?: INetworkModule
  cloudDiscoveryMetadata?: string
  authorityMetadata?: string
}

const SUCCESS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Work IQ</title></head>
<body style="font-family:system-ui,sans-serif;margin:3rem"><h1>Signed in to Work IQ</h1>
<p>You can close this window and return to Maximal.</p></body></html>`

const ERROR_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Work IQ</title></head>
<body style="font-family:system-ui,sans-serif;margin:3rem"><h1>Work IQ sign-in did not finish</h1>
<p>Return to Maximal for details.</p></body></html>`

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

function toAccount(account: AccountInfo): WorkIqAccount {
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
      clientId: options.clientId ?? WORKIQ_CLIENT_ID,
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
  const scopes = [...(options.scopes ?? WORKIQ_SCOPES)]
  const pca = createClient(options)
  const cache = pca.getTokenCache()
  // Last silent result, so per-request token lookups skip MSAL's cache I/O.
  let memo: { token: string; expiresAt: number } | undefined

  async function accounts(): Promise<Array<AccountInfo>> {
    return await cache.getAllAccounts()
  }

  async function keepOnly(keep: AccountInfo): Promise<void> {
    for (const account of await accounts()) {
      if (account.homeAccountId !== keep.homeAccountId)
        await cache.removeAccount(account)
    }
  }

  return {
    async account() {
      const account = (await accounts()).at(0)
      return account ? toAccount(account) : undefined
    },

    async getToken(signal) {
      signal?.throwIfAborted()
      if (memo && memo.expiresAt - Date.now() > TOKEN_REUSE_MARGIN_MS)
        return memo.token
      const account = (await accounts()).at(0)
      if (!account) throw signedOut()
      try {
        const result = await abortable(
          pca.acquireTokenSilent({ scopes, account }),
          signal,
        )
        if (!result.accessToken)
          throw signedOut("Your Work IQ sign-in has expired. Sign in again.")
        // Concurrent lookups may both refresh; either result is valid, so the
        // last write winning is harmless.
        // eslint-disable-next-line require-atomic-updates
        memo = {
          token: result.accessToken,
          expiresAt: result.expiresOn?.getTime() ?? 0,
        }
        return result.accessToken
      } catch (error) {
        if (isAbort(error, signal)) throw error
        throw toWorkIqError(error)
      }
    },

    async signIn(signal) {
      memo = undefined
      const timeoutMs = options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), timeoutMs)
      const stop = AbortSignal.any([signal, timeout.signal])
      let redirectUri: string | undefined
      const interactive = pca.acquireTokenInteractive({
        scopes,
        prompt: "select_account",
        preferredPort: options.preferredPort ?? REDIRECT_PORT,
        successTemplate: SUCCESS_PAGE,
        errorTemplate: ERROR_PAGE,
        openBrowser: async (url) => {
          redirectUri =
            new URL(url).searchParams.get("redirect_uri") ?? undefined
          stop.throwIfAborted()
          await options.openBrowser(url)
        },
      })
      try {
        const result = await abortable(interactive, stop)
        if (!result.account)
          throw new WorkIqError(
            "upstream",
            "Sign-in finished without an account.",
          )
        await keepOnly(result.account)
        return toAccount(result.account)
      } catch (error) {
        if (stop.aborted) {
          if (redirectUri) await releaseLoopback(redirectUri)
          if (timeout.signal.aborted && !signal.aborted) {
            throw new WorkIqError(
              "sign-in-timeout",
              `Sign-in timed out after ${Math.round(timeoutMs / 60_000) || 1} minute(s). Try again.`,
            )
          }
          throw new WorkIqError("sign-in-cancelled", "Sign-in was cancelled.", {
            cause: error,
          })
        }
        throw toWorkIqError(error)
      } finally {
        clearTimeout(timer)
      }
    },

    async signOut() {
      memo = undefined
      for (const account of await accounts()) await cache.removeAccount(account)
      await options.store.delete(TOKEN_CACHE_FILE)
    },
  }
}
