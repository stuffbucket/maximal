import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

import { recordClient } from "./active-clients"
import { getConfig } from "./config"
import { state } from "./state"

interface AuthMiddlewareOptions {
  getApiKeys?: () => Array<string>
  allowUnauthenticatedPaths?: Array<string>
  /**
   * Path prefixes that bypass auth. Used by the static settings bundle
   * at /settings/* (which has many hashed asset URLs). Data endpoints
   * under /settings/api/* are NOT in this list — they're auth-gated like
   * everything else.
   */
  allowUnauthenticatedPrefixes?: Array<string>
  /**
   * Path prefixes that re-enable auth even when they fall under one of
   * the prefixes in `allowUnauthenticatedPrefixes`. Lets us say
   * "/settings/* is open, but /settings/api/* is still auth-gated"
   * without having to enumerate every static asset path.
   */
  requireAuthPrefixes?: Array<string>
  allowOptionsBypass?: boolean
  /**
   * Paths that should skip auth when the request comes from loopback
   * (127.0.0.1, ::1, ::ffff:127.0.0.1). Used to exempt the local usage
   * dashboard from needing an API key while keeping the same endpoints
   * authenticated for any non-loopback caller.
   */
  loopbackOnlyPaths?: Array<string>
  /**
   * Resolves the peer IP for the current request. Injectable so tests
   * can simulate loopback vs. non-loopback requests without spinning up
   * a real Bun.serve / Node http.Server.
   */
  getRequestIp?: (c: Context) => string | null
}

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false
  return LOOPBACK_IPS.has(address)
}

/**
 * Reads the peer IP off the raw Request object. srvx attaches `ip` to
 * the request for both its Bun and Node adapters
 * (Bun: `server.requestIP(req).address`; Node: `req.socket.remoteAddress`),
 * so the same field works for our deployment paths.
 */
export function defaultGetRequestIp(c: Context): string | null {
  const raw = c.req.raw as Request & { ip?: string | null }
  return raw.ip ?? null
}

export function normalizeApiKeys(apiKeys: unknown): Array<string> {
  if (!Array.isArray(apiKeys)) {
    if (apiKeys !== undefined) {
      consola.warn("Invalid auth.apiKeys config. Expected an array of strings.")
    }
    return []
  }

  const normalizedKeys = apiKeys
    .filter((key): key is string => typeof key === "string")
    .map((key) => key.trim())
    .filter((key) => key.length > 0)

  if (normalizedKeys.length !== apiKeys.length) {
    consola.warn(
      "Invalid auth.apiKeys entries found. Only non-empty strings are allowed.",
    )
  }

  return [...new Set(normalizedKeys)]
}

export function getConfiguredApiKeys(): Array<string> {
  const config = getConfig()
  const legacy = normalizeApiKeys(config.auth?.apiKeys)
  const entries = config.auth?.apiKeyEntries ?? []
  // Only enabled entries count; "*" stays in the list and is handled
  // by `apiKeyAllowed` as a wildcard.
  const fromEntries = entries
    .filter((e) => e.enabled)
    .map((e) => e.key.trim())
    .filter((k) => k.length > 0)
  return [...new Set([...legacy, ...fromEntries])]
}

/**
 * Match an incoming request key against the configured allow list.
 *
 * Honors a single special form: a "*" entry in the allow list accepts
 * any non-empty key from the client. Useful as a default "permit-all"
 * row in the Settings → API clients table — visible, toggleable, and
 * obviously broad, instead of being silently inferred from an empty
 * allow list (which means "no auth required" — a stronger statement).
 */
export function apiKeyAllowed(
  allowList: Array<string>,
  requestKey: string,
): boolean {
  if (requestKey.length === 0) return false
  if (allowList.includes("*")) return true
  return allowList.includes(requestKey)
}

/**
 * Locate the configured API-key entry that the incoming request key
 * resolves to, so the caller can attribute usage to a named client.
 * Returns null when no entry matches (e.g. legacy `auth.apiKeys` row
 * matched but isn't in the entry registry).
 */
export function findApiKeyEntry(
  requestKey: string,
): { id: string; label: string } | null {
  if (requestKey.length === 0) return null
  const config = getConfig()
  const entries = config.auth?.apiKeyEntries ?? []
  // Exact match first.
  const exact = entries.find((e) => e.enabled && e.key === requestKey)
  if (exact) return { id: exact.id, label: exact.label }
  // Wildcard "*" entry matches any non-empty key.
  const wildcard = entries.find((e) => e.enabled && e.key === "*")
  if (wildcard) return { id: wildcard.id, label: wildcard.label }
  return null
}

export function extractRequestApiKey(c: Context): string | null {
  const xApiKey = c.req.header("x-api-key")?.trim()
  if (xApiKey) {
    return xApiKey
  }

  const authorization = c.req.header("authorization")
  if (!authorization) {
    return null
  }

  const [scheme, ...rest] = authorization.trim().split(/\s+/)
  if (scheme.toLowerCase() !== "bearer") {
    return null
  }

  const bearerToken = rest.join(" ").trim()
  return bearerToken || null
}

function createUnauthorizedResponse(c: Context): Response {
  c.header("WWW-Authenticate", 'Bearer realm="copilot-api"')
  return c.json(
    {
      error: {
        message: "Unauthorized",
        type: "authentication_error",
      },
    },
    401,
  )
}

export function createAuthMiddleware(
  options: AuthMiddlewareOptions = {},
): MiddlewareHandler {
  const getApiKeys = options.getApiKeys ?? getConfiguredApiKeys
  const allowUnauthenticatedPaths = options.allowUnauthenticatedPaths ?? ["/"]
  const allowUnauthenticatedPrefixes =
    options.allowUnauthenticatedPrefixes ?? []
  const requireAuthPrefixes = options.requireAuthPrefixes ?? []
  const allowOptionsBypass = options.allowOptionsBypass ?? true
  const loopbackOnlyPaths = options.loopbackOnlyPaths ?? []
  const getRequestIp = options.getRequestIp ?? defaultGetRequestIp

  return async (c, next) => {
    if (allowOptionsBypass && c.req.method === "OPTIONS") {
      return next()
    }

    if (allowUnauthenticatedPaths.includes(c.req.path)) {
      return next()
    }

    // Path-boundary aware: prefix "/settings" matches "/settings",
    // "/settings/" and "/settings/foo", but NOT "/settings-other".
    // `requireAuthPrefixes` re-enables auth for nested sub-prefixes —
    // e.g. "/settings" is open but "/settings/api" is still gated.
    const path = c.req.path
    if (
      allowUnauthenticatedPrefixes.some(
        (p) => path === p || path.startsWith(p + "/"),
      )
      && !requireAuthPrefixes.some(
        (p) => path === p || path.startsWith(p + "/"),
      )
    ) {
      return next()
    }

    // Loopback exemption: the local usage dashboard talks to these
    // endpoints from the same machine and should not have to handle an
    // API key. Non-loopback callers still go through the normal key
    // check below.
    if (
      loopbackOnlyPaths.includes(c.req.path)
      && isLoopbackAddress(getRequestIp(c))
    ) {
      return next()
    }

    const apiKeys = getApiKeys()
    const userAgent = c.req.header("user-agent") ?? ""
    if (apiKeys.length === 0) {
      // Auth not enforced — still record the caller so the menu-bar
      // shell can show who's connected.
      recordClient({ apiKeyId: null, apiKeyLabel: null, userAgent })
      return next()
    }

    const requestApiKey = extractRequestApiKey(c)
    if (!requestApiKey || !apiKeyAllowed(apiKeys, requestApiKey)) {
      return createUnauthorizedResponse(c)
    }

    const entry = findApiKeyEntry(requestApiKey)
    recordClient({
      apiKeyId: entry?.id ?? null,
      apiKeyLabel: entry?.label ?? null,
      userAgent,
    })

    return next()
  }
}

/**
 * Gate for routes that forward to the GitHub Copilot upstream. Orthogonal
 * to {@link createAuthMiddleware} (which validates the *client's* API key);
 * this one short-circuits when the proxy itself has no GitHub token to
 * forward with. Lets the HTTP server come up in "unauthenticated mode"
 * (settings + diagnostics still reachable) without the Tauri shell
 * needing to handshake the device-code flow before port 4142 listens.
 */
export const requireGithubAuth: MiddlewareHandler = async (c, next) => {
  if (state.githubToken) {
    return next()
  }
  return c.json(
    {
      error: "not_authenticated",
      hint: "Open Settings → Account to sign in, or run `maximal auth`.",
    },
    401,
  )
}
