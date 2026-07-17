import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import {
  getConfig,
  getPromptCacheRetention,
  isResponsesApiWebSearchEnabled,
} from "~/lib/config/config"
import { awaitApproval } from "~/lib/http/approval"
import { checkRateLimit } from "~/lib/http/rate-limit"
import { reverseId } from "~/lib/models/anthropic-id-rewrite"
import { resolveModelProfile } from "~/lib/models/model-profile"
import {
  createHandlerLogger,
  debugJson,
  debugJsonTail,
} from "~/lib/platform/logger"
import { generateRequestIdFromPayload, getUUID } from "~/lib/platform/utils"
import { state } from "~/lib/runtime-state/state"
import {
  createCopilotTokenUsageRecorder,
  normalizeResponsesUsage,
  type UsageTokens,
  withCopilotCost,
} from "~/lib/token-usage"
import { isAsyncIterable } from "~/routes/streaming-predicates"
import {
  createResponses as defaultCreateResponses,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

// Test-only DI shim. Lets tests/responses-handler.test.ts inject a stub
// for createResponses without using process-wide mock.module on
// "~/services/copilot/create-responses" — which would leak the stub
// to every test file that statically imports createResponses later in
// the same `bun test` process (Bun captures ESM bindings at module
// load time; later restoration via mock.module doesn't repoint already-
// resolved bindings). Production callers see defaultCreateResponses.
let createResponses: typeof defaultCreateResponses = defaultCreateResponses

export function __setCreateResponsesForTests(
  impl: typeof defaultCreateResponses,
): void {
  createResponses = impl
}

export function __resetCreateResponsesForTests(): void {
  createResponses = defaultCreateResponses
}

import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesRequestOptions,
} from "./utils"

const logger = createHandlerLogger("responses-handler")

const RESPONSES_ENDPOINT = "/responses"

export const handleResponses = async (c: Context) => {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  payload.model = reverseId(payload.model)
  debugJson(logger, "Responses request payload:", payload)

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload({ messages: payload.input })
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "responses",
    fallbackSessionId: sessionId,
    model: payload.model,
  })

  useFunctionApplyPatch(payload)

  removeUnsupportedTools(payload)

  if (!isResponsesApiWebSearchEnabled()) {
    removeWebSearchTool(payload)
  }

  compactInputByLatestCompaction(payload)

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  if (!supportsResponses) {
    return c.json(
      {
        error: {
          message:
            "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  applyResponsesApiContextManagement(
    payload,
    selectedModel ?
      resolveModelProfile(selectedModel).maxPromptTokens
    : undefined,
  )

  // Copilot/OpenAI-Responses-specific prefix-cache retention. On this native
  // passthrough path we only fill it in when the client didn't set one — never
  // override an explicit client value. Opt-in via config; omitted otherwise.
  const promptCacheRetention = getPromptCacheRetention()
  if (promptCacheRetention && !payload.prompt_cache_retention) {
    payload.prompt_cache_retention = promptCacheRetention
  }

  debugJson(logger, "Translated Responses payload:", payload)

  const { vision, initiator } = getResponsesRequestOptions(payload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponses(payload, {
    vision,
    initiator,
    requestId,
    sessionId: sessionId,
  })

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")
    return streamSSE(c, async (stream) => {
      const idTracker = createStreamIdTracker()
      let usage: UsageTokens = {}

      for await (const chunk of response) {
        debugJson(logger, "Responses stream chunk:", chunk)
        const parsedEvent = parseResponsesStreamEvent(chunk)
        if (
          parsedEvent?.type === "response.completed"
          || parsedEvent?.type === "response.failed"
          || parsedEvent?.type === "response.incomplete"
        ) {
          usage = normalizeResponsesUsage(parsedEvent.response.usage)
        }

        const processedData = fixStreamIds(
          (chunk as { data?: string }).data ?? "",
          (chunk as { event?: string }).event,
          idTracker,
        )

        await stream.writeSSE({
          id: (chunk as { id?: string }).id,
          event: (chunk as { event?: string }).event,
          data: processedData,
        })
      }

      recordUsage(usage)
    })
  }

  debugJsonTail(logger, "Forwarding native Responses result:", {
    value: response,
    tailLength: 400,
  })
  recordUsage(
    withCopilotCost(
      normalizeResponsesUsage((response as ResponsesResult).usage),
      (response as ResponsesResult).copilot_usage,
    ),
  )
  return c.json(response as ResponsesResult)
}

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const parseResponsesStreamEvent = (
  chunk: unknown,
): ResponseStreamEvent | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") {
    return null
  }

  try {
    return JSON.parse(data) as ResponseStreamEvent
  } catch {
    return null
  }
}

const useFunctionApplyPatch = (payload: ResponsesPayload): void => {
  const config = getConfig()
  const useFunctionApplyPatch = config.useFunctionApplyPatch ?? true
  if (useFunctionApplyPatch) {
    logger.debug("Using function tool apply_patch for responses")
    if (Array.isArray(payload.tools)) {
      const toolsArr = payload.tools
      for (let i = 0; i < toolsArr.length; i++) {
        const t = toolsArr[i]
        if (t.type === "custom" && t.name === "apply_patch") {
          toolsArr[i] = {
            type: "function",
            name: t.name,
            description: "Use the `apply_patch` tool to edit files",
            parameters: {
              type: "object",
              properties: {
                input: {
                  type: "string",
                  description: "The entire contents of the apply_patch command",
                },
              },
              required: ["input"],
            },
            strict: false,
          }
        }
      }
    }
  }
}

const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}

const COPILOT_UNSUPPORTED_TOOL_TYPES = new Set(["image_generation"])

export const removeUnsupportedTools = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  const dropped: Array<string> = []
  payload.tools = payload.tools.filter((t) => {
    const type = t.type as string
    if (COPILOT_UNSUPPORTED_TOOL_TYPES.has(type)) {
      dropped.push(type)
      return false
    }
    return true
  })
  if (dropped.length > 0) {
    logger.debug("Removed unsupported tools:", dropped)
  }
}
