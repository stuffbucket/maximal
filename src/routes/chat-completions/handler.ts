import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { getConfig } from "~/lib/config/config"
import { awaitApproval } from "~/lib/http/approval"
import { checkRateLimit } from "~/lib/http/rate-limit"
import { setRequestUsage } from "~/lib/http/request-context"
import { reverseId } from "~/lib/models/anthropic-id-rewrite"
import {
  modelMappingErrorBody,
  resolveModelMapping,
} from "~/lib/models/model-mapping"
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
  resolveTokenUsageSessionId,
  type UsageTokens,
  withCopilotCost,
} from "~/lib/token-usage"
import { responsesCacheTtlSeconds } from "~/lib/token-usage/request-meta"
import { isNonStreaming } from "~/routes/streaming-predicates"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")

const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  payload.model = reverseId(payload.model)
  const mapping = resolveModelMapping({
    requestedModel: payload.model,
    rules: getConfig().modelMappings ?? [],
    models: state.models?.data ?? [],
    endpoint: CHAT_COMPLETIONS_ENDPOINT,
  })
  if (mapping.status === "invalid-target") {
    return c.json(modelMappingErrorBody(mapping), 400)
  }
  payload.model = mapping.resolvedModel
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
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    debugJson(logger, "Set max_tokens to:", payload.max_tokens)
  }

  const requestId = generateRequestIdFromPayload(payload)
  logger.debug("Generated request ID:", requestId)

  // Chat completions carries no conversation id, so the recorded session is
  // empty unless the client sent x-session-affinity; the interaction id sent
  // upstream stays per-request. The recorder and the request context share
  // one resolved id so they can't disagree.
  const interactionId = getUUID(requestId)
  const usageSessionId = resolveTokenUsageSessionId(undefined, "")
  setRequestUsage({
    sessionId: usageSessionId,
    model: payload.model,
    cacheTtlS: responsesCacheTtlSeconds(undefined),
    cacheTtlRequested: false,
  })
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "chat_completions",
    sessionId: usageSessionId,
    model: payload.model,
  })

  const response = await createChatCompletions(payload, {
    requestId,
    sessionId: interactionId,
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
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    return null
  }
}
