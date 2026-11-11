/**
 * Turn transports for the web-tools agent loop.
 *
 * The loop speaks Anthropic Messages to the client whatever happens upstream;
 * a *transport* is how one turn of it reaches Copilot:
 *
 *   - `messages`  — Copilot's native `/v1/messages`. No translation, so
 *                   thinking signatures, `cache_control`, context editing and
 *                   Copilot's prompt cache all survive the loop.
 *   - `responses` — `/responses`, for models that serve it.
 *   - `chat`      — `/chat/completions`, the historical fallback.
 *
 * Upstream calls arrive as {@link WebToolsUpstreamDeps} so tests (and the
 * future server-tools registry) inject them instead of `mock.module`-ing the
 * shared Copilot service modules (docs/architecture.md § Testing gotchas).
 * Ported from monimal `packages/maximal-core/src/routes/messages/web-tools/`
 * (`WebToolsUpstreamDeps`, `buildCallOnce`) at d8d5b876, extended with the
 * native Messages transport.
 */

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/models/anthropic-types"
import type { Model } from "~/services/copilot/get-models"
import type { CopilotCallOptions } from "~/services/copilot/upstream-request"

import { getResponsesRequestOptions } from "~/routes/responses/utils"
import { isAsyncIterable, isNonStreaming } from "~/routes/streaming-predicates"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import { createResponses } from "~/services/copilot/create-responses"

import {
  shouldUseMessagesApi,
  shouldUseResponsesApi,
} from "../endpoint-selection"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "../non-stream-translation"
import { prepareMessagesApiPayload } from "../preprocess"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "../responses-translation"
import { isWebToolName } from "./rewriter"
import { BLOCK_KIND } from "./vocab"

export type TurnTransport = "messages" | "responses" | "chat"

/** The upstream calls the loop makes for its own turns. The executors' side
 *  calls (Copilot web search) have their own seam on the executor. */
export interface WebToolsUpstreamDeps {
  createChatCompletions: typeof createChatCompletions
  createResponses: typeof createResponses
  createMessages: typeof createMessages
}

const defaultUpstreamDeps: WebToolsUpstreamDeps = {
  createChatCompletions,
  createResponses,
  createMessages,
}

/**
 * Which transports a caller allows. Absent means today's web-tools choice
 * (`responses` when the model serves it, else `chat`), which keeps
 * `web_search` / `web_fetch` output byte-for-byte what it was before the
 * native transport existed. A caller that sets `nativeMessages` gets
 * `/v1/messages` for models that use the Messages API.
 */
export interface TransportPolicy {
  nativeMessages?: boolean
}

export function selectTurnTransport(
  selectedModel: Model | undefined,
  policy: TransportPolicy = {},
): TurnTransport {
  if (policy.nativeMessages && shouldUseMessagesApi(selectedModel)) {
    return "messages"
  }
  if (shouldUseResponsesApi(selectedModel)) return "responses"
  return "chat"
}

/** Everything one turn needs to reach Copilot. Built once per request. */
export interface TurnUpstream {
  transport: TurnTransport
  callOptions: CopilotCallOptions
  /** The client's `anthropic-beta`; only the `messages` transport sends it
   *  (filtered by `createMessages`, as on the ordinary Messages flow). */
  anthropicBetaHeader?: string
  deps: WebToolsUpstreamDeps
}

/** Build a request's {@link TurnUpstream}; missing deps are the real calls. */
export function buildTurnUpstream(input: {
  transport?: TurnTransport
  options: CopilotCallOptions
  anthropicBetaHeader?: string
  deps?: Partial<WebToolsUpstreamDeps>
}): TurnUpstream {
  const { options } = input
  return {
    transport: input.transport ?? "chat",
    callOptions: {
      requestId: options.requestId,
      sessionId: options.sessionId,
      compactType: options.compactType,
      subagentMarker: options.subagentMarker,
    },
    anthropicBetaHeader: input.anthropicBetaHeader,
    deps: { ...defaultUpstreamDeps, ...input.deps },
  }
}

const NON_STREAMING_EXPECTED =
  "web-tools agent: expected non-streaming response from Copilot"

/** One non-streaming agent turn, normalized to an Anthropic response. */
export function buildCallOnce(
  upstream: TurnUpstream,
): (payload: AnthropicMessagesPayload) => Promise<AnthropicResponse> {
  const { callOptions, deps } = upstream
  switch (upstream.transport) {
    case "messages": {
      return async (turnPayload) => {
        const response = await deps.createMessages(
          { ...turnPayload, stream: false },
          upstream.anthropicBetaHeader,
          callOptions,
        )
        if (isAsyncIterable(response)) throw new Error(NON_STREAMING_EXPECTED)
        return response
      }
    }
    case "responses": {
      return async (turnPayload) => {
        const responsesPayload =
          translateAnthropicMessagesToResponsesPayload(turnPayload)
        responsesPayload.stream = false
        const { vision, initiator } =
          getResponsesRequestOptions(responsesPayload)
        const response = await deps.createResponses(responsesPayload, {
          vision,
          initiator,
          ...callOptions,
        })
        if (isAsyncIterable(response)) throw new Error(NON_STREAMING_EXPECTED)
        return translateResponsesResultToAnthropic(response)
      }
    }
    case "chat": {
      return async (turnPayload) => {
        const openAIPayload = translateToOpenAI(turnPayload)
        openAIPayload.stream = false
        const response = await deps.createChatCompletions(
          openAIPayload,
          callOptions,
        )
        if (!isNonStreaming(response)) throw new Error(NON_STREAMING_EXPECTED)
        return translateToAnthropic(response)
      }
    }
    default: {
      throw new Error(
        `unhandled web-tools transport: ${upstream.transport as string}`,
      )
    }
  }
}

/**
 * Get a request ready for the `messages` transport, once, before the first
 * turn. Every later turn only appends messages, so the prefix Copilot caches
 * (tools, system, the client's history) is the same bytes on every turn.
 *
 *  1. Drop the `server_tool_use` / `web_*_tool_result` blocks the client
 *     echoes back from earlier web-tools replies. Copilot has no server tools
 *     and the search results carry a local stand-in for `encrypted_content`,
 *     so they can't go upstream. The translated transports drop them too.
 *  2. Run the ordinary Messages preprocessing (`prepareMessagesApiPayload`).
 */
export function prepareNativeMessagesPayload(
  payload: AnthropicMessagesPayload,
  selectedModel: Model | undefined,
): void {
  stripServerToolHistory(payload)
  prepareMessagesApiPayload(payload, selectedModel)
}

const SYNTHESIZED_RESULT_KINDS: ReadonlySet<string> = new Set([
  BLOCK_KIND.webSearchResult,
  BLOCK_KIND.webFetchResult,
  BLOCK_KIND.webSearchError,
  BLOCK_KIND.webFetchError,
])

function isSynthesizedServerToolBlock(block: { type: string }): boolean {
  if (SYNTHESIZED_RESULT_KINDS.has(block.type)) return true
  if (block.type !== BLOCK_KIND.serverToolUse) return false
  const name = (block as { name?: unknown }).name
  return typeof name === "string" && isWebToolName(name)
}

/** An assistant message left empty is dropped; the Messages API joins the
 *  neighbouring same-role turns. */
function stripServerToolHistory(payload: AnthropicMessagesPayload): void {
  const touched = payload.messages.some(
    (m) =>
      m.role === "assistant"
      && Array.isArray(m.content)
      && m.content.some((b) => isSynthesizedServerToolBlock(b)),
  )
  if (!touched) return
  payload.messages = payload.messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return [message]
    }
    const content: Array<AnthropicAssistantContentBlock> =
      message.content.filter((b) => !isSynthesizedServerToolBlock(b))
    if (content.length === message.content.length) return [message]
    return content.length === 0 ? [] : [{ ...message, content }]
  })
}
