import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

import { getConfig } from "./config"

interface AuthMiddlewareOptions {
  getApiKeys?: () => Array<string>
  allowUnauthenticatedPaths?: Array<string>
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
  return normalizeApiKeys(config.auth?.apiKeys)
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
    if (apiKeys.length === 0) {
      return next()
    }

    const requestApiKey = extractRequestApiKey(c)
    if (!requestApiKey || !apiKeys.includes(requestApiKey)) {
      return createUnauthorizedResponse(c)
    }

    return next()
  }
}
