/**
 * Server tools: tools the model calls and Maximal runs itself, inside the
 * `/v1/messages` loop, instead of handing the call back to the client.
 *
 * A plugin registers one with `ctx.serverTools.register(...)` (inject
 * `serverTools`); the app core reads them through the gateway
 * (`PluginGateway.serverTools` / `callServerTool`). Runtime-free: only types
 * and constants, so the cordis-free gateway seam can import it.
 */
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

/** What a server tool's `execute` is told about the request it runs for. */
export interface ServerToolCall {
  /** Aborts when the client goes away or the plugin is stopped. */
  signal: AbortSignal
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

/** A live server tool as the app core sees it (cordis-free). */
export interface ServerToolView {
  pluginId: string
  name: string
  description: string
  input_schema: JsonSchemaObject
  render: ServerToolRender
  offer: ServerToolOffer
  /** Clients an `always` tool is offered to. */
  clients: ReadonlyArray<string>
}

declare module "./types" {
  interface AppServices {
    serverTools: ServerToolRegistry
  }
}
