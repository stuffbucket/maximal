/**
 * Strips Anthropic-server-side web tool declarations
 * (`web_search_20250305`, `web_fetch_20250910`) — which Copilot rejects
 * — and substitutes client-side shims. The agent loop executes the
 * shims and synthesizes the server-side result blocks on the wire.
 */

import type { AnthropicMessagesPayload, AnthropicTool } from "./anthropic-types"
import type { WebToolDecl } from "./web-tools-types"

import { TOOL_NAME, TOOL_TYPE, type ToolName } from "./web-tools-vocab"

// Tool declarations may carry a `type` field for server-side variants
// that the inherited AnthropicTool type doesn't model; widen for read.
type RawTool = AnthropicTool & { type?: unknown }

const EMPTY_POLICY: WebToolPolicy = {
  declarations: [],
  hasSearch: false,
  hasFetch: false,
}

// type/name pair must match exactly. Mismatches pass through unchanged
// so Copilot rejects and the client sees the underlying error.
function isWebToolDecl(tool: RawTool): tool is RawTool & { type: string } {
  return (
    (tool.type === TOOL_TYPE.webSearch && tool.name === TOOL_NAME.webSearch)
    || (tool.type === TOOL_TYPE.webFetch && tool.name === TOOL_NAME.webFetch)
  )
}

export interface WebToolPolicy {
  declarations: Array<WebToolDecl>
  hasSearch: boolean
  hasFetch: boolean
}

/** Remove Anthropic-server-side web tools from `payload.tools` and
 *  return the parsed declarations. No-ops (and avoids array allocation)
 *  when the request declares no web tools. */
export function splitWebTools(
  payload: AnthropicMessagesPayload,
): WebToolPolicy {
  const tools = payload.tools as Array<RawTool> | undefined
  if (!tools || tools.length === 0) return EMPTY_POLICY
  if (!tools.some((t) => isWebToolDecl(t))) return EMPTY_POLICY

  const declarations: Array<WebToolDecl> = []
  const remaining: Array<AnthropicTool> = []
  for (const t of tools) {
    if (isWebToolDecl(t)) {
      declarations.push(t as unknown as WebToolDecl)
    } else {
      const clean = { ...t }
      delete (clean as { type?: unknown }).type
      remaining.push(clean)
    }
  }
  payload.tools = remaining

  return {
    declarations,
    hasSearch: declarations.some((d) => d.name === TOOL_NAME.webSearch),
    hasFetch: declarations.some((d) => d.name === TOOL_NAME.webFetch),
  }
}

// ────────────────────────────────────────────────────────────────────
// Client-side shim declarations the model will see in place of the
// server-side ones we stripped. Descriptions match Anthropic's docs
// closely enough that the model uses them in the same situations.
// ────────────────────────────────────────────────────────────────────

const WEB_FETCH_SHIM: AnthropicTool = {
  name: TOOL_NAME.webFetch,
  description:
    "Fetch the content of a web page or document at a URL and return it as markdown text. The URL must be one that already appears in the conversation; do not invent URLs.",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch.",
      },
    },
    required: ["url"],
  },
}

const WEB_SEARCH_SHIM: AnthropicTool = {
  name: TOOL_NAME.webSearch,
  description:
    "Search the web for information matching a query. Returns a list of result URLs and titles. Follow up with web_fetch to get the actual content of a result.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query.",
      },
    },
    required: ["query"],
  },
}

/** Append client-side shim tool declarations matching the stripped
 *  server-side ones, so the model sees web_search/web_fetch as regular
 *  tools it can call. Idempotent: skips if a tool of the same name is
 *  already present (e.g. the client added one explicitly). */
export function attachClientShims(
  payload: AnthropicMessagesPayload,
  policy: WebToolPolicy,
): void {
  if (policy.declarations.length === 0) return

  const tools: Array<AnthropicTool> = payload.tools ?? []
  const existing = new Set<string>(tools.map((t) => t.name))

  if (policy.hasFetch && !existing.has(TOOL_NAME.webFetch)) {
    tools.push(WEB_FETCH_SHIM)
  }
  if (policy.hasSearch && !existing.has(TOOL_NAME.webSearch)) {
    tools.push(WEB_SEARCH_SHIM)
  }

  payload.tools = tools
}

export function isWebToolName(name: string): name is ToolName {
  return name === TOOL_NAME.webSearch || name === TOOL_NAME.webFetch
}
