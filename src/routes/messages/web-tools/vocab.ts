/**
 * Wire vocabulary for Anthropic Messages API web-tools.
 *
 * Single source of truth for the literal strings the rest of the
 * web-tools modules dispatch on. `as const` + derived unions stop
 * those literals from drifting across files.
 */

export const TOOL_TYPE = {
  webSearch: "web_search_20250305",
  webFetch: "web_fetch_20250910",
} as const

export const TOOL_NAME = {
  webSearch: "web_search",
  webFetch: "web_fetch",
} as const

export type ToolName = (typeof TOOL_NAME)[keyof typeof TOOL_NAME]

export const BLOCK_KIND = {
  serverToolUse: "server_tool_use",
  webSearchResult: "web_search_tool_result",
  webFetchResult: "web_fetch_tool_result",
  webSearchError: "web_search_tool_result_error",
  webFetchError: "web_fetch_tool_result_error",
} as const

export type WebSearchErrorCode =
  | "invalid_input"
  | "too_many_requests"
  | "max_uses_exceeded"
  | "query_too_long"
  | "unavailable"

export type WebFetchErrorCode =
  | "invalid_input"
  | "url_too_long"
  | "url_not_allowed"
  | "url_not_accessible"
  | "too_many_requests"
  | "unsupported_content_type"
  | "max_uses_exceeded"
  | "unavailable"

export const MAX_URL_LENGTH = 250

export const DEFAULT_MAX_USES = {
  webSearch: 5,
  webFetch: 10,
} as const

/** Cap on agent-loop iterations; shared between the streaming and
 *  non-streaming variants. */
export const MAX_AGENT_TURNS = 10
