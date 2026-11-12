/**
 * What the host does with the `serverTools` registrations: list them for the
 * app core and run one. Kept out of `host.ts`, which is long enough.
 */
import type {
  ServerToolCall,
  ServerToolDefinition,
  ServerToolView,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk"

import { DEFAULT_SERVER_TOOL_CLIENTS } from "@stuffbucket/maximal-plugin-sdk"
import {
  errorMessage,
  type PluginRuntime,
} from "@stuffbucket/maximal-plugin-sdk/runtime"

/** Plain code-unit order, so the same set of tools always lists the same way. */
function byName(a: ServerToolView, b: ServerToolView): number {
  if (a.name < b.name) return -1
  return a.name > b.name ? 1 : 0
}

/** The registered server tools of the plugins in `activeIds`, by name. */
export function listServerToolViews(
  runtime: PluginRuntime,
  activeIds: Iterable<string>,
): Array<ServerToolView> {
  const views: Array<ServerToolView> = []
  for (const pluginId of activeIds) {
    for (const tool of runtime.serverTools(pluginId)) {
      views.push({
        pluginId,
        name: tool.name,
        description: tool.description,
        input_schema: structuredClone(tool.input_schema),
        render: tool.render,
        offer: tool.offer,
        clients: tool.clients ?? DEFAULT_SERVER_TOOL_CLIENTS,
      })
    }
  }
  return views.sort(byName)
}

function isToolResult(value: unknown): value is ToolResult {
  return (
    value !== null
    && typeof value === "object"
    && Array.isArray((value as { content?: unknown }).content)
  )
}

function failed(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] }
}

/**
 * Run a server tool for `pluginId`. A call stops when the caller's signal or
 * the plugin's lifetime aborts; a throw or a malformed result becomes an
 * `isError` result, as for MCP tools.
 */
export async function runServerTool(run: {
  tool: Readonly<ServerToolDefinition>
  pluginId: string
  input: Record<string, unknown>
  call: ServerToolCall
  /** Aborts when the plugin stops. */
  lifetime: AbortSignal | undefined
}): Promise<ToolResult> {
  const { tool, call, lifetime } = run
  const signal =
    lifetime ? AbortSignal.any([call.signal, lifetime]) : call.signal
  try {
    const result: unknown = await tool.execute(run.input, {
      ...call,
      signal,
      budget: { plugin: run.pluginId, tool: tool.name },
    })
    return isToolResult(result) ? result : (
        failed(`Server tool "${tool.name}" returned an invalid result.`)
      )
  } catch (error) {
    return failed(errorMessage(error))
  }
}
