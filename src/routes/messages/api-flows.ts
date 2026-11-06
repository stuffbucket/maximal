import type { ConsolaInstance } from "consola"
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { CompactType } from "~/lib/models/compact"
import type { SubagentMarker } from "~/lib/runtime-state/subagent"
import type { Model } from "~/services/copilot/get-models"

import { getPromptCacheRetention } from "~/lib/config/config"
import { setRequestUsage } from "~/lib/http/request-context"
import {
  asRecord,
  readNestedUsage,
  readUsage,
} from "~/lib/http/untrusted-frame"
import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "~/lib/models/anthropic-types"
import { debugJson, debugJsonTail, debugLazy } from "~/lib/platform/logger"
import { parseUserIdMetadata } from "~/lib/platform/utils"
import {
  createCopilotTokenUsageRecorder,
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  normalizeResponsesUsage,
  resolveTokenUsageSessionId,
  type TokenUsageEndpoint,
  type UsageTokens,
  withCopilotCost,
} from "~/lib/token-usage"
import { responsesCacheTtlSeconds } from "~/lib/token-usage/request-meta"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesRequestOptions,
} from "~/routes/responses/utils"
import { isAsyncIterable, isNonStreaming } from "~/routes/streaming-predicates"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { prepareMessagesApiPayload } from "./preprocess"
import { emitStreamError } from "./stream-error"
import { createStreamKeepAlive } from "./stream-keepalive"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export interface FlowBaseOptions {
  logger: ConsolaInstance
  subagentMarker?: SubagentMarker | null
  requestId: string
  sessionId?: string
  compactType?: CompactType
  keepAliveIntervalMs?: number
}

interface ResponsesFlowOptions extends FlowBaseOptions {
  selectedModel?: Model
}

interface MessagesFlowOptions extends FlowBaseOptions {
  anthropicBetaHeader?: string
  selectedModel?: Model
}

export const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: FlowBaseOptions,
) => {
  const { logger, subagentMarker, requestId, sessionId, compactType } = options
  const openAIPayload = translateToOpenAI(anthropicPayload)
  // Chat completions caches automatically; the client's markers don't apply.
  setRequestUsage({
    cacheTtlS: responsesCacheTtlSeconds(undefined),
    cacheTtlRequested: false,
  })
  const recordUsage = createCopilotUsageRecorder({
    endpoint: "chat_completions",
    fallbackSessionId: sessionId,
    model: openAIPayload.model,
    payload: anthropicPayload,
  })
  debugJson(logger, "Translated OpenAI request payload:", openAIPayload)

  const response = await createChatCompletions(openAIPayload, {
    subagentMarker,
    requestId,
    sessionId,
    compactType,
  })

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response from Copilot:", response)
    recordUsage(
      withCopilotCost(
        normalizeOpenAIUsage(response.usage),
        response.copilot_usage,
      ),
    )
    const anthropicResponse = translateToAnthropic(response)
    debugJson(logger, "Translated Anthropic response:", anthropicResponse)
    return c.json(anthropicResponse)
  }

  logger.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const keepAlive = createStreamKeepAlive(stream, options.keepAliveIntervalMs)
    let usage: UsageTokens = {}
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }

    try {
      for await (const rawEvent of response) {
        debugJson(logger, "Copilot raw stream event:", rawEvent)
        if (rawEvent.data === "[DONE]") {
          break
        }

        if (!rawEvent.data) {
          continue
        }

        const chunk: unknown = JSON.parse(rawEvent.data)
        const chunkUsage = readUsage(chunk)
        if (chunkUsage) {
          usage = normalizeOpenAIUsage(chunkUsage)
        }
        const events = translateChunkToAnthropicEvents(chunk, streamState)

        for (const event of events) {
          const eventData = JSON.stringify(event)
          debugLazy(logger, () => ["Translated Anthropic event:", eventData])
          await keepAlive.writeSSE({
            event: event.type,
            data: eventData,
          })
        }
      }
    } catch (error) {
      keepAlive.stop()
      await emitStreamError(stream, logger, { error, flow: "chat_completions" })
    } finally {
      keepAlive.stop()
    }

    recordUsage(usage)
  })
}

export const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: ResponsesFlowOptions,
) => {
  const { logger, selectedModel, keepAliveIntervalMs, ...requestOptions } =
    options

  const responsesPayload =
    translateAnthropicMessagesToResponsesPayload(anthropicPayload)
  const recordUsage = createCopilotUsageRecorder({
    endpoint: "responses",
    fallbackSessionId: requestOptions.sessionId,
    model: responsesPayload.model,
    payload: anthropicPayload,
  })

  applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )

  applyPromptCacheRetention(responsesPayload)

  compactInputByLatestCompaction(responsesPayload)

  debugJson(logger, "Translated Responses payload:", responsesPayload)

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const response = await createResponses(responsesPayload, {
    vision,
    initiator,
    ...requestOptions,
  })

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return streamSSE(c, async (stream) => {
      const keepAlive = createStreamKeepAlive(stream, keepAliveIntervalMs)
      const streamState = createResponsesStreamState()
      let usage: UsageTokens = {}

      try {
        for await (const chunk of response) {
          if (chunk.event === "ping") {
            await keepAlive.writeSSE({ event: "ping", data: '{"type":"ping"}' })
            continue
          }
          const data = chunk.data
          if (!data) continue

          debugLazy(logger, () => ["Responses raw stream event:", data])
          const responseEvent: unknown = JSON.parse(data)
          const responseEventType = asRecord(responseEvent)?.type
          if (
            responseEventType === "response.completed"
            || responseEventType === "response.failed"
            || responseEventType === "response.incomplete"
          ) {
            usage = normalizeResponsesUsage(
              readNestedUsage(responseEvent, "response"),
            )
          }

          for (const event of translateResponsesStreamEvent(
            responseEvent,
            streamState,
          )) {
            const eventData = JSON.stringify(event)
            debugLazy(logger, () => ["Translated Anthropic event:", eventData])
            await keepAlive.writeSSE({ event: event.type, data: eventData })
          }

          if (streamState.messageCompleted) {
            logger.debug("Message completed, ending stream")
            break
          }
        }
      } catch (error) {
        keepAlive.stop()
        await emitStreamError(stream, logger, { error, flow: "responses" })
        recordUsage(usage)
        return
      } finally {
        keepAlive.stop()
      }

      if (!streamState.messageCompleted) {
        logger.warn(
          "Responses stream ended without completion; sending error event",
        )
        // The upstream closed early — retryable, like a mid-stream drop.
        const errorEvent = buildErrorEvent(
          "Responses stream ended without completion",
          "overloaded_error",
        )
        await stream.writeSSE({
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }

      recordUsage(usage)
    })
  }

  return finishNonStreamingResponses(c, response as ResponsesResult, {
    logger,
    recordUsage,
  })
}

/** Copilot/OpenAI-Responses-specific prefix-cache retention. Opt-in via
 *  config; omitted otherwise so behavior is unchanged. Set on the built
 *  payload here (not in the pure translator). A future non-Copilot provider
 *  path won't use this. Safe to enable: create-responses.ts strips + retries
 *  once if a specific endpoint 400s on the param. The request's cache lifetime
 *  follows this upstream rule, not the client's markers. */
function applyPromptCacheRetention(payload: ResponsesPayload): void {
  const promptCacheRetention = getPromptCacheRetention()
  if (promptCacheRetention) {
    payload.prompt_cache_retention = promptCacheRetention
  }
  setRequestUsage({
    cacheTtlS: responsesCacheTtlSeconds(payload.prompt_cache_retention),
    cacheTtlRequested: false,
  })
}

/** Non-streaming /responses tail: log, translate to Anthropic, record
 *  usage+cost, respond. Extracted to keep handleWithResponsesApi under the
 *  per-function line cap. */
function finishNonStreamingResponses(
  c: Context,
  result: ResponsesResult,
  deps: { logger: ConsolaInstance; recordUsage: (usage: UsageTokens) => void },
) {
  const { logger, recordUsage } = deps
  debugJsonTail(logger, "Non-streaming Responses result:", {
    value: result,
    tailLength: 400,
  })
  const anthropicResponse = translateResponsesResultToAnthropic(result)
  recordUsage(
    withCopilotCost(
      normalizeResponsesUsage(result.usage),
      result.copilot_usage,
    ),
  )
  debugJson(logger, "Translated Anthropic response:", anthropicResponse)
  return c.json(anthropicResponse)
}

export const handleWithMessagesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: MessagesFlowOptions,
) => {
  const {
    logger,
    anthropicBetaHeader,
    subagentMarker,
    selectedModel,
    requestId,
    sessionId,
    compactType,
  } = options

  prepareMessagesApiPayload(anthropicPayload, selectedModel)
  const recordUsage = createCopilotUsageRecorder({
    endpoint: "messages",
    fallbackSessionId: sessionId,
    model: anthropicPayload.model,
    payload: anthropicPayload,
  })

  debugJson(logger, "Translated Messages payload:", anthropicPayload)

  const response = await createMessages(anthropicPayload, anthropicBetaHeader, {
    subagentMarker,
    requestId,
    sessionId,
    compactType,
  })

  if (isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Messages API)")
    return streamSSE(c, async (stream) => {
      const keepAlive = createStreamKeepAlive(
        stream,
        options.keepAliveIntervalMs,
      )
      let usage: UsageTokens = {}

      try {
        for await (const event of response) {
          const eventName = event.event
          const data = event.data ?? ""
          if (data === "[DONE]") {
            break
          }
          if (!data) {
            continue
          }
          debugLazy(logger, () => ["Messages raw stream event:", data])
          const parsedEvent = parseAnthropicStreamEvent(data)
          const parsedEventType =
            typeof parsedEvent?.type === "string" ? parsedEvent.type : undefined
          const resolvedEventName = eventName ?? parsedEventType
          if (parsedEventType === "message_start") {
            usage = mergeAnthropicUsage(
              usage,
              normalizeAnthropicUsage(readNestedUsage(parsedEvent, "message")),
            )
          } else if (parsedEventType === "message_delta") {
            usage = mergeAnthropicUsage(
              usage,
              normalizeAnthropicUsage(readUsage(parsedEvent)),
            )
          }
          await keepAlive.writeSSE(
            {
              event: resolvedEventName,
              data,
            },
            { isMessageStart: parsedEventType === "message_start" },
          )
        }
      } catch (error) {
        keepAlive.stop()
        await emitStreamError(stream, logger, { error, flow: "messages" })
      } finally {
        keepAlive.stop()
      }

      recordUsage(usage)
    })
  }

  debugJsonTail(logger, "Non-streaming Messages result:", {
    value: response,
    tailLength: 400,
  })
  recordUsage(
    withCopilotCost(
      normalizeAnthropicUsage(response.usage),
      response.copilot_usage,
    ),
  )
  return c.json(response)
}

/** The session id a Messages request's usage is recorded under. The recorder
 *  and the request context both use this, so they can't disagree. */
export const resolveMessagesUsageSessionId = (
  payload: AnthropicMessagesPayload,
  fallbackSessionId?: string,
): string =>
  resolveTokenUsageSessionId(getMetadataSessionId(payload), fallbackSessionId)

const createCopilotUsageRecorder = (options: {
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string
  model: string
  payload: AnthropicMessagesPayload
}): ((usage: UsageTokens) => void) =>
  createCopilotTokenUsageRecorder({
    endpoint: options.endpoint,
    model: options.model,
    sessionId: resolveMessagesUsageSessionId(
      options.payload,
      options.fallbackSessionId,
    ),
  })

const getMetadataSessionId = (
  payload: AnthropicMessagesPayload,
): string | null => parseUserIdMetadata(payload.metadata?.user_id).sessionId

const parseAnthropicStreamEvent = (
  data: string,
): Record<string, unknown> | null => {
  try {
    return asRecord(JSON.parse(data)) ?? null
  } catch {
    return null
  }
}
