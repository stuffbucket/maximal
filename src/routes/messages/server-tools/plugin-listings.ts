/**
 * Plugin-provided server tools, read through the plugin gateway.
 */

import type {
  PluginGateway,
  ServerToolView,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import type { AnthropicToolUseBlock } from "~/lib/models/anthropic-types"

import type { ServerToolListing, ServerToolRun } from "./types"

/** What a tool with no text output says to the model (the API rejects an
 *  empty `tool_result`). */
const NO_OUTPUT = "(no output)"

/** A tool's result as the text the model reads. Text blocks joined; a tool
 *  that only returned `structuredContent` gets it as JSON. */
function resultText(result: ToolResult): string {
  const text = result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
  if (text !== "") return text
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent)
  }
  return NO_OUTPUT
}

function runFrom(toolUseId: string, result: ToolResult): ServerToolRun {
  const isError = result.isError === true
  return {
    toolResult: {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: resultText(result),
      ...(isError ? { is_error: true } : {}),
    },
    ok: !isError,
    ...(isError ? { code: "tool_error" } : {}),
  }
}

function failureText(error: unknown): string {
  return error instanceof Error && error.message !== "" ?
      error.message
    : "The tool is not available."
}

/** Only `hidden` has a client rendering for plugin tools so far. */
const SERVED_RENDERS: ReadonlySet<string> = new Set(["hidden"])

function listingFor(
  gateway: PluginGateway,
  view: ServerToolView,
): ServerToolListing {
  return {
    owner: view.pluginId,
    name: view.name,
    description: view.description,
    input_schema: view.input_schema,
    render: view.render,
    offer: view.offer,
    clients: view.clients,
    run: async (toolUse: AnthropicToolUseBlock, call) => {
      try {
        const result = await gateway.callServerTool(
          view.pluginId,
          view.name,
          toolUse.input,
          call,
        )
        return runFrom(toolUse.id, result)
      } catch (error) {
        // The plugin stopped between the plan and the call. The model gets
        // the failure and carries on without the tool.
        return runFrom(toolUse.id, {
          isError: true,
          content: [{ type: "text", text: failureText(error) }],
        })
      }
    },
  }
}

/**
 * The server tools the running plugins offer right now. Cheap: reads the
 * gateway's live registry, so call it per request.
 *
 * `onUnserved` hears of a tool whose render the loop cannot show the client
 * for a plugin tool (everything but `hidden`); it is not offered.
 */
export function pluginServerToolListings(
  gateway: PluginGateway | undefined,
  onUnserved: (view: ServerToolView) => void = () => {},
): Array<ServerToolListing> {
  if (!gateway) return []
  const listings: Array<ServerToolListing> = []
  for (const view of gateway.serverTools()) {
    if (!SERVED_RENDERS.has(view.render)) {
      onUnserved(view)
      continue
    }
    listings.push(listingFor(gateway, view))
  }
  return listings
}
