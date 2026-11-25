import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { admitChat, createBudgetUsageFinisher } from "~/lib/budget/runtime"
import { getConfig } from "~/lib/config/config"
import { awaitApproval } from "~/lib/http/approval"
import { checkRateLimit } from "~/lib/http/rate-limit"
import { setRequestUsage } from "~/lib/http/request-context"
import { asRecord, readUsage } from "~/lib/http/untrusted-frame"
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
  normalizeOpenAIUsage,
  prepareCopilotTokenUsageEvent,
  resolveTokenUsageSessionId,
  type UsageTokens,
  withCopilotCost,
} from "~/lib/token-usage"
import { responsesCacheTtlSeconds } from "~/lib/token-usage/request-meta"
import { isNonStreaming } from "~/routes/streaming-predicates"
import {
  createChatCompletions,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")

const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"

function createUsageFinisher(
  hold: Parameters<typeof createBudgetUsageFinisher>[0],
  options: Parameters<typeof prepareCopilotTokenUsageEvent>[0],
) {
  return createBudgetUsageFinisher(hold, (usage) =>
    prepareCopilotTokenUsageEvent(options, usage),
  )
}

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

  const advertisedMaxTokens = payload.max_tokens
  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    debugJson(logger, "Set max_tokens to:", payload.max_tokens)
  }

  const hold = await admitChat("chat_completions", {
    model: payload.model,
    maxTokens: advertisedMaxTokens,
  })
  const requestId = generateRequestIdFromPayload(payload)

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
  const usageOptions = {
    endpoint: "chat_completions" as const,
    sessionId: usageSessionId,
    model: payload.model,
  }
  const finishUsage = createUsageFinisher(hold, usageOptions)

  let response: Awaited<ReturnType<typeof createChatCompletions>>
  try {
    response = await createChatCompletions(payload, {
      requestId,
      sessionId: interactionId,
    })
  } catch (error) {
    await hold.unreconcile("usage-missing")
    throw error
  }

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response:", response)
    await finishUsage(
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

    try {
      for await (const chunk of response) {
        debugJson(logger, "Streaming chunk:", chunk)
        const parsedChunk = parseChatCompletionChunk(chunk)
        const chunkUsage = readUsage(parsedChunk)
        if (chunkUsage) {
          usage = withCopilotCost(
            normalizeOpenAIUsage(chunkUsage),
            asRecord(asRecord(parsedChunk)?.copilot_usage),
          )
        }
        await stream.writeSSE(chunk as SSEMessage)
      }
    } catch (error) {
      await finishUsage(usage, "stream-interrupted")
      throw error
    }
    await finishUsage(usage)
  })
}

const parseChatCompletionChunk = (chunk: unknown): unknown => {
  const data = asRecord(chunk)?.data
  if (typeof data !== "string" || !data || data === "[DONE]") {
    return null
  }

  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}
