import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { cachedCodexModelCatalog } from "~/apps/codex/models-catalog"
import {
  getConfig,
  getPromptCacheRetention,
  isResponsesApiWebSearchEnabled,
} from "~/lib/config/config"
import { awaitApproval } from "~/lib/http/approval"
import { checkRateLimit } from "~/lib/http/rate-limit"
import { requestContext, setRequestUsage } from "~/lib/http/request-context"
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
import { generateRequestIdFromPayload, getUUID } from "~/lib/platform/utils"
import { state } from "~/lib/runtime-state/state"
import {
  createCopilotTokenUsageRecorder,
  normalizeResponsesUsage,
  resolveTokenUsageSessionId,
  type UsageTokens,
  withCopilotCost,
} from "~/lib/token-usage"
import { deriveUsageClient } from "~/lib/token-usage/client"
import {
  resolveContextWindow,
  responsesCacheTtlSeconds,
} from "~/lib/token-usage/request-meta"
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
  getLatestCompactionMessageIndex,
  getResponsesRequestOptions,
} from "./utils"

const logger = createHandlerLogger("responses-handler")

const RESPONSES_ENDPOINT = "/responses"

// Mapping validation adds one guarded branch to this protocol translation flow.
// eslint-disable-next-line complexity, max-lines-per-function
export const handleResponses = async (c: Context) => {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  payload.model = reverseId(payload.model)
  const mapping = resolveModelMapping({
    requestedModel: payload.model,
    rules: getConfig().modelMappings ?? [],
    models: state.models?.data ?? [],
    endpoint: RESPONSES_ENDPOINT,
  })
  if (mapping.status === "invalid-target") {
    return c.json(modelMappingErrorBody(mapping), 400)
  }
  payload.model = mapping.resolvedModel
  debugJson(logger, "Responses request payload:", payload)

  // The session is the client's prompt_cache_key (Codex sets one per
  // conversation); without it there is none. The interaction id sent upstream
  // stays per-request (subagent markers aren't supported here).
  const requestId = generateRequestIdFromPayload({ messages: payload.input })
  logger.debug("Generated request ID:", requestId)

  // The recorder and the request context share this one resolved id.
  const sessionId = resolveTokenUsageSessionId(
    undefined,
    payload.prompt_cache_key,
  )
  logger.debug("Extracted session ID:", sessionId)
  const interactionId = getUUID(requestId)
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "responses",
    sessionId,
    model: payload.model,
  })

  useFunctionApplyPatch(payload)

  removeUnsupportedTools(payload)

  if (!isResponsesApiWebSearchEnabled()) {
    removeWebSearchTool(payload)
  }

  // Read before compaction trims the input down to the latest item.
  const carriesCompaction =
    Array.isArray(payload.input)
    && getLatestCompactionMessageIndex(payload.input) !== undefined
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

  const hadContextManagement = payload.context_management !== undefined
  applyResponsesApiContextManagement(
    payload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )
  const maximalCompacts =
    !hadContextManagement && payload.context_management !== undefined

  // Copilot/OpenAI-Responses-specific prefix-cache retention. On this native
  // passthrough path we only fill it in when the client didn't set one — never
  // override an explicit client value. Opt-in via config; omitted otherwise.
  const promptCacheRetention = getPromptCacheRetention()
  if (promptCacheRetention && !payload.prompt_cache_retention) {
    payload.prompt_cache_retention = promptCacheRetention
  }

  recordResponsesUsageMeta({
    payload,
    sessionId,
    selectedModel,
    isCompact: carriesCompaction,
    maximalCompacts,
  })

  debugJson(logger, "Translated Responses payload:", payload)

  const { vision, initiator } = getResponsesRequestOptions(payload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponses(payload, {
    vision,
    initiator,
    requestId,
    sessionId: interactionId,
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

function recordResponsesUsageMeta(input: {
  payload: ResponsesPayload
  sessionId: string
  selectedModel: Model | undefined
  isCompact: boolean
  maximalCompacts: boolean
}): void {
  const { payload, sessionId, selectedModel, isCompact, maximalCompacts } =
    input
  const store = requestContext.getStore()
  if (!store) return

  const client = deriveUsageClient(store.usage.apiKeyLabel, store.userAgent)
  setRequestUsage({
    sessionId,
    model: payload.model,
    cacheTtlS: responsesCacheTtlSeconds(payload.prompt_cache_retention),
    cacheTtlRequested: false,
    isCompact,
    context: resolveContextWindow({
      client,
      model: selectedModel,
      longContext: false,
      maximalCompacts,
      codexCatalog:
        client === "codex" ?
          cachedCodexModelCatalog(state.models?.data ?? [])
        : undefined,
    }),
  })
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
