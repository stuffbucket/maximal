import type {
  ElicitRequest,
  ElicitResult,
  JsonSchemaObject,
  ToolCallContext,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk"

import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type FetchLike,
  type Tool,
  type VersionNegotiationMode,
} from "@modelcontextprotocol/client"

import { abortable } from "../util"

export type UpstreamTool = Tool

/** What the MCP handshake settled on. */
export interface NegotiatedProtocol {
  /** e.g. `2026-07-28` or `2025-11-25`. */
  version: string
  /** `modern` (`server/discover`, 2026-07-28+) or `legacy` (`initialize`). */
  era: "modern" | "legacy"
}

export interface ConnectionOptions {
  endpoint: URL
  /**
   * MCP version negotiation. Default `auto`: probe with `server/discover`
   * and use the newest revision both sides support, falling back to the
   * 2025 `initialize` handshake for servers that predate it.
   */
  versionNegotiation?: VersionNegotiationMode
  /** Bearer-injecting, retrying fetch (`createUpstreamFetch`). */
  fetch: FetchLike
  clientInfo: { name: string; version: string }
  /** Per-call timeout; reset by every upstream progress notification. */
  callTimeoutMs: number
  /** Timeout for connect and `tools/list`. */
  requestTimeoutMs: number
  /** Upstream sent `notifications/tools/list_changed`. */
  onToolsChanged?(): void
}

interface InflightCall {
  elicit: ToolCallContext["elicit"]
}

type ElicitValue = string | number | boolean | Array<string>
type UpstreamElicitResult = {
  action: ElicitResult["action"]
  content?: Record<string, ElicitValue>
}

function isElicitValue(value: unknown): value is ElicitValue {
  return (
    typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    || (Array.isArray(value) && value.every((item) => typeof item === "string"))
  )
}

/** Downstream answer → upstream `ElicitResult` (MCP allows only primitive and string-array values). */
function toUpstreamElicitResult(result: ElicitResult): UpstreamElicitResult {
  if (result.action !== "accept" || !result.content)
    return { action: result.action }
  const content: Record<string, ElicitValue> = {}
  for (const [key, value] of Object.entries(result.content))
    if (isElicitValue(value)) content[key] = value
  return { action: "accept", content }
}

function toToolResult(result: CallToolResult): ToolResult {
  const structured = result.structuredContent
  const hasStructured =
    structured !== null
    && typeof structured === "object"
    && !Array.isArray(structured)
  return {
    content: result.content,
    ...(hasStructured ?
      { structuredContent: structured as Record<string, unknown> }
    : {}),
    ...(result.isError ? { isError: true } : {}),
  }
}

/**
 * One MCP client session with the Work IQ endpoint over Streamable HTTP.
 * Relays upstream progress to the calling tool and upstream elicitation to
 * a downstream caller that can elicit (declined otherwise).
 */
export class UpstreamConnection {
  readonly #options: ConnectionOptions
  readonly #client: Client
  readonly #inflight = new Set<InflightCall>()
  #transport: StreamableHTTPClientTransport | undefined
  #closed = false
  lastUsed = Date.now()

  constructor(options: ConnectionOptions) {
    this.#options = options
    this.#client = new Client(options.clientInfo, {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: options.versionNegotiation ?? "auto" },
      listChanged: {
        tools: {
          autoRefresh: false,
          onChanged: () => options.onToolsChanged?.(),
        },
      },
    })
    this.#client.setRequestHandler(
      "elicitation/create",
      async (request) => await this.#elicit(request.params),
    )
  }

  /** Calls in flight on this session. */
  get busy(): boolean {
    return this.#inflight.size > 0
  }

  get closed(): boolean {
    return this.#closed
  }

  /** The negotiated protocol, once connected. */
  get protocol(): NegotiatedProtocol | undefined {
    const version = this.#client.getNegotiatedProtocolVersion()
    const era = this.#client.getProtocolEra()
    return version && era ? { version, era } : undefined
  }

  async connect(signal?: AbortSignal): Promise<void> {
    this.#transport = new StreamableHTTPClientTransport(
      this.#options.endpoint,
      { fetch: this.#options.fetch },
    )
    await this.#client.connect(this.#transport, {
      timeout: this.#options.requestTimeoutMs,
      ...(signal ? { signal } : {}),
    })
  }

  async listTools(signal?: AbortSignal): Promise<Array<UpstreamTool>> {
    this.lastUsed = Date.now()
    const result = await this.#client.listTools(undefined, {
      cacheMode: "bypass",
      timeout: this.#options.requestTimeoutMs,
      ...(signal ? { signal } : {}),
    })
    return result.tools
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    const entry: InflightCall = { elicit: call.elicit?.bind(call) }
    this.#inflight.add(entry)
    this.lastUsed = Date.now()
    try {
      const result = await this.#client.callTool(
        { name, arguments: args },
        {
          signal: call.signal,
          timeout: this.#options.callTimeoutMs,
          resetTimeoutOnProgress: true,
          onprogress: (update) => {
            call.progress?.({
              progress: update.progress,
              ...(update.total === undefined ? {} : { total: update.total }),
              ...(update.message === undefined ?
                {}
              : { message: update.message }),
            })
          },
        },
      )
      return toToolResult(result)
    } finally {
      this.#inflight.delete(entry)
      this.lastUsed = Date.now()
    }
  }

  /**
   * Upstream asked for user input. MCP gives the client no link from a
   * server request back to the call that caused it, so the oldest in-flight
   * call on this session that can elicit answers it; sessions are per
   * downstream client, so that reaches the right user.
   */
  async #elicit(params: {
    mode?: string
    message: string
    requestedSchema?: unknown
  }): Promise<UpstreamElicitResult> {
    if (params.mode === "url") return { action: "decline" }
    const target = [...this.#inflight].find((entry) => entry.elicit)
    if (!target?.elicit) return { action: "decline" }
    const request: ElicitRequest = {
      message: params.message,
      requestedSchema: (params.requestedSchema ?? {
        type: "object",
        properties: {},
      }) as JsonSchemaObject,
    }
    return toUpstreamElicitResult(await target.elicit(request))
  }

  /** Best effort: end the upstream session (`DELETE`) and close the client. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      await abortable(
        this.#transport?.terminateSession() ?? Promise.resolve(),
        AbortSignal.timeout(2000),
      )
    } catch {
      // The session may already be gone upstream.
    }
    try {
      await this.#client.close()
    } catch {
      // Closing a half-open client is fine.
    }
  }
}
