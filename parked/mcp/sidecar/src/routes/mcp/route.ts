/**
 * /mcp/<id> — stable main-port address for brokered MCP endpoints.
 *
 * The isolated broker listens on a private loopback port with a key that
 * only this process knows (see `getBrokerUpstream`). This route is the
 * public face: it checks the caller, then forwards the request and streams
 * the response. A missing, restarting, or hung broker only fails `/mcp/*`.
 *
 * Authentication:
 *   - an endpoint with its own `apiKey` accepts exactly that key;
 *   - otherwise the request goes through the same middleware as the rest of
 *     the main port (`auth.enforce`, `auth.apiKeys`, `auth.apiKeyEntries`).
 *
 * Requests must come from loopback and carry no foreign `Origin`, so MCP
 * tools are never exposed to the LAN or to browser pages (DNS rebinding).
 *
 * A request that opens a session (no `mcp-session-id`) starts a fresh
 * instance of the server, so for a catalog server Maximal first re-reads
 * where its newest install is; the broker takes a new path without a
 * restart, and sessions already running keep theirs.
 */

import type { Context, MiddlewareHandler } from "hono"

import { Hono } from "hono"
import { timingSafeEqual } from "node:crypto"

import type { McpServerConfig } from "~/lib/mcp-broker/types"

import { refreshCatalogCommands } from "~/apps/mcp"
import {
  createAuthMiddleware,
  defaultGetRequestIp,
  extractRequestApiKey,
  isLoopbackAddress,
} from "~/lib/auth/request-auth"
import { getConfig } from "~/lib/config/config"
import {
  type BrokerUpstream,
  getBrokerUpstream,
  reconfigureBroker,
} from "~/lib/mcp-broker/supervisor"
import { isHeldBackFromBroker } from "~/lib/mcp-broker/workiq"

const MAX_CONCURRENT_REQUESTS = 32
const DEFAULT_BODY_BYTES = 1024 * 1024
const DEFAULT_HEADERS_TIMEOUT_MS = 120_000
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"])

const STRIPPED_REQUEST_HEADERS = [
  "authorization",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "origin",
  "proxy-authorization",
  "te",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
]

const STRIPPED_RESPONSE_HEADERS = [
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "access-control-max-age",
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]

interface McpRoutesOptions {
  getUpstream?: () => BrokerUpstream | undefined
  getRequestIp?: (c: Context) => string | null
  fetchUpstream?: typeof fetch
  /** Runs before a request that opens a session on a catalog endpoint. */
  beforeNewSession?: () => Promise<void>
  /** Whether an endpoint that is on is held back from the broker. */
  heldBack?: (server: McpServerConfig) => boolean
}

/** Point catalog endpoints at their newest install, then hand any change
 *  to the broker (a live update when only the path moved). */
async function useNewestInstalls(): Promise<void> {
  const before = getConfig()
  const config = refreshCatalogCommands(before)
  if (config !== before) await reconfigureBroker(config.mcpBroker ?? {})
}

function opensSession(c: Context): boolean {
  return c.req.method === "POST" && !c.req.header("mcp-session-id")
}

function jsonError(
  c: Context,
  status: 403 | 404 | 413 | 502 | 503,
  code: string,
) {
  return c.json({ error: { type: "mcp_error", code } }, status)
}

function hasForeignOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return false
  try {
    return !LOOPBACK_HOSTNAMES.has(new URL(origin).hostname)
  } catch {
    return true
  }
}

function endpointKeyMatches(expected: string, actual: string | null): boolean {
  if (actual === null) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function findEndpoint(id: string): McpServerConfig | undefined {
  const broker = getConfig().mcpBroker
  if (broker?.enabled !== true) return undefined
  return broker.servers?.find(
    (server) => server.id === id && server.enabled !== false,
  )
}

export function createMcpRoutes(options: McpRoutesOptions = {}): Hono {
  const getUpstream = options.getUpstream ?? getBrokerUpstream
  const getRequestIp = options.getRequestIp ?? defaultGetRequestIp
  const fetchUpstream = options.fetchUpstream ?? fetch
  const beforeNewSession = options.beforeNewSession ?? useNewestInstalls
  const heldBack = options.heldBack ?? isHeldBackFromBroker
  // Same decision as the main-port middleware, minus its bypass lists.
  const mainPortAuth: MiddlewareHandler = createAuthMiddleware({
    allowUnauthenticatedPaths: [],
    allowOptionsBypass: false,
  })
  let inflight = 0

  const app = new Hono()

  app.all("/:id", async (c, next) => {
    if (!isLoopbackAddress(getRequestIp(c))) return c.notFound()
    if (hasForeignOrigin(c.req.header("origin"))) {
      return jsonError(c, 403, "MCP_ORIGIN_REJECTED")
    }

    const endpoint = findEndpoint(c.req.param("id"))
    if (!endpoint) return jsonError(c, 404, "MCP_ENDPOINT_NOT_FOUND")

    if (endpoint.apiKey === undefined) return mainPortAuth(c, next)
    if (!endpointKeyMatches(endpoint.apiKey, extractRequestApiKey(c))) {
      c.header("WWW-Authenticate", 'Bearer realm="maximal-mcp"')
      return c.json(
        { error: { message: "Unauthorized", type: "authentication_error" } },
        401,
      )
    }
    return next()
  })

  app.all("/:id", async (c) => {
    const id = c.req.param("id")
    if (opensSession(c) && findEndpoint(id)?.catalog !== undefined) {
      // Best effort: a failed check still serves the install already known.
      await beforeNewSession().catch(() => undefined)
    }
    // On, but not handed to the broker until its setup is done (Work IQ's
    // terms and sign-in in Settings).
    const served = findEndpoint(id)
    if (served && heldBack(served)) {
      return jsonError(c, 503, "MCP_ENDPOINT_SETUP_NEEDED")
    }
    const upstream = getUpstream()
    if (!upstream) return jsonError(c, 503, "MCP_BROKER_UNAVAILABLE")
    if (declaredBodyTooLarge(c)) return jsonError(c, 413, "MCP_BODY_TOO_LARGE")
    if (inflight >= MAX_CONCURRENT_REQUESTS) {
      return jsonError(c, 503, "MCP_BUSY")
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    c.req.raw.signal.addEventListener("abort", abort, { once: true })
    let released = false
    const release = () => {
      if (released) return
      released = true
      inflight -= 1
      c.req.raw.signal.removeEventListener("abort", abort)
    }
    inflight += 1

    // Bound only the wait for response headers; SSE bodies may stay open.
    const headersTimer = setTimeout(
      abort,
      findEndpoint(id)?.timeouts?.callMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
    )
    const call = upstreamCall({ c, id, upstream, signal: controller.signal })
    let response: Response
    try {
      response = await fetchUpstream(call.url, call.init)
    } catch {
      release()
      return jsonError(c, 502, "MCP_BROKER_UNREACHABLE")
    } finally {
      clearTimeout(headersTimer)
    }
    return proxiedResponse(response, release)
  })

  return app
}

function declaredBodyTooLarge(c: Context): boolean {
  const maxBodyBytes =
    getConfig().mcpBroker?.limits?.httpBodyBytes ?? DEFAULT_BODY_BYTES
  return Number(c.req.header("content-length") ?? 0) > maxBodyBytes
}

/** The broker request: same method, body, and MCP headers, but the
 *  caller's credentials replaced by the broker's per-generation key. */
function upstreamCall(options: {
  c: Context
  id: string
  upstream: BrokerUpstream
  signal: AbortSignal
}): { url: string; init: RequestInit } {
  const { c, id, upstream, signal } = options
  const headers = new Headers(c.req.raw.headers)
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name)
  headers.set("authorization", `Bearer ${upstream.apiKey}`)

  const method = c.req.method
  const hasBody = method !== "GET" && method !== "HEAD"
  return {
    url: `${upstream.origin}/mcp/${id}${new URL(c.req.url).search}`,
    init: {
      method,
      headers,
      body: hasBody ? c.req.raw.body : undefined,
      signal,
      redirect: "manual",
      ...(hasBody ? { duplex: "half" } : {}),
    },
  }
}

function proxiedResponse(response: Response, release: () => void): Response {
  const headers = new Headers(response.headers)
  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name)
  const init = { status: response.status, headers }
  if (!response.body) {
    release()
    return new Response(null, init)
  }
  return new Response(releaseWhenSettled(response.body, release), init)
}

/** Pass a body through, calling `settled` once it ends, errors (e.g. the
 *  broker dies mid-stream), or the client cancels it. */
function releaseWhenSettled(
  body: ReadableStream<Uint8Array>,
  settled: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          settled()
          controller.close()
        } else {
          controller.enqueue(chunk.value)
        }
      } catch (error) {
        settled()
        controller.error(error)
      }
    },
    cancel(reason) {
      settled()
      return reader.cancel(reason)
    },
  })
}

export const mcpRoutes = createMcpRoutes()
