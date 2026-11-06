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
  blockedToolText,
  isPluginGatewayError,
  type PluginGateway,
  type PluginGatewayError,
  type PluginGatewayEvent,
  type PluginToolListing,
  type ToolCallContext,
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

/**
 * A tool as MCP clients see it. Blocked tools stay listed, saying they are
 * turned off and where to turn them on; `ask` tools require Claude Code's
 * own prompt on every call (`anthropic/requiresUserInteraction`, which
 * other clients ignore: Maximal asks them itself, see `#approve`).
 */
function toMcpTool(tool: PluginToolListing, connector: string): Tool {
  const description =
    tool.permission === "block" ?
      `${blockedToolText(connector, tool.name)}\n\n${tool.description}`
    : tool.description
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    ...(tool.outputSchema === undefined ?
      {}
    : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined ?
      {}
    : { annotations: tool.annotations }),
    ...(tool.permission === "ask" ?
      { _meta: { [REQUIRES_USER_INTERACTION]: true } }
    : {}),
  }
}

/** Claude Code shows its permission prompt on every call of a tool marked so. */
const REQUIRES_USER_INTERACTION = "anthropic/requiresUserInteraction"

/** The client that honours `REQUIRES_USER_INTERACTION` (MCP `clientInfo.name`). */
const CLAUDE_CODE_CLIENT = "claude-code"

/** A short, single-line view of a call's arguments for Maximal's question. */
function argumentsSummary(args: Record<string, unknown>): string {
  const text = JSON.stringify(args)
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}

function textResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] }
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

/**
 * The answer to a call the gateway refused. An unknown tool is a protocol
 * error — unless the connector isn't ready (signed out, not entitled): then
 * it is a tool the client remembers from before, and the result says why.
 */
function refusal(
  gateway: PluginGateway,
  pluginId: string,
  error: PluginGatewayError,
): CallToolResult {
  const snapshot = gateway.get(pluginId)
  const settingUp =
    snapshot?.status !== undefined && snapshot.status.state !== "ready"
  if (error.code === "unknown-tool" && !settingUp) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message)
  }
  return notReady(
    snapshot?.displayName ?? pluginId,
    snapshot?.status?.summary ?? snapshot?.error ?? error.message,
  )
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
    try {
      await session.server.connect(session.transport)
    } catch (error) {
      await this.close(session)
      throw error
    }
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
      const plugin = gateway?.get(pluginId)
      const tools = plugin && gateway ? gateway.listTools(pluginId) : []
      const connector = plugin?.displayName ?? pluginId
      return { tools: tools.map((tool) => toMcpTool(tool, connector)) }
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
    const args = request.params.arguments ?? {}
    const call = callContext(session, request, ctx)
    const listing = gateway
      .listTools(pluginId)
      .find((tool) => tool.name === name)
    if (listing?.permission === "ask") {
      const connector = gateway.get(pluginId)?.displayName ?? pluginId
      const decision = await this.#approve(session, ctx, {
        connector,
        tool: name,
        args,
      })
      if (decision.refused) return decision.refused
      if (decision.approved) call.approved = true
    }
    let result
    try {
      result = await gateway.callTool(pluginId, name, args, call)
    } catch (error) {
      if (!isPluginGatewayError(error)) throw error
      return refusal(gateway, pluginId, error)
    }
    const advertised = gateway
      .listTools(pluginId)
      .find((tool) => tool.name === name)?.outputSchema
    return session.server.projectCallToolResult(
      result as CallToolResult,
      advertised,
    )
  }

  /**
   * A person's approval for one call of an `ask` tool: Claude Code's own
   * prompt (required by `REQUIRES_USER_INTERACTION`; where nobody can answer
   * it, Claude Code refuses the call itself), else Maximal's question through
   * MCP elicitation, with no fields so clients show Allow / Deny. A client
   * that can do neither gets no approval, and the host refuses the call.
   */
  async #approve(
    session: Session,
    ctx: ServerContext,
    ask: { connector: string; tool: string; args: Record<string, unknown> },
  ): Promise<{ approved: boolean; refused?: CallToolResult }> {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the module comment
    const client = session.server.getClientVersion()?.name
    if (client === CLAUDE_CODE_CLIENT) return { approved: true }
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the module comment
    if (session.server.getClientCapabilities()?.elicitation === undefined)
      return { approved: false }
    const { connector, tool } = ask
    let action: string
    try {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the module comment
      const answer = await ctx.mcpReq.elicitInput(
        {
          message: `Maximal: allow ${connector} to run ${tool}?\n${argumentsSummary(ask.args)}`,
          requestedSchema: { type: "object", properties: {} },
        },
        { signal: ctx.mcpReq.signal, timeout: ELICIT_TIMEOUT_MS },
      )
      action = answer.action
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        approved: false,
        refused: textResult(
          `Maximal couldn't get your approval for ${connector}'s ${tool} tool (${reason}), so it wasn't run.`,
        ),
      }
    }
    if (action === "accept") return { approved: true }
    return {
      approved: false,
      refused: textResult(
        action === "decline" ?
          `You declined ${connector}'s ${tool} call, so it wasn't run.`
        : `${connector}'s ${tool} call was cancelled, so it wasn't run.`,
      ),
    }
  }

  #forPlugin(pluginId: string): Array<Session> {
    return [...this.#sessions.values()].filter(
      (session) => session.pluginId === pluginId,
    )
  }

  #onGatewayEvent(gateway: PluginGateway, event: PluginGatewayEvent): void {
    // `tools` covers registrations and permission changes; `settings` and
    // `status` never change the MCP-visible list on their own (a config
    // change reloads the plugin, which arrives as `lifecycle`).
    if (event.type !== "tools" && event.type !== "lifecycle") return
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
