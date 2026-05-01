/**
 * TypeScript discriminated unions for Anthropic web-tools blocks.
 *
 * Closes domain D3: invalid combinations are unrepresentable. A
 * web_search_tool_result cannot carry a `url_not_accessible` error code
 * (web_fetch-only); a web_fetch input cannot have a `query` field; a
 * server_tool_use named `web_search` cannot have a `url` input.
 *
 * Spec: docs/spec/web-tools.md
 */

import {
  TOOL_TYPE,
  TOOL_NAME,
  BLOCK_KIND,
  type ToolName,
  type WebSearchErrorCode,
  type WebFetchErrorCode,
} from "./web-tools-vocab"

// ────────────────────────────────────────────────────────────────────
// Request-side: tool declarations in `tools[]`.
// ────────────────────────────────────────────────────────────────────

interface DomainPolicy {
  max_uses?: number
  allowed_domains?: Array<string>
  blocked_domains?: Array<string>
}

export interface UserLocation {
  type: "approximate"
  city?: string
  region?: string
  country?: string
  timezone?: string
}

export interface WebSearchToolDecl extends DomainPolicy {
  type: typeof TOOL_TYPE.webSearch
  name: typeof TOOL_NAME.webSearch
  user_location?: UserLocation
}

export interface WebFetchToolDecl extends DomainPolicy {
  type: typeof TOOL_TYPE.webFetch
  name: typeof TOOL_NAME.webFetch
  citations?: { enabled: boolean }
  max_content_tokens?: number
}

export type WebToolDecl = WebSearchToolDecl | WebFetchToolDecl

// ────────────────────────────────────────────────────────────────────
// server_tool_use — the model's request to invoke a server-side tool.
// `name` is the discriminator that pins the input shape.
// ────────────────────────────────────────────────────────────────────

interface ServerToolUseBase<N extends ToolName, I> {
  type: typeof BLOCK_KIND.serverToolUse
  id: string
  name: N
  input: I
}

export type WebSearchServerToolUse = ServerToolUseBase<
  typeof TOOL_NAME.webSearch,
  { query: string }
>

export type WebFetchServerToolUse = ServerToolUseBase<
  typeof TOOL_NAME.webFetch,
  { url: string }
>

export type WebToolServerToolUse = WebSearchServerToolUse | WebFetchServerToolUse

// ────────────────────────────────────────────────────────────────────
// Result blocks — what the proxy synthesizes and emits back into the
// stream on the model's behalf.
// ────────────────────────────────────────────────────────────────────

export interface WebSearchResultItem {
  type: "web_search_result"
  url: string
  title: string
  encrypted_content: string
  page_age?: string | null
}

export interface WebSearchSuccessBlock {
  type: typeof BLOCK_KIND.webSearchResult
  tool_use_id: string
  content: Array<WebSearchResultItem>
}

export interface WebSearchErrorBlock {
  type: typeof BLOCK_KIND.webSearchError
  tool_use_id: string
  content: {
    type: typeof BLOCK_KIND.webSearchError
    error_code: WebSearchErrorCode
  }
}

export type WebSearchToolResultBlock =
  | WebSearchSuccessBlock
  | WebSearchErrorBlock

// web_fetch result content is a single document, not an array.

export interface DocumentSourceText {
  type: "text"
  media_type: "text/plain" | "text/markdown" | "text/html"
  data: string
}

export interface DocumentSourceBase64 {
  type: "base64"
  media_type: "application/pdf"
  data: string
}

export type DocumentSource = DocumentSourceText | DocumentSourceBase64

export interface DocumentContent {
  type: "document"
  source: DocumentSource
  title?: string
  citations: { enabled: boolean }
}

export interface WebFetchResultPayload {
  type: "web_fetch_result"
  url: string
  content: DocumentContent
  retrieved_at: string
}

export interface WebFetchSuccessBlock {
  type: typeof BLOCK_KIND.webFetchResult
  tool_use_id: string
  content: WebFetchResultPayload
}

export interface WebFetchErrorBlock {
  type: typeof BLOCK_KIND.webFetchError
  tool_use_id: string
  content: {
    type: typeof BLOCK_KIND.webFetchError
    error_code: WebFetchErrorCode
  }
}

export type WebFetchToolResultBlock = WebFetchSuccessBlock | WebFetchErrorBlock

// ────────────────────────────────────────────────────────────────────
// Combined unions for code that must dispatch on every web-tool block.
// ────────────────────────────────────────────────────────────────────

export type WebToolResultBlock = WebSearchToolResultBlock | WebFetchToolResultBlock

// Compile-time exhaustiveness helper: assert all cases handled.
export function assertExhaustive(value: never): never {
  throw new Error(
    `assertExhaustive: unhandled case ${JSON.stringify(value)}`,
  )
}
