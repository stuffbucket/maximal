/**
 * What the `/v1/messages` loop needs to know about a server tool, whoever
 * provides it (the built-in web tools, or a plugin through the gateway).
 *
 * The loop works on these, not on the plugin SDK's definitions: a listing
 * already knows how to run itself for one request (per-request state such as
 * `max_uses` lives in its closure) and how the result looks to the model and
 * to the client.
 */

import type {
  JsonSchemaObject,
  ServerToolOffer,
  ServerToolRender,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import type {
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "~/lib/models/anthropic-types"

/** A block the client sees after a server tool ran (`web_*_tool_result`). */
export interface ServerToolClientBlock {
  type: string
  tool_use_id: string
  content: unknown
}

/** One finished server tool call. */
export interface ServerToolRun {
  /** What the model reads on the next turn. */
  toolResult: AnthropicToolResultBlock
  /** What the client sees for the call: the result block of an
   *  `anthropic-*` render. Absent for `hidden` (the client sees nothing). */
  clientBlock?: ServerToolClientBlock
  ok: boolean
  /** Failure code, for logs. */
  code?: string
}

/** What a listing is told about the request when it runs. */
export interface ServerToolRunCall {
  signal: AbortSignal
  sessionId?: string
  model: string
  client: string
}

/** A server tool one provider can offer. */
export interface ServerToolListing {
  /** Plugin id, or `maximal` for the built-in web tools. */
  owner: string
  name: string
  description: string
  input_schema: JsonSchemaObject
  render: ServerToolRender
  offer: ServerToolOffer
  /** For `offer: "always"`: the clients it is offered to. */
  clients: ReadonlyArray<string>
  /** Run one call. Never throws for a tool failure: that is a `ServerToolRun`
   *  with `ok: false`. */
  run(
    toolUse: AnthropicToolUseBlock,
    call: ServerToolRunCall,
  ): Promise<ServerToolRun>
}

/** A server tool the plan offers on this request, bound to it. */
export interface PlannedServerTool {
  name: string
  owner: string
  render: ServerToolRender
  /** The client never sees the call or its result. */
  hidden: boolean
  run(toolUse: AnthropicToolUseBlock): Promise<ServerToolRun>
}

/** The server tools one request offers the model. */
export interface ServerToolPlan {
  tools: ReadonlyMap<string, PlannedServerTool>
  /** The tool declarations to add to `payload.tools`, sorted by name. */
  declarations: ReadonlyArray<ServerToolDeclaration>
  /** An `always` tool is among them, so the request goes through the loop
   *  whether or not the model calls anything. */
  offersAlways: boolean
}

/** How a server tool appears in the upstream `tools` array. */
export interface ServerToolDeclaration {
  name: string
  description: string
  input_schema: JsonSchemaObject
}
