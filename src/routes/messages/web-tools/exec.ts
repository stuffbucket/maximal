/**
 * Shared executor-driver helpers for web-tools.
 *
 * Both web-tools-agent.ts (non-streaming) and web-tools-stream.ts
 * (streaming) call into here so the (a) tool-execution decision tree,
 * (b) tool_result-for-model formatting, and (c) Anthropic
 * server-side result-block synthesis live in one place.
 */

import type {
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "~/lib/anthropic-types"

import type { Executor, FetchResult, SearchHit, SearchResult } from "./executor"

import {
  checkFetchPolicy,
  checkSearchPolicy,
  isHostAllowed,
  recordUse,
  type RequestState,
} from "./state"
import {
  TOOL_NAME,
  BLOCK_KIND,
  type ToolName,
  type WebFetchErrorCode,
  type WebSearchErrorCode,
} from "./vocab"

// ────────────────────────────────────────────────────────────────────
// Outcome shape — discriminated over (tool, ok).
// ────────────────────────────────────────────────────────────────────

export type ExecOutcome =
  | {
      tool: typeof TOOL_NAME.webFetch
      ok: true
      url: string
      markdown: string
      title?: string
    }
  | { tool: typeof TOOL_NAME.webFetch; ok: false; code: WebFetchErrorCode }
  | {
      tool: typeof TOOL_NAME.webSearch
      ok: true
      query: string
      items: Array<SearchHit>
    }
  | { tool: typeof TOOL_NAME.webSearch; ok: false; code: WebSearchErrorCode }

// ────────────────────────────────────────────────────────────────────
// Drive one tool_use through the executor, applying D4 policy.
// ────────────────────────────────────────────────────────────────────

export async function executeToolUse(
  tu: AnthropicToolUseBlock & { name: ToolName },
  executor: Executor,
  state: RequestState,
): Promise<ExecOutcome> {
  if (tu.name === TOOL_NAME.webFetch) {
    const policy = checkFetchPolicy(state, tu.input)
    if (!policy.ok) {
      return { tool: TOOL_NAME.webFetch, ok: false, code: policy.code }
    }
    const url = (tu.input as { url: string }).url
    const fr: FetchResult = await executor.fetch(url)
    if (!fr.ok) return { tool: TOOL_NAME.webFetch, ok: false, code: fr.code }
    recordUse(state, TOOL_NAME.webFetch)
    return {
      tool: TOOL_NAME.webFetch,
      ok: true,
      url,
      markdown: fr.markdown,
      title: fr.title,
    }
  }
  const policy = checkSearchPolicy(state, tu.input)
  if (!policy.ok) {
    return { tool: TOOL_NAME.webSearch, ok: false, code: policy.code }
  }
  const query = (tu.input as { query: string }).query
  // Honor the client's declared domain constraints: forward them to the
  // executor (which pushes them to its backend where supported) AND
  // post-filter the returned hits, so the constraint holds even when the
  // backend ignores it. See D4 / isHostAllowed.
  const decl = state.active[TOOL_NAME.webSearch]
  const sr: SearchResult = await executor.search(query, {
    allowedDomains: decl?.allowed_domains,
    blockedDomains: decl?.blocked_domains,
  })
  if (!sr.ok) return { tool: TOOL_NAME.webSearch, ok: false, code: sr.code }
  recordUse(state, TOOL_NAME.webSearch)
  const items =
    decl && (decl.allowed_domains?.length || decl.blocked_domains?.length) ?
      sr.items.filter((hit) => hostAllowedForHit(hit.url, decl))
    : sr.items
  return { tool: TOOL_NAME.webSearch, ok: true, query, items }
}

/** Post-filter a search hit by the declared domain policy. A hit whose URL
 *  doesn't parse is dropped (can't verify it satisfies the constraint). */
function hostAllowedForHit(
  url: string,
  policy: { allowed_domains?: Array<string>; blocked_domains?: Array<string> },
): boolean {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  return isHostAllowed(host, policy)
}

// ────────────────────────────────────────────────────────────────────
// tool_result block fed BACK to the model on the next turn.
// String content (the simple Anthropic shape) suffices.
// ────────────────────────────────────────────────────────────────────

export function buildToolResultMessage(
  toolUseId: string,
  outcome: ExecOutcome,
): AnthropicToolResultBlock {
  if (outcome.ok) {
    if (outcome.tool === TOOL_NAME.webFetch) {
      return {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: outcome.markdown,
      }
    }
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: JSON.stringify(outcome.items, null, 2),
    }
  }
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: `Error: ${outcome.code}`,
    is_error: true,
  }
}

// ────────────────────────────────────────────────────────────────────
// Anthropic server-side result block — what we emit to the CLIENT.
// ────────────────────────────────────────────────────────────────────

interface FetchResultBlock {
  type: typeof BLOCK_KIND.webFetchResult
  tool_use_id: string
  content: {
    type: "web_fetch_result"
    url: string
    content: {
      type: "document"
      source: { type: "text"; media_type: "text/markdown"; data: string }
      title?: string
      citations: { enabled: boolean }
    }
    retrieved_at: string
  }
}

interface FetchErrorOut {
  type: typeof BLOCK_KIND.webFetchError
  tool_use_id: string
  content: {
    type: typeof BLOCK_KIND.webFetchError
    error_code: WebFetchErrorCode
  }
}

interface SearchResultBlock {
  type: typeof BLOCK_KIND.webSearchResult
  tool_use_id: string
  content: Array<{
    type: "web_search_result"
    url: string
    title: string
    encrypted_content: string
    page_age?: string | null
  }>
}

interface SearchErrorOut {
  type: typeof BLOCK_KIND.webSearchError
  tool_use_id: string
  content: {
    type: typeof BLOCK_KIND.webSearchError
    error_code: WebSearchErrorCode
  }
}

export type ResultOutBlock =
  | FetchResultBlock
  | FetchErrorOut
  | SearchResultBlock
  | SearchErrorOut

function encryptedContent(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
}

export function buildResultBlockForOutcome(
  toolUseId: string,
  outcome: ExecOutcome,
): ResultOutBlock {
  if (outcome.tool === TOOL_NAME.webFetch) {
    if (!outcome.ok) {
      return {
        type: BLOCK_KIND.webFetchError,
        tool_use_id: toolUseId,
        content: { type: BLOCK_KIND.webFetchError, error_code: outcome.code },
      }
    }
    return {
      type: BLOCK_KIND.webFetchResult,
      tool_use_id: toolUseId,
      content: {
        type: "web_fetch_result",
        url: outcome.url,
        content: {
          type: "document",
          source: {
            type: "text",
            media_type: "text/markdown",
            data: outcome.markdown,
          },
          ...(outcome.title === undefined ? {} : { title: outcome.title }),
          citations: { enabled: false },
        },
        retrieved_at: new Date().toISOString(),
      },
    }
  }
  if (!outcome.ok) {
    return {
      type: BLOCK_KIND.webSearchError,
      tool_use_id: toolUseId,
      content: { type: BLOCK_KIND.webSearchError, error_code: outcome.code },
    }
  }
  return {
    type: BLOCK_KIND.webSearchResult,
    tool_use_id: toolUseId,
    content: outcome.items.map((it) => ({
      type: "web_search_result",
      url: it.url,
      title: it.title,
      encrypted_content: encryptedContent({
        url: it.url,
        title: it.title,
        page_age: it.page_age ?? null,
      }),
      ...(it.page_age === undefined ? {} : { page_age: it.page_age }),
    })),
  }
}
