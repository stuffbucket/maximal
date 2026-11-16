/**
 * `/mcp` and `/mcp/<pluginId>` — Maximal's connector tools as Streamable
 * HTTP MCP servers, served in-process from the plugin gateway (sessions:
 * `./mcp-sessions`). The root endpoint aggregates every enabled connector,
 * namespacing tools as `<pluginId>__<toolName>`; the connector endpoints keep
 * their native tool names. Only plugins of kind `connector` get an individual
 * endpoint.
 *
 * An individual URL and server name are the plugin id (`/mcp/workiq`); Claude
 * Code knows that endpoint as `maximal-workiq` (see `lib/plugins/clients`).
 * The aggregate server is named `maximal`.
 * Sessions are stateful (elicitation needs a session to send the
 * request back on) and last until the client deletes them, the plugin is
 * turned off, or they sit idle with no open stream for half an hour.
 *
 * - `tools/list` comes from the gateway: live tools, with the ones blocked
 *   in Settings listed as turned off (empty while the plugin is still
 *   starting or needs setup, and for a caller whose App Permission is
 *   Block); `notifications/tools/list_changed` goes out, debounced, whenever
 *   the plugin's tools, their permissions, its lifecycle or an App
 *   Permission change. A call to a blocked tool is an `isError` result from
 *   the gateway.
 * - The caller is identified by its API key: a key labelled like an app
 *   ("Claude Code") is that app's `app:<id>` target, any other key is
 *   `connection:<entry id>`, a request with no key (auth not enforced) isn't
 *   subject to App Permissions, and a key that matches no enabled entry is
 *   Block. A session is bound to the caller that
 *   opened it. Allow runs tools; Ask asks the person before each call (even
 *   for tools that are Allow); Block lists no tools and refuses calls.
 * - `tools/call` runs the plugin's tool with the request's abort signal, the
 *   session id, progress notifications when the client sent a progress
 *   token, and elicitation when the client declared it.
 *
 * Authentication is the main port's (`auth.enforce`, `auth.apiKeys`,
 * `auth.apiKeyEntries`). Requests must come from loopback and carry no
 * foreign `Origin`, so plugin tools are never exposed to the LAN or to
 * browser pages (DNS rebinding). An unknown or disabled plugin, or one that
 * isn't a connector, is a 404.
 */

import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"
import type { Context, MiddlewareHandler } from "hono"

import { Hono } from "hono"

import type { GenerationAffinityDiagnostics } from "~/lib/plugins/generation-affinity"

import { hasForeignOrigin } from "~/lib/auth/origin"
import {
  createAuthMiddleware,
  defaultGetRequestIp,
  extractRequestApiKey,
  findApiKeyEntry,
  isLoopbackAddress,
} from "~/lib/auth/request-auth"
import {
  PLUGIN_CLIENT_NAMES,
  PLUGIN_UNIDENTIFIED_ACCESS_ID,
  pluginAccessIdForApiKey,
  pluginClientForApiKeyLabel,
} from "~/lib/plugins/access"
import { getPluginGateway } from "~/lib/plugins/gateway"
import { pluginGenerationLifecycle } from "~/lib/plugins/generation-lifecycle"
import { state } from "~/lib/runtime-state/state"

import {
  type McpCaller,
  type McpSessionOptions,
  McpSessions,
} from "./mcp-sessions"

const ERRORS = {
  MCP_ORIGIN_REJECTED: [403, "Cross-origin requests are not allowed."],
  MCP_ENDPOINT_NOT_FOUND: [404, "No connector with this id is turned on."],
  MCP_BUSY: [503, "Too many MCP sessions are open."],
} as const satisfies Record<string, readonly [403 | 404 | 503, string]>

export interface McpGenerationLifecycle {
  releaseUpstreamSession(
    generationId: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void>
  subscribeCutovers(
    listener: (generationId: string, drainDeadline: number) => void,
  ): () => void
}

export interface PluginMcpRoutesOptions extends Partial<McpSessionOptions> {
  getGateway?: () => PluginGateway | undefined
  getRequestIp?: (c: Context) => string | null
  generationLifecycle?: McpGenerationLifecycle
}

export interface PluginMcpRoutes {
  readonly app: Hono
  /** Open sessions, for one plugin or all. */
  sessionCount(pluginId?: string): number
  cutoverGeneration(generationId: string, drainDeadline: number): void
  affinityDiagnostics(): GenerationAffinityDiagnostics
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

/**
 * Who is calling. No key (auth not enforced) and Maximal's own shell key are
 * outside App Permissions. A key that is presented but isn't an enabled
 * entry (disabled, deleted, rotated, or a legacy bare key) can't be
 * attributed, so it is the unidentified caller, which is always Block.
 */
function mcpCaller(c: Context): McpCaller {
  const key = extractRequestApiKey(c)
  if (!key || (state.shellApiKey && key === state.shellApiKey)) {
    return { accessId: undefined, name: undefined }
  }
  const entry = findApiKeyEntry(key)
  if (!entry) {
    return { accessId: PLUGIN_UNIDENTIFIED_ACCESS_ID, name: undefined }
  }
  const clientId = pluginClientForApiKeyLabel(entry.label)
  return {
    accessId: pluginAccessIdForApiKey(entry),
    name: clientId ? PLUGIN_CLIENT_NAMES[clientId] : entry.label,
  }
}

export function createPluginMcpRoutes(
  options: PluginMcpRoutesOptions = {},
): PluginMcpRoutes {
  const getGateway = options.getGateway ?? getPluginGateway
  const getRequestIp = options.getRequestIp ?? defaultGetRequestIp
  const releaseUpstreamSession =
    options.generationLifecycle?.releaseUpstreamSession.bind(
      options.generationLifecycle,
    )
    ?? options.releaseUpstreamSession
    ?? (() =>
      Promise.reject(new Error("MCP generation lifecycle is not configured.")))
  const sessions = new McpSessions({
    getGateway,
    idleTimeoutMs: options.idleTimeoutMs ?? 30 * 60_000,
    maxSessions: options.maxSessions ?? 64,
    listChangedDelayMs: options.listChangedDelayMs ?? 100,
    releaseUpstreamSession,
  })
  const unsubscribeCutovers = options.generationLifecycle?.subscribeCutovers(
    (generationId, drainDeadline) => {
      sessions.cutoverGeneration(generationId, drainDeadline)
    },
  )
  // Same decision as the main-port middleware, minus its bypass lists.
  const mainPortAuth: MiddlewareHandler = createAuthMiddleware({
    allowUnauthenticatedPaths: [],
    allowOptionsBypass: false,
  })
  const app = new Hono()
  const guard =
    (pluginId: (c: Context) => string | undefined): MiddlewareHandler =>
    async (c, next) => {
      if (!isLoopbackAddress(getRequestIp(c))) return c.notFound()
      if (hasForeignOrigin(c.req.header("origin"))) {
        return mcpError(c, "MCP_ORIGIN_REJECTED")
      }
      const id = pluginId(c)
      if (id !== undefined) {
        const snapshot = getGateway()?.get(id)
        if (snapshot?.kind !== "connector" || !snapshot.enabled) {
          return mcpError(c, "MCP_ENDPOINT_NOT_FOUND")
        }
      }
      return mainPortAuth(c, next)
    }

  const serve = async (
    c: Context,
    pluginId: string | undefined,
  ): Promise<Response> => {
    const gateway = getGateway()
    if (!gateway) return mcpError(c, "MCP_ENDPOINT_NOT_FOUND")
    sessions.watch(gateway)
    const caller = mcpCaller(c)

    const sessionId = c.req.header("mcp-session-id")
    if (sessionId !== undefined) {
      const session = sessions.get(sessionId, pluginId, caller.accessId)
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
    const session = await sessions.open(pluginId, caller)
    try {
      return await sessions.serve(session, c.req.raw)
    } finally {
      // Anything but a successful `initialize` (including a throw) leaves no
      // session behind; otherwise it would sit in `#opening` and count
      // toward the cap forever.
      if (session.id === undefined) void sessions.close(session)
    }
  }

  app.all(
    "/",
    guard(() => undefined),
  )
  app.all("/", (c) => serve(c, undefined))
  app.all(
    "/:pluginId",
    guard((c) => c.req.param("pluginId")),
  )
  app.all("/:pluginId", (c) => serve(c, c.req.param("pluginId")))

  return {
    app,
    sessionCount: (pluginId) => sessions.count(pluginId),
    cutoverGeneration: (generationId, drainDeadline) =>
      sessions.cutoverGeneration(generationId, drainDeadline),
    affinityDiagnostics: () => sessions.affinityDiagnostics(),
    closeAll: async () => {
      unsubscribeCutovers?.()
      await sessions.closeAll()
    },
  }
}

export const pluginMcpRoutes = createPluginMcpRoutes({
  generationLifecycle: pluginGenerationLifecycle,
})
