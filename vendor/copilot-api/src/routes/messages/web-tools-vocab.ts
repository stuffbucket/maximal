/**
 * Wire vocabulary for Anthropic Messages API web-tools (web_search, web_fetch).
 *
 * Single source of truth. Every other web-tools file imports from here so
 * literal strings can't drift across the codebase. Lit-as-const + union
 * types make the toolchain enforce exhaustive use; bare string literals at
 * call sites are an immediate type error.
 *
 * Spec: docs/spec/web-tools.md
 */

// Versioned tool type identifiers as declared in request `tools[]`.
export const TOOL_TYPE = {
  webSearch: "web_search_20250305",
  webFetch: "web_fetch_20250910",
} as const

export type ToolType = (typeof TOOL_TYPE)[keyof typeof TOOL_TYPE]

// Tool names as emitted by the model in `server_tool_use.name`. Anthropic
// pins these regardless of versioned tool type.
export const TOOL_NAME = {
  webSearch: "web_search",
  webFetch: "web_fetch",
} as const

export type ToolName = (typeof TOOL_NAME)[keyof typeof TOOL_NAME]

// Content block discriminators that appear in the assistant turn.
export const BLOCK_KIND = {
  serverToolUse: "server_tool_use",
  webSearchResult: "web_search_tool_result",
  webFetchResult: "web_fetch_tool_result",
  webSearchError: "web_search_tool_result_error",
  webFetchError: "web_fetch_tool_result_error",
} as const

export type BlockKind = (typeof BLOCK_KIND)[keyof typeof BLOCK_KIND]

// Anthropic SSE event names. Listed for completeness; the interceptor
// only emits content_block_* events itself, but the upstream stream
// produces all of these.
export const SSE_EVENT = {
  messageStart: "message_start",
  contentBlockStart: "content_block_start",
  contentBlockDelta: "content_block_delta",
  contentBlockStop: "content_block_stop",
  messageDelta: "message_delta",
  messageStop: "message_stop",
  ping: "ping",
} as const

export type SseEvent = (typeof SSE_EVENT)[keyof typeof SSE_EVENT]

// Error codes — partitioned per tool. The overlap (invalid_input,
// too_many_requests, max_uses_exceeded, unavailable) is intentional but
// the per-tool unions stay separate so a web_fetch result can never
// carry a query_too_long code (which is web_search-only) and vice versa.

export const WEB_SEARCH_ERROR_CODE = [
  "invalid_input",
  "too_many_requests",
  "max_uses_exceeded",
  "query_too_long",
  "unavailable",
] as const

export type WebSearchErrorCode = (typeof WEB_SEARCH_ERROR_CODE)[number]

export const WEB_FETCH_ERROR_CODE = [
  "invalid_input",
  "url_too_long",
  "url_not_allowed",
  "url_not_accessible",
  "too_many_requests",
  "unsupported_content_type",
  "max_uses_exceeded",
  "unavailable",
] as const

export type WebFetchErrorCode = (typeof WEB_FETCH_ERROR_CODE)[number]

// URL-length cap matching Anthropic's `url_too_long` threshold.
export const MAX_URL_LENGTH = 250

// Default max_uses when the request's tool declaration omits the field.
export const DEFAULT_MAX_USES = {
  webSearch: 5,
  webFetch: 10,
} as const
