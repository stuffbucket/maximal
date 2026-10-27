import {
  Client,
  type ClientOptions,
  type ElicitRequestParams,
  type ElicitResult,
} from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { Server } from "@modelcontextprotocol/server"
import {
  proxyServer,
  resolveVersionNegotiation,
  startHTTPServer,
} from "mcp-proxy"
import { timingSafeEqual } from "node:crypto"
import http from "node:http"

import type {
  BrokerWireConfiguration,
  ResolvedMcpEndpoint,
} from "./wire-config.ts"

import {
  type AskMaximal,
  answerElicitation,
  policyCanElicit,
} from "./elicitation.ts"
import { createStderrForwarder, formatServerStderr } from "./server-stderr.ts"

const EXTERNAL_HOST = "127.0.0.1"
const INTERNAL_PATH = "/mcp"
const EXTERNAL_PATH_PREFIX = "/mcp/"

const HOP_BY_HOP_HEADERS = new Set([
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "access-control-max-age",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

export type BrokerStartupErrorCode =
  | "BROKER_AUTH_INVALID"
  | "BROKER_BIND_FAILED"
  | "ENDPOINT_CONNECT_FAILED"
  | "ENDPOINT_SHARING_DISABLED"
  /** An update changed more than how new instances start. */
  | "RESTART_REQUIRED"

export class BrokerStartupError extends Error {
  readonly code: BrokerStartupErrorCode

  constructor(code: BrokerStartupErrorCode, options?: ErrorOptions) {
    super(code, options)
    this.name = "BrokerStartupError"
    this.code = code
  }
}

const sanitizeIdentity = (
  value: string | undefined,
  fallback: string,
): string =>
  (value ?? fallback).replaceAll(/[\u0000-\u001f\u007f]/gu, "�").slice(0, 256)

export interface EndpointObservation {
  id: string
  serverName: string
  serverVersion: string
  negotiatedProtocol?: string
  protocolEra?: "legacy" | "modern"
  /** Every session owns its own upstream instance; none is shared. */
  ownership: "exclusive"
  capabilities: {
    completions: boolean
    logging: boolean
    prompts: boolean
    resources: boolean
    tools: boolean
  }
  /** Tool names the server listed when it started. Some servers list more
   *  once the user has signed in (Work IQ's remote tools). */
  tools: Array<string>
}

interface RunningEndpoint {
  close(): Promise<void>
  id: string
  internalPort: number
  observation: EndpointObservation
  /** Use these settings for instances started from now on. */
  update(endpoint: ResolvedMcpEndpoint): void
  /** Note a request for session `sessionId` starting; call the result when
   *  it ends. Feeds which session to close when the limit is reached. */
  trackRequest(sessionId: string): () => void
}

export interface RunningBrokerServer {
  close(): Promise<void>
  endpoints: Array<EndpointObservation>
  host: typeof EXTERNAL_HOST
  port: number
  /** Apply new settings to how future session instances start, without
   *  touching sessions already running. Throws RESTART_REQUIRED when the
   *  change needs a new broker (see `isLiveUpdate`). */
  update(configuration: BrokerWireConfiguration): void
}

/** What a running endpoint's listener was built around. Everything else
 *  only affects how the next instance starts. */
const listenerShape = (endpoint: ResolvedMcpEndpoint) => ({
  id: endpoint.id,
  protocol: endpoint.protocol,
  interaction: endpoint.interaction,
  ownership: endpoint.ownership,
  sessionIdleTimeoutMs: endpoint.sessionIdleTimeoutMs,
})

/** True when `next` can be applied to a broker running `current`: same
 *  endpoints, built the same way, only their launch settings differ. */
export const isLiveUpdate = (
  current: BrokerWireConfiguration,
  next: BrokerWireConfiguration,
): boolean =>
  current.httpBodyBytes === next.httpBodyBytes
  && current.heartbeatIntervalMs === next.heartbeatIntervalMs
  && JSON.stringify(current.endpoints.map(listenerShape))
    === JSON.stringify(next.endpoints.map(listenerShape))

const clientOptions = (endpoint: ResolvedMcpEndpoint): ClientOptions => ({
  // Advertised before the session's client is known, so it can't depend on
  // what that client supports; each request is routed when it arrives.
  capabilities:
    policyCanElicit(endpoint.elicitation) ?
      { elicitation: { form: {}, url: {} } }
    : {},
  versionNegotiation: resolveVersionNegotiation(endpoint.protocol),
})

type ElicitationHandler = (
  params: ElicitRequestParams,
  signal: AbortSignal,
) => Promise<ElicitResult>

/** Start one upstream instance of the endpoint's stdio server. */
const connectUpstream = async (
  endpoint: ResolvedMcpEndpoint,
  onStderr: (chunk: Buffer) => void,
  onElicit?: ElicitationHandler,
): Promise<Client> => {
  const transport = new StdioClientTransport({
    args: endpoint.args,
    command: endpoint.command,
    cwd: endpoint.cwd,
    env: endpoint.environment,
    stderr: "pipe",
  })
  transport.stderr?.on("data", onStderr)

  const options = clientOptions(endpoint)
  const client = new Client(
    { name: "maximal-mcp-broker", version: "0.0.0" },
    options,
  )
  if (onElicit && options.capabilities?.elicitation) {
    client.setRequestHandler("elicitation/create", (request, ctx) =>
      onElicit(request.params, ctx.mcpReq.signal),
    )
  }
  try {
    await client.connect(transport, { timeout: endpoint.initializeTimeoutMs })
  } catch (error) {
    await client.close().catch(() => undefined)
    throw error
  }
  return client
}

/** A refusal mcp-proxy sends as-is (it answers a thrown Response verbatim). */
const refusal = (status: number, message: string): Response =>
  Response.json(
    { error: { code: -32_000, message }, id: null, jsonrpc: "2.0" },
    { status },
  )

/**
 * Forward tool calls as mcp-proxy does, but remember which are running, so a
 * request for user input can say which tool it's for. A call may now wait on
 * the user, so it gets the input timeout on top of its own.
 */
const trackToolCalls = (
  server: Server,
  client: Client,
  session: SessionState,
  settings: ResolvedMcpEndpoint,
): void => {
  const timeout =
    settings.callTimeoutMs
    + (policyCanElicit(settings.elicitation) ? settings.elicitation.timeoutMs : 0)
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const progressToken = ctx.mcpReq._meta?.progressToken
    const call = { name: request.params.name }
    session.toolCalls.add(call)
    try {
      return await client.callTool(request.params, {
        ...(progressToken === undefined ?
          {}
        : {
            onprogress: (progress) => {
              void ctx.mcpReq
                .notify({
                  method: "notifications/progress",
                  params: { ...progress, progressToken },
                })
                .catch(() => undefined)
            },
          }),
        signal: ctx.mcpReq.signal,
        timeout,
      })
    } finally {
      session.toolCalls.delete(call)
    }
  })
}

/**
 * One endpoint: a private loopback listener whose every MCP session gets its
 * own upstream instance, as if each client ran the server itself. Nothing is
 * shared between sessions, so one client's requests, interactions and
 * cancellations can't reach another's. Closing a session closes its instance.
 */
/** A session's running tool calls, so a request can name the one it serves,
 *  and how recently it was used, so the limit can make room. */
interface SessionState {
  downstream?: Server
  toolCalls: Set<{ name: string }>
  /** Requests (not long-lived event streams) still being answered. */
  inFlight: number
  lastUsedAt: number
}

interface OpenSession {
  client: Client
  state: SessionState
}

/** Session id mcp-proxy gave this server's transport, once it has one. */
const sessionIdOf = (server: Server): string | undefined =>
  server.transport?.sessionId

/**
 * The session to close to make room for a new one: the least recently used
 * with nothing in flight. A client that exits without a DELETE leaves its
 * session open, and under Bun the broker never sees its event stream go
 * away, so idle reaping can't reclaim it. One still initializing (no id
 * yet) is never chosen.
 */
const evictionCandidate = (
  sessions: ReadonlyMap<Server, OpenSession>,
): Server | undefined => {
  let candidate: { server: Server; lastUsedAt: number } | undefined
  for (const [server, { state }] of sessions) {
    if (state.inFlight > 0 || sessionIdOf(server) === undefined) continue
    if (!candidate || state.lastUsedAt < candidate.lastUsedAt) {
      candidate = { server, lastUsedAt: state.lastUsedAt }
    }
  }
  return candidate?.server
}

const MAX_TOOL_NAMES = 256
const MAX_TOOL_PAGES = 8

/** The tool names a server lists, bounded; empty when listing fails. */
const listToolNames = async (
  client: Client,
  timeout: number,
): Promise<Array<string>> => {
  const names: Array<string> = []
  try {
    let cursor: string | undefined
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined, {
        timeout,
      })
      for (const tool of result.tools) {
        names.push(sanitizeIdentity(tool.name, "unnamed").slice(0, 128))
      }
      cursor = result.nextCursor
      if (!cursor || names.length >= MAX_TOOL_NAMES) break
    }
  } catch {
    // Listing is for the status Maximal shows; the endpoint still serves.
  }
  return names.slice(0, MAX_TOOL_NAMES)
}

const startEndpoint = async (
  initial: ResolvedMcpEndpoint,
  apiKey: string,
  maxBodyBytes: number,
  askMaximal: AskMaximal | undefined,
  onServerStderr: ServerStderrSink,
): Promise<RunningEndpoint> => {
  // Replaced by `update`; each new session reads it when it starts.
  let endpoint = initial
  if (endpoint.ownership === "shareable") {
    throw new BrokerStartupError("ENDPOINT_SHARING_DISABLED")
  }
  // Shared by every instance, so the line limit is per endpoint.
  const forwardStderr = createStderrForwarder((line) =>
    onServerStderr(initial.id, line),
  )

  // Probe once at startup: proves the command runs and records what it
  // serves. Sessions start their own instances.
  let probe: Client
  try {
    probe = await connectUpstream(endpoint, forwardStderr)
  } catch (error) {
    throw new BrokerStartupError("ENDPOINT_CONNECT_FAILED", { cause: error })
  }
  const serverCapabilities = probe.getServerCapabilities() ?? {}
  const serverVersion = probe.getServerVersion() ?? {
    name: "anonymous-upstream",
    version: "unknown",
  }
  const protocolEra = probe.getProtocolEra()
  const negotiatedProtocol = probe.getNegotiatedProtocolVersion()
  const tools =
    serverCapabilities.tools ?
      await listToolNames(probe, endpoint.initializeTimeoutMs)
    : []
  await probe.close().catch(() => undefined)

  const sessions = new Map<Server, OpenSession>()
  let opening = 0

  /**
   * Close the least recently used idle session. Chooses and forgets it
   * synchronously, so a concurrent new session neither picks it too nor
   * counts its slot as free twice; undefined when every session is busy.
   */
  const evictIdleSession = (): Promise<void> | undefined => {
    const server = evictionCandidate(sessions)
    const evicted = server && sessions.get(server)
    if (!server || !evicted) return undefined
    sessions.delete(server)
    process.stderr.write(
      `[maximal-mcp-broker] SESSION_EVICTED endpoint=${endpoint.id} limit=${endpoint.maxSessions}\n`,
    )
    // Closing the server takes the same path a DELETE does inside mcp-proxy.
    return Promise.all([
      server.close().catch(() => undefined),
      evicted.client.close().catch(() => undefined),
    ]).then(() => undefined)
  }

  let httpServer
  try {
    httpServer = await startHTTPServer({
      apiKey,
      createServer: async () => {
        const full = sessions.size + opening >= endpoint.maxSessions
        const evicting = full ? evictIdleSession() : undefined
        if (full && !evicting) {
          throw refusal(
            503,
            `${endpoint.label} already has ${endpoint.maxSessions} sessions open; close one and retry.`,
          )
        }
        // Reserved before the first await, together with the eviction.
        opening += 1
        // Settings as of this session's start, like everything else it uses.
        const settings = endpoint
        const session: SessionState = {
          toolCalls: new Set(),
          inFlight: 0,
          lastUsedAt: Date.now(),
        }
        let client: Client
        try {
          await evicting
          client = await connectUpstream(settings, forwardStderr, (params, signal) => {
            const [call] = session.toolCalls.size === 1 ? session.toolCalls : []
            return answerElicitation(params, {
              endpointId: settings.id,
              label: settings.label,
              era: protocolEra === "modern" ? "modern" : "legacy",
              policy: settings.elicitation,
              toolName: call?.name,
              downstream: session.downstream,
              askMaximal,
              signal,
            })
          })
        } catch {
          throw refusal(502, `${endpoint.label} failed to start.`)
        } finally {
          opening -= 1
        }
        const server = new Server(client.getServerVersion() ?? serverVersion, {
          capabilities: client.getServerCapabilities() ?? serverCapabilities,
          inputRequired: { legacyShim: false },
          instructions: client.getInstructions(),
        })
        const upstreamCapabilities = client.getServerCapabilities() ?? {}
        try {
          await proxyServer({
            client,
            requestTimeout: settings.callTimeoutMs,
            server,
            serverCapabilities: upstreamCapabilities,
          })
        } catch (error) {
          await client.close().catch(() => undefined)
          throw error
        }
        if (upstreamCapabilities.tools) {
          trackToolCalls(server, client, session, settings)
        }
        session.downstream = server
        sessions.set(server, { client, state: session })
        return server
      },
      enableJsonResponse: true,
      eventStore: false,
      host: EXTERNAL_HOST,
      maxBodySize: maxBodyBytes,
      modern: protocolEra === "modern",
      onClose: async (server) => {
        const open = sessions.get(server)
        sessions.delete(server)
        await open?.client.close().catch(() => undefined)
      },
      port: 0,
      sessionIdleTimeout: endpoint.sessionIdleTimeoutMs,
      sseEndpoint: null,
      stateless: false,
      streamEndpoint: INTERNAL_PATH,
    })
  } catch (error) {
    throw new BrokerStartupError("BROKER_BIND_FAILED", { cause: error })
  }

  let closed = false
  return {
    id: endpoint.id,
    internalPort: httpServer.address.port,
    update(next) {
      endpoint = next
    },
    trackRequest(sessionId) {
      const open = [...sessions].find(
        ([server]) => sessionIdOf(server) === sessionId,
      )?.[1]
      if (!open) return () => undefined
      const { state } = open
      state.inFlight += 1
      state.lastUsedAt = Date.now()
      let ended = false
      return () => {
        if (ended) return
        ended = true
        state.inFlight -= 1
        state.lastUsedAt = Date.now()
      }
    },
    observation: {
      id: endpoint.id,
      serverName: sanitizeIdentity(serverVersion.name, "anonymous-upstream"),
      serverVersion: sanitizeIdentity(serverVersion.version, "unknown"),
      negotiatedProtocol,
      protocolEra,
      ownership: "exclusive",
      capabilities: {
        completions: serverCapabilities.completions !== undefined,
        logging: serverCapabilities.logging !== undefined,
        prompts: serverCapabilities.prompts !== undefined,
        resources: serverCapabilities.resources !== undefined,
        tools: serverCapabilities.tools !== undefined,
      },
      tools,
    },
    async close() {
      if (closed) {
        return
      }
      closed = true
      await httpServer.close().catch(() => undefined)
      const clients = [...sessions.values()].map((open) => open.client)
      sessions.clear()
      await Promise.all(
        clients.map((client) => client.close().catch(() => undefined)),
      )
    },
  }
}

const hasValidAuthorization = (
  authorization: string | undefined,
  apiKey: string,
): boolean => {
  const expected = Buffer.from(`Bearer ${apiKey}`)
  const actual = Buffer.from(authorization ?? "")
  return (
    actual.byteLength === expected.byteLength
    && timingSafeEqual(actual, expected)
  )
}

const copyHeaders = (
  source: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders => {
  const headers: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(source)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
      headers[name] = value
    }
  }
  return headers
}

const startFrontDoor = async (
  endpoints: ReadonlyMap<string, RunningEndpoint>,
  apiKey: string,
): Promise<{ close(): Promise<void>; port: number }> => {
  const server = http.createServer((request, response) => {
    if (!hasValidAuthorization(request.headers.authorization, apiKey)) {
      response.writeHead(401, {
        "content-type": "application/json; charset=utf-8",
      })
      response.end('{"error":"unauthorized"}')
      return
    }

    let requestUrl: URL
    try {
      requestUrl = new URL(request.url ?? "", "http://127.0.0.1")
    } catch {
      response.writeHead(400).end()
      return
    }

    if (!requestUrl.pathname.startsWith(EXTERNAL_PATH_PREFIX)) {
      response.writeHead(404).end()
      return
    }

    const endpointId = requestUrl.pathname.slice(EXTERNAL_PATH_PREFIX.length)
    if (endpointId.length === 0 || endpointId.includes("/")) {
      response.writeHead(404).end()
      return
    }

    const endpoint = endpoints.get(endpointId)
    if (!endpoint) {
      response.writeHead(404).end()
      return
    }

    // A request on a session counts as in flight until it is answered. A GET
    // is the session's long-lived event stream, which says nothing about
    // whether the client is still there; it only counts as use.
    const sessionId = request.headers["mcp-session-id"]
    if (typeof sessionId === "string") {
      const ended = endpoint.trackRequest(sessionId)
      if (request.method === "GET") ended()
      else response.once("close", ended)
    }

    const upstreamHeaders = copyHeaders(request.headers)
    delete upstreamHeaders.authorization
    upstreamHeaders["x-api-key"] = apiKey

    const upstream = http.request({
      headers: upstreamHeaders,
      host: EXTERNAL_HOST,
      method: request.method,
      path: `${INTERNAL_PATH}${requestUrl.search}`,
      port: endpoint.internalPort,
    })

    upstream.on("response", (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        copyHeaders(upstreamResponse.headers),
      )
      upstreamResponse.pipe(response)
    })
    upstream.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(502).end()
      } else {
        response.destroy()
      }
    })
    request.on("aborted", () => upstream.destroy())
    // A client that drops a long-lived stream closes only the response; its
    // request was read to the end long ago, so "aborted" never fires. Without
    // this the inner stream stays open and its session is never reclaimed.
    response.on("close", () => {
      if (!response.writableFinished) upstream.destroy()
    })
    request.pipe(upstream)
  })

  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxConnections = 128
  server.maxHeadersCount = 64
  server.maxRequestsPerSocket = 1_000
  server.requestTimeout = 30_000

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening)
        reject(error)
      }
      const onListening = () => {
        server.off("error", onError)
        resolve()
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(0, EXTERNAL_HOST)
    })
  } catch (error) {
    throw new BrokerStartupError("BROKER_BIND_FAILED", { cause: error })
  }

  const address = server.address()
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new BrokerStartupError("BROKER_BIND_FAILED")
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeIdleConnections()
        server.closeAllConnections()
      }),
  }
}

/** Where an MCP server's stderr lines go. */
export type ServerStderrSink = (endpointId: string, line: string) => void

/** Up to Maximal, on the broker's own stderr. */
const writeServerStderr: ServerStderrSink = (endpointId, line) => {
  process.stderr.write(formatServerStderr(endpointId, line))
}

export interface BrokerServerOptions {
  /** Puts a request for user input in front of the user, via Maximal.
   *  Without it, requests the client can't show are declined. */
  askMaximal?: AskMaximal
  /** Where the servers' stderr goes; the broker's own stderr by default. */
  onServerStderr?: ServerStderrSink
}

export const startBrokerServer = async (
  configuration: BrokerWireConfiguration,
  apiKey: string,
  options: BrokerServerOptions = {},
): Promise<RunningBrokerServer> => {
  if (apiKey.length < 32) {
    throw new BrokerStartupError("BROKER_AUTH_INVALID")
  }

  const endpoints = new Map<string, RunningEndpoint>()

  try {
    for (const endpointConfiguration of configuration.endpoints) {
      const endpoint = await startEndpoint(
        endpointConfiguration,
        apiKey,
        configuration.httpBodyBytes,
        options.askMaximal,
        options.onServerStderr ?? writeServerStderr,
      )
      endpoints.set(endpoint.id, endpoint)
    }

    const frontDoor = await startFrontDoor(endpoints, apiKey)
    let closed = false
    let current = configuration
    return {
      update(next) {
        if (!isLiveUpdate(current, next)) {
          throw new BrokerStartupError("RESTART_REQUIRED")
        }
        for (const settings of next.endpoints) {
          endpoints.get(settings.id)?.update(settings)
        }
        current = next
      },
      endpoints: [...endpoints.values()].map(
        (endpoint) => endpoint.observation,
      ),
      host: EXTERNAL_HOST,
      port: frontDoor.port,
      async close() {
        if (closed) {
          return
        }
        closed = true
        await frontDoor.close()
        await Promise.all(
          [...endpoints.values()].map((endpoint) => endpoint.close()),
        )
      },
    }
  } catch (error) {
    await Promise.all(
      [...endpoints.values()].map((endpoint) => endpoint.close()),
    )
    throw error
  }
}
