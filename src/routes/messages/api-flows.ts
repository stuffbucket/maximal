import type { ConsolaInstance } from "consola"
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type { Model } from "~/services/copilot/get-models"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "~/lib/anthropic-types"
import { getPromptCacheRetention } from "~/lib/config"
import { debugJson, debugJsonTail, debugLazy } from "~/lib/logger"
import {
  createCopilotTokenUsageRecorder,
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  normalizeResponsesUsage,
  type TokenUsageEndpoint,
  type UsageTokens,
  withCopilotCost,
} from "~/lib/token-usage"
import { parseUserIdMetadata } from "~/lib/utils"
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
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { prepareMessagesApiPayload } from "./preprocess"
import { emitStreamError } from "./stream-error"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export interface FlowBaseOptions {
  logger: ConsolaInstance
  subagentMarker?: SubagentMarker | null
  requestId: string
  sessionId?: string
  compactType?: CompactType
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

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        if (chunk.usage) {
          usage = normalizeOpenAIUsage(chunk.usage)
        }
        const events = translateChunkToAnthropicEvents(chunk, streamState)

        for (const event of events) {
          const eventData = JSON.stringify(event)
          debugLazy(logger, () => ["Translated Anthropic event:", eventData])
          await stream.writeSSE({
            event: event.type,
            data: eventData,
          })
        }
      }
    } catch (error) {
      await emitStreamError(stream, logger, { error, flow: "chat_completions" })
    }

    recordUsage(usage)
  })
}

export const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: ResponsesFlowOptions,
) => {
  const { logger, selectedModel, ...requestOptions } = options

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

  // Copilot/OpenAI-Responses-specific prefix-cache retention. Opt-in via
  // config; omitted otherwise so behavior is unchanged. Set on the built
  // payload here (not in the pure translator). A future non-Copilot provider
  // path won't use this. Safe to enable: create-responses.ts strips + retries
  // once if a specific endpoint 400s on the param.
  const promptCacheRetention = getPromptCacheRetention()
  if (promptCacheRetention) {
    responsesPayload.prompt_cache_retention = promptCacheRetention
  }

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
      const streamState = createResponsesStreamState()
      let usage: UsageTokens = {}

      try {
        for await (const chunk of response) {
          const eventName = chunk.event
          if (eventName === "ping") {
            await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
            continue
          }

          const data = chunk.data
          if (!data) {
            continue
          }

          debugLazy(logger, () => ["Responses raw stream event:", data])

          const responseEvent = JSON.parse(data) as ResponseStreamEvent
          if (
            responseEvent.type === "response.completed"
            || responseEvent.type === "response.failed"
            || responseEvent.type === "response.incomplete"
          ) {
            usage = normalizeResponsesUsage(responseEvent.response.usage)
          }

          const events = translateResponsesStreamEvent(
            responseEvent,
            streamState,
          )
          for (const event of events) {
            const eventData = JSON.stringify(event)
            debugLazy(logger, () => ["Translated Anthropic event:", eventData])
            await stream.writeSSE({
              event: event.type,
              data: eventData,
            })
          }

          if (streamState.messageCompleted) {
            logger.debug("Message completed, ending stream")
            break
          }
        }
      } catch (error) {
        await emitStreamError(stream, logger, { error, flow: "responses" })
        recordUsage(usage)
        return
      }

      if (!streamState.messageCompleted) {
        logger.warn(
          "Responses stream ended without completion; sending error event",
        )
        const errorEvent = buildErrorEvent(
          "Responses stream ended without completion",
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
          if (parsedEvent?.type === "message_start") {
            usage = mergeAnthropicUsage(
              usage,
              normalizeAnthropicUsage(parsedEvent.message.usage),
            )
          } else if (parsedEvent?.type === "message_delta") {
            usage = mergeAnthropicUsage(
              usage,
              normalizeAnthropicUsage(parsedEvent.usage),
            )
          }
          await stream.writeSSE({
            event: eventName,
            data,
          })
        }
      } catch (error) {
        await emitStreamError(stream, logger, { error, flow: "messages" })
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

export const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const createCopilotUsageRecorder = (options: {
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string
  model: string
  payload: AnthropicMessagesPayload
}): ((usage: UsageTokens) => void) =>
  createCopilotTokenUsageRecorder({
    endpoint: options.endpoint,
    fallbackSessionId: options.fallbackSessionId,
    model: options.model,
    sessionId: getMetadataSessionId(options.payload),
  })

const getMetadataSessionId = (
  payload: AnthropicMessagesPayload,
): string | null => parseUserIdMetadata(payload.metadata?.user_id).sessionId

const parseAnthropicStreamEvent = (
  data: string,
): AnthropicStreamEventData | null => {
  try {
    return JSON.parse(data) as AnthropicStreamEventData
  } catch {
    return null
  }
}
