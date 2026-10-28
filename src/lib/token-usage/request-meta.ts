import type { CodexModelInfo } from "~/apps/codex/models-catalog"
import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { resolveResponsesCompactThreshold } from "~/routes/responses/utils"

import type { UsageClient } from "./client"

/** Where a request's context-window numbers came from. */
export type WindowSource =
  | "codex-catalog"
  | "claude-1m"
  | "models-endpoint"
  | "model-listing"

/** The context window a request ran under. `null` means unknown. */
export interface RequestContextWindow {
  windowTokens: number | null
  ceilingTokens: number | null
  compactAtTokens: number | null
  source: WindowSource
}

const FIVE_MINUTES_SECONDS = 300
const ONE_HOUR_SECONDS = 3600
const ONE_DAY_SECONDS = 86_400
const CLAUDE_LONG_CONTEXT_TOKENS = 1_000_000

/** Every `cache_control` marker in the payload, wherever Anthropic allows one. */
function* cacheControls(
  payload: AnthropicMessagesPayload,
): Generator<Record<string, unknown>> {
  const blocks: Array<{ cache_control?: Record<string, unknown> }> = []
  if (Array.isArray(payload.system)) blocks.push(...payload.system)
  if (payload.tools) blocks.push(...payload.tools)
  for (const message of payload.messages) {
    if (typeof message.content === "string") continue
    for (const block of message.content) {
      if (block.type === "thinking") continue
      blocks.push(block)
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        blocks.push(...block.content)
      }
    }
  }
  for (const block of blocks) {
    if (block.cache_control) yield block.cache_control
  }
}

/**
 * How long a prompt-cache write on this request lives: an hour when any marker
 * asks for `ttl: "1h"`, five minutes for any other marker, none without one.
 */
export function anthropicCacheTtlSeconds(
  payload: AnthropicMessagesPayload,
): number {
  let seconds = 0
  for (const control of cacheControls(payload)) {
    if (control.ttl === "1h") return ONE_HOUR_SECONDS
    seconds = FIVE_MINUTES_SECONDS
  }
  return seconds
}

/** Responses prompt-cache lifetime: `"24h"` retention is a day, else minutes. */
export function responsesCacheTtlSeconds(
  retention: string | null | undefined,
): number {
  return retention === "24h" ? ONE_DAY_SECONDS : FIVE_MINUTES_SECONDS
}

/**
 * The context window a request ran under. The ceiling is always Copilot's
 * prompt limit; the window and compaction point depend on which client sent it.
 */
export function resolveContextWindow(input: {
  client: UsageClient
  model: Model | undefined
  longContext: boolean
  codexCatalog?: Array<CodexModelInfo>
  maximalCompacts?: boolean
}): RequestContextWindow {
  const { client, model, longContext, codexCatalog, maximalCompacts } = input
  if (!model) {
    return {
      windowTokens: null,
      ceilingTokens: null,
      compactAtTokens: null,
      source: "model-listing",
    }
  }

  const { limits } = model.capabilities
  const ceilingTokens = limits.max_prompt_tokens ?? null
  // The value /v1/models serves as `max_input_tokens`.
  const listed = limits.max_context_window_tokens ?? limits.max_prompt_tokens

  if (client === "codex") {
    const entry = codexCatalog?.find((candidate) => candidate.slug === model.id)
    const window = entry?.context_window
    const entryCompact = entry?.auto_compact_token_limit
    const catalogCompact =
      typeof entryCompact === "number" ? entryCompact : null
    return {
      windowTokens: typeof window === "number" ? window : null,
      ceilingTokens,
      compactAtTokens:
        maximalCompacts ?
          resolveResponsesCompactThreshold(limits.max_prompt_tokens)
        : catalogCompact,
      source: "codex-catalog",
    }
  }

  if (client === "claude-code" && longContext) {
    return {
      windowTokens: CLAUDE_LONG_CONTEXT_TOKENS,
      ceilingTokens,
      compactAtTokens: null,
      source: "claude-1m",
    }
  }

  return {
    windowTokens: listed ?? null,
    ceilingTokens,
    compactAtTokens: null,
    source: client === "claude-code" ? "models-endpoint" : "model-listing",
  }
}
