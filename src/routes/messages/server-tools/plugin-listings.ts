/**
 * Plugin-provided server tools, read through the plugin gateway.
 */

import type {
  PluginGateway,
  ServerToolView,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import type { BudgetRefusal } from "~/lib/budget/errors"
import type { BudgetService } from "~/lib/budget/service"
import type { AnthropicToolUseBlock } from "~/lib/models/anthropic-types"

import { BudgetExceededError } from "~/lib/budget/errors"
import { currentBudgetKey, reserveBudget } from "~/lib/budget/runtime"

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

/** What the model reads when a limit refuses the call: the reason in plain
 *  words, so it can tell the person, and (unless it is only moments) not to
 *  retry. The tool's description never changes, so the prompt cache holds. */
function refusalResult(refusal: BudgetRefusal): ToolResult {
  const retry =
    refusal.inFlight ? "" : (
      " Don't retry this tool until the budget resets or is raised."
    )
  return {
    isError: true,
    content: [{ type: "text", text: `Not run: ${refusal.message}${retry}` }],
    structuredContent: {
      budget: {
        limit_id: refusal.limitId,
        resets_at:
          refusal.resetsAtMs === null ?
            null
          : new Date(refusal.resetsAtMs).toISOString(),
      },
    },
  }
}

function listingFor(
  gateway: PluginGateway,
  view: ServerToolView,
  budget: BudgetService | undefined,
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
      // The host books a call to `{ plugin, tool }` (`ServerToolCall.budget`).
      // The limits covering that pair, the caller's key, or everything decide
      // it here. A server tool has no estimate of its own yet, so it runs
      // while those limits have room; what it spends lands in them through
      // its usage rows.
      let hold
      try {
        hold = await reserveBudget(
          {
            operation: "server_tool",
            plugin: view.pluginId,
            tool: view.name,
            key: currentBudgetKey(),
            estimateNanoAiu: 0,
          },
          budget,
        )
      } catch (error) {
        // A refusal is the tool's result, never an error of the turn.
        if (error instanceof BudgetExceededError) {
          return runFrom(toolUse.id, refusalResult(error.refusal))
        }
        return runFrom(toolUse.id, {
          isError: true,
          content: [{ type: "text", text: failureText(error) }],
        })
      }
      try {
        const result = await gateway.callServerTool(
          view.pluginId,
          view.name,
          toolUse.input,
          call,
        )
        if (result.isError === true) hold.release("upstream-error")
        else hold.commit()
        return runFrom(toolUse.id, result)
      } catch (error) {
        hold.release(call.signal.aborted ? "aborted" : "upstream-error")
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
 * for a plugin tool (everything but `hidden`); it is not offered. `budget`
 * defaults to the app's budget service.
 */
export function pluginServerToolListings(
  gateway: PluginGateway | undefined,
  onUnserved: (view: ServerToolView) => void = () => {},
  budget?: BudgetService,
): Array<ServerToolListing> {
  if (!gateway) return []
  const listings: Array<ServerToolListing> = []
  for (const view of gateway.serverTools()) {
    if (!SERVED_RENDERS.has(view.render)) {
      onUnserved(view)
      continue
    }
    listings.push(listingFor(gateway, view, budget))
  }
  return listings
}
