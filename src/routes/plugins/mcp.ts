/**
 * `/mcp/<pluginId>` — a plugin's tools as an MCP server (Streamable HTTP),
 * served in-process from the plugin gateway (sessions: `./mcp-sessions`).
 *
 * The URL and server name are the plugin id, so Claude Code entries written
 * for `/mcp/workiq` keep working and tools keep their `mcp__workiq__*`
 * names. Sessions are stateful (elicitation needs a session to send the
 * request back on) and last until the client deletes them, the plugin is
 * turned off, or they sit idle with no open stream for half an hour.
 *
 * - `tools/list` comes from the gateway (empty while the plugin is still
 *   starting or needs setup); `notifications/tools/list_changed` goes out,
 *   debounced, whenever the plugin's tools or lifecycle change.
 * - `tools/call` runs the plugin's tool with the request's abort signal, the
 *   session id, progress notifications when the client sent a progress
 *   token, and elicitation when the client declared it.
 *
 * Authentication is the main port's (`auth.enforce`, `auth.apiKeys`,
 * `auth.apiKeyEntries`). Requests must come from loopback and carry no
 * foreign `Origin`, so plugin tools are never exposed to the LAN or to
 * browser pages (DNS rebinding). An unknown or disabled plugin is a 404.
 */

import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"
import type { Context, MiddlewareHandler } from "hono"

import { Hono } from "hono"

import {
  createAuthMiddleware,
  defaultGetRequestIp,
  isLoopbackAddress,
} from "~/lib/auth/request-auth"
import { getPluginGateway } from "~/lib/plugins/gateway"

import { type McpSessionOptions, McpSessions } from "./mcp-sessions"

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"])

const ERRORS = {
  MCP_ORIGIN_REJECTED: [403, "Cross-origin requests are not allowed."],
  MCP_ENDPOINT_NOT_FOUND: [404, "No plugin with this id is turned on."],
  MCP_BUSY: [503, "Too many MCP sessions are open."],
} as const satisfies Record<string, readonly [403 | 404 | 503, string]>

export interface PluginMcpRoutesOptions extends Partial<McpSessionOptions> {
  getGateway?: () => PluginGateway | undefined
  getRequestIp?: (c: Context) => string | null
}

export interface PluginMcpRoutes {
  readonly app: Hono
  /** Open sessions, for one plugin or all. */
  sessionCount(pluginId?: string): number
  closeAll(): Promise<void>
}

function mcpError(c: Context, code: keyof typeof ERRORS): Response {
  const [status, message] = ERRORS[code]
  return c.json({ error: { type: "mcp_error", code, message } }, status)
}

function jsonRpcError(
  c: Context,
  status: 400 | 404,
  error: { code: number; message: string },
): Response {
  return c.json({ jsonrpc: "2.0", error, id: null }, status)
}

function hasForeignOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return false
  try {
    return !LOOPBACK_HOSTNAMES.has(new URL(origin).hostname)
  } catch {
    return true
  }
}

export function createPluginMcpRoutes(
  options: PluginMcpRoutesOptions = {},
): PluginMcpRoutes {
  const getGateway = options.getGateway ?? getPluginGateway
  const getRequestIp = options.getRequestIp ?? defaultGetRequestIp
  const sessions = new McpSessions({
    getGateway,
    idleTimeoutMs: options.idleTimeoutMs ?? 30 * 60_000,
    maxSessions: options.maxSessions ?? 64,
    listChangedDelayMs: options.listChangedDelayMs ?? 100,
  })
  // Same decision as the main-port middleware, minus its bypass lists.
  const mainPortAuth: MiddlewareHandler = createAuthMiddleware({
    allowUnauthenticatedPaths: [],
    allowOptionsBypass: false,
  })

  const app = new Hono()

  app.all("/:pluginId", async (c, next) => {
    if (!isLoopbackAddress(getRequestIp(c))) return c.notFound()
    if (hasForeignOrigin(c.req.header("origin"))) {
      return mcpError(c, "MCP_ORIGIN_REJECTED")
    }
    if (getGateway()?.get(c.req.param("pluginId"))?.enabled !== true) {
      return mcpError(c, "MCP_ENDPOINT_NOT_FOUND")
    }
    return mainPortAuth(c, next)
  })

  app.all("/:pluginId", async (c) => {
    const pluginId = c.req.param("pluginId")
    const gateway = getGateway()
    if (!gateway) return mcpError(c, "MCP_ENDPOINT_NOT_FOUND")
    sessions.watch(gateway)

    const sessionId = c.req.header("mcp-session-id")
    if (sessionId !== undefined) {
      const session = sessions.get(sessionId, pluginId)
      if (!session) {
        return jsonRpcError(c, 404, {
          code: -32_001,
          message: "Session not found",
        })
      }
      return sessions.serve(session, c.req.raw)
    }

    if (c.req.method !== "POST") {
      return jsonRpcError(c, 400, {
        code: -32_000,
        message: "Bad Request: Mcp-Session-Id header is required",
      })
    }
    if (!sessions.makeRoom()) return mcpError(c, "MCP_BUSY")
    const session = await sessions.open(pluginId)
    const response = await sessions.serve(session, c.req.raw)
    // Anything but a successful `initialize` leaves no session behind.
    if (session.id === undefined) void sessions.close(session)
    return response
  })

  return {
    app,
    sessionCount: (pluginId) => sessions.count(pluginId),
    closeAll: () => sessions.closeAll(),
  }
}

export const pluginMcpRoutes = createPluginMcpRoutes()
