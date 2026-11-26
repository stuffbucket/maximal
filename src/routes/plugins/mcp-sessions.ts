/**
 * MCP sessions for `/mcp` and `/mcp/<pluginId>`: one low-level MCP `Server`
 * and Streamable HTTP transport per session, answering from the plugin gateway.
 * The root endpoint aggregates every enabled connector and namespaces its tools
 * as `<pluginId>__<toolName>`; a connector endpoint keeps its native names.
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
  type PluginGenerationLease,
  type PluginGatewayEvent,
  type PluginToolListing,
  type ToolCallContext,
  type ToolPermission,
} from "@stuffbucket/maximal-plugin-sdk/gateway"
import consola from "consola"
import { randomUUID } from "node:crypto"

import { getConfig } from "~/lib/config/config"
import {
  PLUGIN_UNIDENTIFIED_ACCESS_ID,
  pluginAppAccessId,
} from "~/lib/plugins/access"
import { subscribePluginAccessChanges } from "~/lib/plugins/access-events"
import {
  type AffinedGenerationCall,
  GenerationAffinityCoordinator,
  type GenerationAffinityDiagnostics,
} from "~/lib/plugins/generation-affinity"
import { pluginAccessPermission } from "~/lib/plugins/settings"
import { connectorActivityFor } from "~/lib/token-usage/connector-activity"
import { BUILD_VERSION } from "~/lib/update/build-info"

// eslint-disable-next-line @typescript-eslint/no-deprecated -- see the module comment
type LowLevelServer = Server

const MAX_BODY_BYTES = 1024 * 1024
/** How long a tool may wait for the user to answer an elicitation. */
const ELICIT_TIMEOUT_MS = 10 * 60_000
const AGGREGATE_SERVER_NAME = "maximal"
const AGGREGATE_TOOL_SEPARATOR = "__"

function aggregateToolName(pluginId: string, toolName: string): string {
  return `${pluginId}${AGGREGATE_TOOL_SEPARATOR}${toolName}`
}

function parseAggregateToolName(
  name: string,
): { pluginId: string; toolName: string } | undefined {
  const separator = name.indexOf(AGGREGATE_TOOL_SEPARATOR)
  if (separator <= 0) return undefined
  const pluginId = name.slice(0, separator)
  const toolName = name.slice(separator + AGGREGATE_TOOL_SEPARATOR.length)
  return toolName.length === 0 ? undefined : { pluginId, toolName }
}

export interface McpSessionOptions {
  getGateway: () => PluginGateway | undefined
  /** Close a session with no open request or stream after this long. */
  idleTimeoutMs: number
  /** Most sessions at once, across plugins; the oldest idle one makes room. */
  maxSessions: number
  listChangedDelayMs: number
  /** Parent/runner seam: release this generation's upstream MCP session. */
  releaseUpstreamSession: (
    generationId: string,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<void>
}

export interface McpCaller {
  /** Stable `app:<id>` or `connection:<id>` access target. */
  accessId: string | undefined
  /** Product or user-defined connection name for refusal text. */
  name: string | undefined
}

interface Session {
  id: string | undefined
  /** One connector, or undefined for the aggregate `/mcp` endpoint. */
  readonly pluginId: string | undefined
  readonly caller: McpCaller
  readonly server: LowLevelServer
  readonly transport: WebStandardStreamableHTTPServerTransport
  lastSeen: number
  /** Requests (and open SSE streams) not finished yet. */
  inflight: number
  closed: boolean
  /** Tools the last `tools/list` marked `REQUIRES_USER_INTERACTION`: the
   *  only calls Claude Code's own prompt is known to cover. */
  promptedTools: ReadonlySet<string> | undefined
}

/**
 * A tool as MCP clients see it. Blocked tools stay listed, saying they are
 * turned off and where to turn them on; `ask` tools require Claude Code's
 * own prompt on every call (`anthropic/requiresUserInteraction`, which
 * other clients ignore: Maximal asks them itself, see `#approve`).
 */
function toMcpTool(
  tool: PluginToolListing,
  connector: string,
  accessPermission: ToolPermission,
): Tool {
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
    ...(tool.permission === "ask" || accessPermission === "ask" ?
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

function accessBlocked(displayName: string, caller: McpCaller): CallToolResult {
  if (caller.accessId === PLUGIN_UNIDENTIFIED_ACCESS_ID) {
    return textResult(
      `${displayName} is blocked in Maximal for this API key because Maximal doesn't recognize it (it may be turned off or deleted). Use a key from Maximal's Settings.`,
    )
  }
  const target = caller.name ? ` for ${caller.name}` : " for this connection"
  return textResult(
    `${displayName} is blocked${target} in Maximal. Change App Permissions in Settings to use it.`,
  )
}

function accessAskUnanswered(
  displayName: string,
  callerName: string | undefined,
): CallToolResult {
  const target = callerName ? ` for ${callerName}` : " for this connection"
  return textResult(
    `${displayName} asks before it runs${target} in Maximal, and this client can't show the question, so it wasn't run. Change App Permissions in Settings to allow it.`,
  )
}

/**
 * The answer to a call the gateway refused. An unknown tool is a protocol
 * error — unless the connector isn't ready (signed out, not entitled): then
 * it is a tool the client remembers from before, and the result says why.
 */
function refusal(
  gateway: Pick<PluginGenerationLease, "get">,
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
  readonly #affinity: GenerationAffinityCoordinator
  #unsubscribeAccess: (() => void) | undefined
  #watched: { gateway: PluginGateway; unsubscribe: () => void } | undefined
  #sweeper: ReturnType<typeof setInterval> | undefined

  constructor(options: McpSessionOptions) {
    this.#options = options
    this.#affinity = new GenerationAffinityCoordinator({
      acquireGeneration: () => {
        const gateway = options.getGateway()
        if (!gateway) throw new Error("Plugin gateway is unavailable.")
        return gateway.acquireGeneration()
      },
      releaseUpstreamSession: options.releaseUpstreamSession,
      closeDownstream: (sessionId) => {
        const session = this.#sessions.get(sessionId)
        return session ? this.close(session) : Promise.resolve()
      },
      onMigrated: (sessionId) => {
        const session = this.#sessions.get(sessionId)
        if (session) this.#scheduleListChanged(session)
      },
    })
  }

  /** Supervisor seam: the gateway pointer has atomically moved to this generation. */
  cutoverGeneration(generationId: string, drainDeadline: number): void {
    this.#affinity.cutover(generationId, drainDeadline)
  }

  affinityDiagnostics(): GenerationAffinityDiagnostics {
    return this.#affinity.diagnostics()
  }

  get(
    id: string,
    pluginId: string | undefined,
    accessId: string | undefined,
  ): Session | undefined {
    const session = this.#sessions.get(id)
    return (
        session
          && session.pluginId === pluginId
          && session.caller.accessId === accessId
          && !session.closed
      ) ?
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
    // App Permission changes (Settings) re-list tools; `closeAll` drops this
    // and the next request brings it back, like the gateway subscription.
    this.#unsubscribeAccess ??= subscribePluginAccessChanges((pluginId) => {
      for (const session of [
        ...this.#forPlugin(pluginId),
        ...this.#aggregateSessions(),
      ]) {
        this.#scheduleListChanged(session)
      }
    })
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
  async open(
    pluginId: string | undefined,
    caller: McpCaller,
  ): Promise<Session> {
    const session: Session = {
      id: undefined,
      pluginId,
      caller,
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
      promptedTools: undefined,
    }
    session.server.setRequestHandler("tools/list", () =>
      this.#listTools(session),
    )
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
    if (session.id !== undefined) {
      this.#sessions.delete(session.id)
      const timer = this.#listChangedTimers.get(session.id)
      if (timer) clearTimeout(timer)
      this.#listChangedTimers.delete(session.id)
    }
    if (this.#sessions.size === 0 && this.#sweeper) {
      clearInterval(this.#sweeper)
      this.#sweeper = undefined
    }
    if (session.id !== undefined) {
      await this.#affinity.closeSession(session.id)
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
    this.#unsubscribeAccess?.()
    this.#unsubscribeAccess = undefined
    await this.#affinity.closeAll()
  }

  #createServer(pluginId: string | undefined): LowLevelServer {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the module comment
    const server = new Server(
      { name: pluginId ?? AGGREGATE_SERVER_NAME, version: BUILD_VERSION },
      { capabilities: { tools: { listChanged: true } } },
    )
    return server
  }

  #accessPermission(session: Session, pluginId: string): ToolPermission {
    return pluginAccessPermission(
      getConfig(),
      pluginId,
      session.caller.accessId,
    )
  }

  #aggregatePluginIds(generation: PluginGenerationLease): Array<string> {
    return generation
      .list()
      .map((plugin) => plugin.id)
      .filter((pluginId) => {
        const plugin = generation.get(pluginId)
        return plugin?.kind === "connector" && plugin.enabled
      })
      .sort((a, b) => a.localeCompare(b, "en"))
  }

  #listedToolsFor(
    generation: PluginGenerationLease,
    session: Session,
    pluginId: string,
  ): Array<Tool> {
    const accessPermission = this.#accessPermission(session, pluginId)
    if (accessPermission === "block") return []
    const plugin = generation.get(pluginId)
    const connector = plugin?.displayName ?? pluginId
    let tools: Array<PluginToolListing>
    try {
      tools = generation.listTools(pluginId)
    } catch (error) {
      // One connector racing a reload must not blank the aggregate catalog.
      if (isPluginGatewayError(error)) return []
      throw error
    }
    return tools.map((tool) => {
      const listed = toMcpTool(tool, connector, accessPermission)
      return session.pluginId === undefined ?
          { ...listed, name: aggregateToolName(pluginId, listed.name) }
        : listed
    })
  }

  async #listTools(session: Session): Promise<{ tools: Array<Tool> }> {
    if (session.id === undefined) return { tools: [] }
    let call: AffinedGenerationCall | undefined
    try {
      call = await this.#affinity.acquire(session.id)
      const generation = call.generation
      const pluginIds =
        session.pluginId === undefined ?
          this.#aggregatePluginIds(generation)
        : [session.pluginId]
      const listed = pluginIds.flatMap((pluginId) =>
        this.#listedToolsFor(generation, session, pluginId),
      )
      session.promptedTools = new Set(
        listed
          .filter((tool) => tool._meta?.[REQUIRES_USER_INTERACTION] === true)
          .map((tool) => tool.name),
      )
      return { tools: listed }
    } catch (error) {
      // A lifecycle/cutover race is a temporarily empty catalog, not a server
      // crash or an escaping PluginGatewayError.
      if (isPluginGatewayError(error)) return { tools: [] }
      throw error
    } finally {
      call?.release()
    }
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

  #toolTarget(
    generation: PluginGenerationLease,
    session: Session,
    publicTool: string,
  ): { pluginId: string; toolName: string } {
    const target =
      session.pluginId === undefined ?
        parseAggregateToolName(publicTool)
      : { pluginId: session.pluginId, toolName: publicTool }
    if (
      !target
      || (session.pluginId === undefined
        && generation.get(target.pluginId)?.kind !== "connector")
    ) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Unknown tool "${publicTool}".`,
      )
    }
    return target
  }

  async #callTool(
    session: Session,
    request: CallToolRequest,
    ctx: ServerContext,
  ): Promise<CallToolResult> {
    const gateway = this.#options.getGateway()
    const endpointName = session.pluginId ?? AGGREGATE_SERVER_NAME
    if (!gateway || session.id === undefined)
      return notReady(endpointName, "Maximal is stopping.")
    const affined = await this.#affinity.acquire(session.id)
    const generation = affined.generation
    try {
      const publicTool = request.params.name
      const { pluginId, toolName } = this.#toolTarget(
        generation,
        session,
        publicTool,
      )
      const args = request.params.arguments ?? {}
      const call = callContext(session, request, ctx)
      const connector = generation.get(pluginId)?.displayName ?? pluginId
      const accessPermission = this.#accessPermission(session, pluginId)
      if (accessPermission === "block") {
        return accessBlocked(connector, session.caller)
      }
      const listing = generation
        .listTools(pluginId)
        .find((tool) => tool.name === toolName)
      const gated = await this.#gate(session, ctx, {
        connector,
        tool: toolName,
        publicTool,
        args,
        accessPermission,
        toolPermission: listing?.permission,
      })
      if (gated.refused) return gated.refused
      if (gated.approved) call.approved = true
      // Only the connector and tool name are recorded for the Sessions view,
      // and only while the call runs (not while it waits for approval).
      const gateway = this.#options.getGateway()
      const endActivity =
        gateway ?
          connectorActivityFor(gateway).begin(pluginId, toolName)
        : () => {}
      let result
      let ran = true
      try {
        result = await generation.callTool(pluginId, toolName, args, call)
      } catch (error) {
        if (!isPluginGatewayError(error)) throw error
        // The gateway refused it (turned off, not ready): nothing ran.
        ran = false
        return refusal(generation, pluginId, error)
      } finally {
        endActivity(ran)
      }
      const advertised = generation
        .listTools(pluginId)
        .find((tool) => tool.name === toolName)?.outputSchema
      return session.server.projectCallToolResult(
        result as CallToolResult,
        advertised,
      )
    } finally {
      affined.release()
    }
  }

  /**
   * Asks the person when the tool (or the caller's App Permission) says to.
   * A refusal to return, else whether they approved (the call then carries
   * `approved`).
   */
  async #gate(
    session: Session,
    ctx: ServerContext,
    ask: {
      connector: string
      tool: string
      publicTool: string
      args: Record<string, unknown>
      accessPermission: ToolPermission
      toolPermission: ToolPermission | undefined
    },
  ): Promise<{ approved: boolean; refused?: CallToolResult }> {
    // A blocked tool is refused by the gateway; nobody is asked about it.
    const askedByApp =
      ask.accessPermission === "ask" && ask.toolPermission !== "block"
    if (ask.toolPermission !== "ask" && !askedByApp) return { approved: false }
    const decision = await this.#approve(session, ctx, ask)
    // The gateway only insists on approval for a tool that asks itself, so
    // an app-level Ask the client can't answer is refused here.
    if (!decision.approved && !decision.refused && askedByApp) {
      return {
        approved: false,
        refused: accessAskUnanswered(ask.connector, session.caller.name),
      }
    }
    return decision
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
    ask: {
      connector: string
      tool: string
      publicTool: string
      args: Record<string, unknown>
    },
  ): Promise<{ approved: boolean; refused?: CallToolResult }> {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the module comment
    const client = session.server.getClientVersion()?.name
    // Claude Code's prompt counts only for the Claude Code app (the name is
    // client-asserted) and only for a tool its last list marked: after a
    // policy change, until it re-lists, nobody has been asked.
    if (
      client === CLAUDE_CODE_CLIENT
      && session.caller.accessId === pluginAppAccessId("claude-code")
      && session.promptedTools?.has(ask.publicTool) === true
    ) {
      return { approved: true }
    }
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

  #aggregateSessions(): Array<Session> {
    return [...this.#sessions.values()].filter(
      (session) => session.pluginId === undefined,
    )
  }

  #onGatewayEvent(gateway: PluginGateway, event: PluginGatewayEvent): void {
    // `tools` covers registrations and permission changes; `settings` and
    // `status` never change the MCP-visible list on their own (a config
    // change reloads the plugin, which arrives as `lifecycle`).
    if (event.type !== "tools" && event.type !== "lifecycle") return
    const direct = this.#forPlugin(event.pluginId)
    if (gateway.get(event.pluginId)?.enabled !== true) {
      for (const session of direct) void this.close(session)
    } else {
      for (const session of direct) this.#scheduleListChanged(session)
    }
    // The aggregate survives one connector stopping; its catalog just loses
    // that connector's namespaced tools.
    for (const session of this.#aggregateSessions()) {
      this.#scheduleListChanged(session)
    }
  }

  #scheduleListChanged(session: Session): void {
    if (session.id === undefined || this.#listChangedTimers.has(session.id))
      return
    const { id } = session
    const target = session.pluginId ?? AGGREGATE_SERVER_NAME
    const timer = setTimeout(() => {
      this.#listChangedTimers.delete(id)
      if (session.closed) return
      session.server.sendToolListChanged().catch((error: unknown) => {
        consola.debug(`MCP ${target}: list_changed not delivered`, error)
      })
    }, this.#options.listChangedDelayMs)
    timer.unref()
    this.#listChangedTimers.set(id, timer)
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
