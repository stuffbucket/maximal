/**
 * Server tools: tools the model calls and Maximal runs itself, inside the
 * `/v1/messages` loop, instead of handing the call back to the client.
 *
 * A plugin registers one with `ctx.serverTools.register(...)` (inject
 * `serverTools`); the app core reads them through the gateway
 * (`PluginGateway.serverTools` / `callServerTool`). Runtime-free: only types
 * and constants, so the cordis-free gateway seam can import it.
 */
import type { ModelOperation, OperationResult } from "./operations"
import type { ProviderInvocation } from "./providers"
import type { JsonSchemaObject, PluginDisposer, ToolResult } from "./types"

/** Server tool name as the model sees it. The host prefixes nothing. */
export const SERVER_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

export const SERVER_TOOL_RENDERS = [
  "hidden",
  "anthropic-web-search",
  "anthropic-web-fetch",
] as const

/**
 * How the round trip appears to the client. `hidden`: not at all (the client
 * sees the text around the call, never the call or its result).
 * `anthropic-*`: as Anthropic's own server-tool blocks (`server_tool_use` and
 * a `web_*_tool_result`).
 */
export type ServerToolRender = (typeof SERVER_TOOL_RENDERS)[number]

export const SERVER_TOOL_OFFERS = ["always", "when-client-declares"] as const

/**
 * When the loop offers the tool to the model: `always` (while the plugin is
 * on and the client is allowed) or only when the client declared the matching
 * Anthropic server tool (`web_search_20250305`, ...). `when-client-declares`
 * needs an `anthropic-*` render.
 */
export type ServerToolOffer = (typeof SERVER_TOOL_OFFERS)[number]

/** Clients an `always` tool is offered to unless it says otherwise. */
export const DEFAULT_SERVER_TOOL_CLIENTS: ReadonlyArray<string> = [
  "claude-code",
]

/** The scope a call's spend is booked under. */
export interface ServerToolBudget {
  readonly plugin: string
  readonly tool: string
}

/**
 * What a call to a billed tool would ask of a model operation: the operation
 * and the request body the app core estimates its cost from (the same
 * estimate the HTTP route for that operation holds), so a tool never carries
 * a price list of its own.
 */
export interface ServerToolEstimate {
  operation: ModelOperation
  /** The provider that would bill it, so provider-scoped limits cover the hold. */
  provider?: string
  body: Record<string, unknown> | FormData
}

/**
 * What a billed call actually spent, as the tool's own model operation
 * answered it. The app core records it as usage under the operation's
 * endpoint and plugin, as it does for the same call over HTTP.
 */
export interface ServerToolSpend {
  /** Stable parent-issued logical invocation identity. */
  invocationId: string
  /** Stable provider-call identity; duplicate reports are ignored. */
  providerCallId: string
  /** Monotonic order within the invocation. */
  sequence: number
  operation: ModelOperation
  /** The model as the plugin's binding names it. */
  model: string
  /** The provider that answered. */
  provider: string
  result: Pick<OperationResult, "usage" | "cost">
}

/** What a server tool's `execute` is told about the request it runs for. */
export interface ServerToolCall {
  /** Aborts when the client goes away or the plugin is stopped. */
  signal: AbortSignal
  /** Stable parent-issued identity retained through spend acknowledgment. */
  invocationId: string
  /** Allocate the next parent-fenced provider call for this invocation. */
  nextProviderCall(operation: ModelOperation, model: string): ProviderInvocation
  /** The conversation's session id, when the client sent one. */
  sessionId?: string
  /** The conversation's model. */
  model: string
  /** Which client sent the request (`claude-code`, `claude-desktop`, ...). */
  client: string
  /**
   * Who a spend hold for this call is booked to. Set by the host
   * (`{ plugin, tool }`). The app core checks the budget limits that cover
   * that pair before it runs the tool, and answers a refusal as the tool's
   * result, so `execute` is never called for a refused call.
   */
  budget?: ServerToolBudget
  /**
   * Set by the app core. A tool that ran a billed model operation reports
   * what it spent here, once per operation, before it returns: that records
   * the usage and books the cost against the hold taken for the call. A tool
   * that is free, or whose provider reported nothing, never calls it.
   */
  reportSpend?: (spend: ServerToolSpend) => void
}

export interface ServerToolDefinition {
  /** Upstream-visible name. The host refuses a name a client tool already uses, per request. */
  name: string
  /** Part of the prompt-cache prefix: keep it fixed, with no live state in it. */
  description: string
  input_schema: JsonSchemaObject
  render: ServerToolRender
  offer: ServerToolOffer
  /** For `offer: "always"`: the clients it is offered to. Default `["claude-code"]`. */
  clients?: ReadonlyArray<string>
  /**
   * For a billed tool: the model operation this call would make and the body
   * it would send, or `undefined` when the input is not valid (the call is
   * then admitted without an estimate and `execute` refuses it). The app core
   * holds that operation's estimate against the budget limits before
   * `execute` runs; without this method a call holds nothing.
   */
  estimate?(input: Record<string, unknown>): ServerToolEstimate | undefined
  execute(
    input: Record<string, unknown>,
    call: ServerToolCall,
  ): Promise<ToolResult>
}

/** `ctx.serverTools`. Registrations are bound to the calling plugin's fiber. */
export interface ServerToolRegistry {
  /**
   * Register one server tool for the calling plugin. It vanishes when the
   * plugin stops. Throws `PluginContractError` (`invalid-server-tool` /
   * `duplicate-server-tool`; a name another plugin registered counts).
   */
  register(definition: ServerToolDefinition): PluginDisposer
}

/** A live server tool as the app core sees it (cordis-free and data-only). */
export interface ServerToolView {
  pluginId: string
  name: string
  description: string
  input_schema: JsonSchemaObject
  render: ServerToolRender
  offer: ServerToolOffer
  /** Clients an `always` tool is offered to. */
  clients: ReadonlyArray<string>
  /** Whether prepare may return a billable operation estimate. */
  billed: boolean
}

/** One input prepared by the exact leased tool implementation. */
export interface PreparedServerTool {
  readonly pluginId: string
  readonly name: string
  readonly estimate: ServerToolEstimate | undefined
  /** Execute the input captured during preparation. May be called once. */
  execute(call: ServerToolCall): Promise<ToolResult>
  /** Release the prepared implementation without executing it. Idempotent. */
  release(): void
}

declare module "./types" {
  interface AppServices {
    serverTools: ServerToolRegistry
  }
}
