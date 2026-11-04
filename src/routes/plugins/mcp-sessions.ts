/**
 * MCP sessions for `/mcp/<pluginId>`: one low-level MCP `Server` and
 * Streamable HTTP transport per session, answering from the plugin gateway.
 *
 * The low-level `Server` (rather than `McpServer`) is deliberate: the tool
 * set is the gateway's, changes at runtime, and carries raw JSON Schemas;
 * `tools/list_changed` is sent here, debounced. Sessions speak the 2025
 * protocol era (initialize-negotiated, server-to-client requests), the one
 * Claude Code uses, so elicitation is the push-style `elicitInput`.
 */

import {
  type CallToolRequest,
  type CallToolResult,
  type ElicitRequestFormParams,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type ServerContext,
  type Tool,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server"
import {
  isPluginGatewayError,
  type PluginGateway,
  type PluginGatewayEvent,
  type ToolCallContext,
  type ToolDefinitionPublic,
} from "@stuffbucket/maximal-plugin-sdk/gateway"
import consola from "consola"
import { randomUUID } from "node:crypto"

import { BUILD_VERSION } from "~/lib/update/build-info"

// eslint-disable-next-line @typescript-eslint/no-deprecated -- see the module comment
type LowLevelServer = Server

const MAX_BODY_BYTES = 1024 * 1024
/** How long a tool may wait for the user to answer an elicitation. */
const ELICIT_TIMEOUT_MS = 10 * 60_000

export interface McpSessionOptions {
  getGateway: () => PluginGateway | undefined
  /** Close a session with no open request or stream after this long. */
  idleTimeoutMs: number
  /** Most sessions at once, across plugins; the oldest idle one makes room. */
  maxSessions: number
  listChangedDelayMs: number
}

interface Session {
  id: string | undefined
  readonly pluginId: string
  readonly server: LowLevelServer
  readonly transport: WebStandardStreamableHTTPServerTransport
  lastSeen: number
  /** Requests (and open SSE streams) not finished yet. */
  inflight: number
  closed: boolean
}

function toMcpTool(tool: ToolDefinitionPublic): Tool {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    ...(tool.outputSchema === undefined ?
      {}
    : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined ?
      {}
    : { annotations: tool.annotations }),
  }
}

/** A tool result telling the model why the plugin can't run it now. */
function notReady(displayName: string, reason: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${displayName} isn't ready in Maximal: ${reason}`,
      },
    ],
  }
}

/** Pass a body through, calling `settled` once it ends, errors, or the
 *  client cancels it. */
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

/** Progress and elicitation for one `tools/call`, wired to the session. */
function callContext(
  session: Session,
  request: CallToolRequest,
  ctx: ServerContext,
): ToolCallContext {
  const signal = ctx.mcpReq.signal
  const call: ToolCallContext = {
    signal,
    ...(session.id === undefined ? {} : { sessionId: session.id }),
  }
  const progressToken = request.params._meta?.progressToken
  if (progressToken !== undefined) {
    call.progress = ({ progress, total, message }) => {
      ctx.mcpReq
        .notify({
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            ...(total === undefined ? {} : { total }),
            ...(message === undefined ? {} : { message }),
          },
        })
        .catch(() => undefined)
    }
  }
  // 2025-era session: capabilities come from `initialize`.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the module comment
  if (session.server.getClientCapabilities()?.elicitation !== undefined) {
    call.elicit = async ({ message, requestedSchema }) => {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the module comment
      const answer = await ctx.mcpReq.elicitInput(
        {
          message,
          requestedSchema:
            requestedSchema as ElicitRequestFormParams["requestedSchema"],
        },
        { signal, timeout: ELICIT_TIMEOUT_MS },
      )
      return {
        action: answer.action,
        ...(answer.content === undefined ? {} : { content: answer.content }),
      }
    }
  }
  return call
}

export class McpSessions {
  /** Initialized sessions by MCP session id. */
  readonly #sessions = new Map<string, Session>()
  /** Sessions still in their `initialize` request. */
  readonly #opening = new Set<Session>()
  readonly #listChangedTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #options: McpSessionOptions
  #watched: { gateway: PluginGateway; unsubscribe: () => void } | undefined
  #sweeper: ReturnType<typeof setInterval> | undefined

  constructor(options: McpSessionOptions) {
    this.#options = options
  }

  get(id: string, pluginId: string): Session | undefined {
    const session = this.#sessions.get(id)
    return session && session.pluginId === pluginId && !session.closed ?
        session
      : undefined
  }

  count(pluginId?: string): number {
    return pluginId === undefined ?
        this.#sessions.size
      : this.#forPlugin(pluginId).length
  }

  /** Follow the gateway's events (plugin off ⇒ close its sessions; tools
   *  changed ⇒ `list_changed`). Re-subscribes when the gateway changes. */
  watch(gateway: PluginGateway): void {
    if (this.#watched?.gateway === gateway) return
    this.#watched?.unsubscribe()
    this.#watched = {
      gateway,
      unsubscribe: gateway.subscribe((event) => {
        this.#onGatewayEvent(gateway, event)
      }),
    }
  }

  /** Make room for one more session: false when every one is busy. */
  makeRoom(): boolean {
    if (this.#sessions.size + this.#opening.size < this.#options.maxSessions) {
      return true
    }
    const idle = [...this.#sessions.values()]
      .filter((session) => session.inflight === 0)
      .sort((a, b) => a.lastSeen - b.lastSeen)
      .at(0)
    if (!idle) return false
    void this.close(idle)
    return true
  }

  /** Open a session for an `initialize` request. If the request turns out
   *  not to initialize, the caller closes it again. */
  async open(pluginId: string): Promise<Session> {
    const session: Session = {
      id: undefined,
      pluginId,
      server: this.#createServer(pluginId),
      transport: new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.#initialized(session, id)
        },
        onsessionclosed: () => this.close(session),
        maxRequestBodySize: MAX_BODY_BYTES,
      }),
      lastSeen: Date.now(),
      inflight: 0,
      closed: false,
    }
    session.server.setRequestHandler("tools/call", (request, ctx) =>
      this.#callTool(session, request, ctx),
    )
    this.#opening.add(session)
    await session.server.connect(session.transport)
    return session
  }

  /** Hand one HTTP request to the session's transport, tracking it until
   *  its response body (possibly a long SSE stream) is done. */
  async serve(session: Session, request: Request): Promise<Response> {
    session.lastSeen = Date.now()
    session.inflight += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      session.inflight -= 1
      session.lastSeen = Date.now()
    }
    let response: Response
    try {
      response = await session.transport.handleRequest(request)
    } catch (error) {
      release()
      throw error
    }
    if (!response.body) {
      release()
      return response
    }
    return new Response(releaseWhenSettled(response.body, release), {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    })
  }

  async close(session: Session): Promise<void> {
    if (session.closed) return
    session.closed = true
    this.#opening.delete(session)
    if (session.id !== undefined) this.#sessions.delete(session.id)
    if (this.#sessions.size === 0 && this.#sweeper) {
      clearInterval(this.#sweeper)
      this.#sweeper = undefined
    }
    await session.server.close().catch(() => undefined)
  }

  async closeAll(): Promise<void> {
    const all = [...this.#sessions.values(), ...this.#opening]
    await Promise.all(all.map((session) => this.close(session)))
    for (const timer of this.#listChangedTimers.values()) clearTimeout(timer)
    this.#listChangedTimers.clear()
    this.#watched?.unsubscribe()
    this.#watched = undefined
  }

  #createServer(pluginId: string): LowLevelServer {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the module comment
    const server = new Server(
      { name: pluginId, version: BUILD_VERSION },
      { capabilities: { tools: { listChanged: true } } },
    )
    server.setRequestHandler("tools/list", () => {
      const gateway = this.#options.getGateway()
      const tools = gateway?.get(pluginId) ? gateway.listTools(pluginId) : []
      return { tools: tools.map((tool) => toMcpTool(tool)) }
    })
    return server
  }

  #initialized(session: Session, id: string): void {
    session.id = id
    this.#opening.delete(session)
    this.#sessions.set(id, session)
    const { idleTimeoutMs } = this.#options
    this.#sweeper ??= setInterval(
      () => {
        this.#sweepIdle()
      },
      Math.min(60_000, Math.max(1_000, idleTimeoutMs / 2)),
    )
    this.#sweeper.unref()
  }

  async #callTool(
    session: Session,
    request: CallToolRequest,
    ctx: ServerContext,
  ): Promise<CallToolResult> {
    const { pluginId } = session
    const gateway = this.#options.getGateway()
    if (!gateway) return notReady(pluginId, "Maximal is stopping.")
    const { name } = request.params
    let result
    try {
      result = await gateway.callTool(
        pluginId,
        name,
        request.params.arguments ?? {},
        callContext(session, request, ctx),
      )
    } catch (error) {
      if (!isPluginGatewayError(error)) throw error
      if (error.code === "unknown-tool") {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message)
      }
      const snapshot = gateway.get(pluginId)
      return notReady(
        snapshot?.displayName ?? pluginId,
        snapshot?.status?.summary ?? snapshot?.error ?? error.message,
      )
    }
    const advertised = gateway
      .listTools(pluginId)
      .find((tool) => tool.name === name)?.outputSchema
    return session.server.projectCallToolResult(
      result as CallToolResult,
      advertised,
    )
  }

  #forPlugin(pluginId: string): Array<Session> {
    return [...this.#sessions.values()].filter(
      (session) => session.pluginId === pluginId,
    )
  }

  #onGatewayEvent(gateway: PluginGateway, event: PluginGatewayEvent): void {
    if (event.type === "status") return
    const sessions = this.#forPlugin(event.pluginId)
    if (sessions.length === 0) return
    if (gateway.get(event.pluginId)?.enabled !== true) {
      for (const session of sessions) void this.close(session)
      return
    }
    this.#scheduleListChanged(event.pluginId)
  }

  #scheduleListChanged(pluginId: string): void {
    if (this.#listChangedTimers.has(pluginId)) return
    const timer = setTimeout(() => {
      this.#listChangedTimers.delete(pluginId)
      for (const session of this.#forPlugin(pluginId)) {
        session.server.sendToolListChanged().catch((error: unknown) => {
          consola.debug(`MCP ${pluginId}: list_changed not delivered`, error)
        })
      }
    }, this.#options.listChangedDelayMs)
    timer.unref()
    this.#listChangedTimers.set(pluginId, timer)
  }

  #sweepIdle(): void {
    const cutoff = Date.now() - this.#options.idleTimeoutMs
    for (const session of this.#sessions.values()) {
      if (session.inflight === 0 && session.lastSeen < cutoff) {
        void this.close(session)
      }
    }
  }
}
