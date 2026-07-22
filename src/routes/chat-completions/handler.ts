import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/http/approval"
import { checkRateLimit } from "~/lib/http/rate-limit"
import { reverseId } from "~/lib/models/anthropic-id-rewrite"
import { resolveModelProfile } from "~/lib/models/model-profile"
import {
  createHandlerLogger,
  debugJson,
  debugJsonTail,
} from "~/lib/platform/logger"
import {
  generateRequestIdFromPayload,
  getUUID,
  isNullish,
} from "~/lib/platform/utils"
import { state } from "~/lib/runtime-state/state"
import {
  createCopilotTokenUsageRecorder,
  normalizeOpenAIUsage,
  type UsageTokens,
  withCopilotCost,
} from "~/lib/token-usage"
import { isNonStreaming } from "~/routes/streaming-predicates"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  payload.model = reverseId(payload.model)
  debugJsonTail(logger, "Request payload:", { value: payload, tailLength: 400 })

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  if (selectedModel?.id === "gpt-5.4") {
    return c.json(
      {
        error: {
          message: "Please use `/v1/responses` or `/v1/messages` API",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    // Preserve the historical "absent → leave unset" behavior: only fill in a
    // POSITIVE limit. profile.maxOutputTokens defaults to 0 when the catalog
    // carries no limit, and sending max_tokens: 0 would differ from the old
    // `?? undefined` behavior — so treat 0 as "omit".
    const maxOutputTokens =
      selectedModel ? resolveModelProfile(selectedModel).maxOutputTokens : 0
    payload = {
      ...payload,
      max_tokens: maxOutputTokens > 0 ? maxOutputTokens : undefined,
    }
    debugJson(logger, "Set max_tokens to:", payload.max_tokens)
  }

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload(payload)
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "chat_completions",
    fallbackSessionId: sessionId,
    model: payload.model,
  })

  const response = await createChatCompletions(payload, {
    requestId,
    sessionId,
  })

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response:", response)
    recordUsage(
      withCopilotCost(
        normalizeOpenAIUsage(response.usage),
        response.copilot_usage,
      ),
    )
    return c.json(response)
  }

  logger.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}

    for await (const chunk of response) {
      debugJson(logger, "Streaming chunk:", chunk)
      const parsedChunk = parseChatCompletionChunk(chunk)
      if (parsedChunk?.usage) {
        usage = normalizeOpenAIUsage(parsedChunk.usage)
      }
      await stream.writeSSE(chunk as SSEMessage)
    }

    recordUsage(usage)
  })
}

const parseChatCompletionChunk = (
  chunk: unknown,
): ChatCompletionChunk | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") {
    return null
  }

  try {
    // casts-keep: trusted Copilot SSE chunk; translator tolerates missing fields
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    return null
  }
}
