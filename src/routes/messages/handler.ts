import type { Context } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { getConfig, isMessagesApiEnabled } from "~/lib/config/config"
import { awaitApproval } from "~/lib/http/approval"
import { checkRateLimit } from "~/lib/http/rate-limit"
import { requestContext, setRequestUsage } from "~/lib/http/request-context"
import {
  pickCopilotVariantId,
  reverseId,
} from "~/lib/models/anthropic-id-rewrite"
import { type AnthropicMessagesPayload } from "~/lib/models/anthropic-types"
import { COMPACT_REQUEST } from "~/lib/models/compact"
import {
  modelMappingErrorBody,
  resolveModelMapping,
} from "~/lib/models/model-mapping"
import { findEndpointModel } from "~/lib/models/models"
import {
  createHandlerLogger,
  debugJson,
  debugLazy,
} from "~/lib/platform/logger"
import {
  generateRequestIdFromPayload,
  getRootSessionId,
} from "~/lib/platform/utils"
import { state } from "~/lib/runtime-state/state"
import { deriveUsageClient } from "~/lib/token-usage/client"
import {
  anthropicCacheTtlSeconds,
  resolveContextWindow,
  responsesCacheTtlSeconds,
} from "~/lib/token-usage/request-meta"

import {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
  resolveMessagesUsageSessionId,
} from "./api-flows"
import {
  getCompactType,
  mergeToolResultForClaude,
  sanitizeIdeTools,
  stripUnsupportedClaudeCodeTools,
  stripUnsupportedTopLevelAnthropicFields,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"
import { isWarmupRequest, respondToWarmup } from "./warmup"
import { handleWithWebToolsAgent, splitWebTools } from "./web-tools"

const logger = createHandlerLogger("messages-handler")

// Reverse the dash-date sentinel form (added by /v1/models for Claude
// Desktop's normalizer) back to Copilot's original dot-form, then route
// to the variant SKU when the inbound request set effort or requested
// the 1M-context beta.
function resolveCopilotVariant(
  c: Context,
  payload: AnthropicMessagesPayload,
  model: string,
): string {
  const longContext =
    c.req.header("anthropic-beta")?.includes("context-1m-2025-08-07") ?? false
  return pickCopilotVariantId(
    model,
    { effort: payload.output_config?.effort, longContext },
    state.models?.data.map((candidate) => candidate.id) ?? [],
  )
}

/** Fill the request's usage metadata from the client's own payload and headers. */
function recordMessagesUsageMeta(input: {
  c: Context
  payload: AnthropicMessagesPayload
  sessionId: string
  selectedModel: Model | undefined
  isCompact: boolean
  viaWebTools: boolean
}): void {
  const { c, payload, sessionId, selectedModel, isCompact, viaWebTools } = input
  const store = requestContext.getStore()
  if (!store) return

  const cacheTtlS = anthropicCacheTtlSeconds(payload)
  const client = deriveUsageClient(store.usage.apiKeyLabel, store.userAgent)
  const longContext =
    c.req.header("anthropic-beta")?.includes("context-1m-2025-08-07") ?? false
  setRequestUsage({
    sessionId,
    model: payload.model,
    // Web tools always go upstream over Responses or chat completions (never
    // native Messages) with no retention set: the automatic-cache rule.
    cacheTtlS: viaWebTools ? responsesCacheTtlSeconds(undefined) : cacheTtlS,
    // The lifetime came from the client when it marked anything for caching.
    cacheTtlRequested: !viaWebTools && cacheTtlS > 0,
    isCompact,
    context: resolveContextWindow({
      client,
      model: selectedModel,
      longContext,
    }),
  })
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const NIL_UUID = "00000000-0000-0000-0000-000000000000"

function resolveRequestId(
  c: Context,
  payload: AnthropicMessagesPayload,
  sessionId: string | undefined,
): string {
  const promptId = c.req.header("x-claude-code-prompt-id")?.trim().toLowerCase()
  if (promptId && promptId !== NIL_UUID && UUID_PATTERN.test(promptId)) {
    return promptId
  }
  return generateRequestIdFromPayload(payload, sessionId)
}

/**
 * Apply a configured model mapping, then pick the Copilot variant. Returns
 * the 400 to send when a mapping targets a model that isn't available.
 */
function applyModelMapping(
  c: Context,
  payload: AnthropicMessagesPayload,
): Response | null {
  const mapping = resolveModelMapping({
    requestedModel: reverseId(payload.model),
    rules: getConfig().modelMappings ?? [],
    models: state.models?.data ?? [],
    endpoint: null,
  })
  if (mapping.status === "invalid-target") {
    return c.json(modelMappingErrorBody(mapping), 400)
  }
  payload.model = resolveCopilotVariant(c, payload, mapping.resolvedModel)
  return null
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  stripUnsupportedTopLevelAnthropicFields(anthropicPayload)
  debugJson(logger, "Anthropic request payload:", anthropicPayload)

  const mappingError = applyModelMapping(c, anthropicPayload)
  if (mappingError) return mappingError

  sanitizeIdeTools(anthropicPayload)
  stripUnsupportedClaudeCodeTools(anthropicPayload, c.req.header("user-agent"))

  // Detect Anthropic-server-side web tools (web_search_20250305,
  // web_fetch_20250910). Copilot rejects these tool types; the agent
  // flow strips them, substitutes client-side shims, and drives a
  // multi-turn loop synthesizing the server-side result blocks back to
  // the client. Splitting before the rest of preprocessing means later
  // steps see only the cleaned tools list.
  const webToolPolicy = splitWebTools(anthropicPayload)

  const sessionId = getRootSessionId(anthropicPayload, c)
  logger.debug("Extracted session ID:", sessionId)

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload, {
    requestClass: c.req.header("x-claude-code-request-class"),
    agentType: c.req.header("x-claude-code-agent-type"),
    sessionId,
  })
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  // claude code and opencode compact / auto-continue detection
  const compactType = getCompactType(
    anthropicPayload,
    c.req.header("x-claude-code-compaction"),
  )

  // Claude Code 2.0.28+ fires a tool-less "Warmup" request on startup (and
  // around subagent spawns) that today round-trips upstream (~4s p50). When
  // the request precisely matches the warmup shape, short-circuit it with a
  // canned local response — no upstream call, no model mutation. The detector
  // errs tight (a false positive would canned-respond to a real request); we
  // also require the anthropic-beta header (warmups always carry it) to be
  // extra conservative. Non-warmup no-tool turns fall through untouched.
  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (anthropicBeta && noTools && compactType === 0) {
    if (isWarmupRequest(anthropicPayload)) {
      logger.debug("warmup short-circuit", {
        model: anthropicPayload.model,
        stream: anthropicPayload.stream ?? false,
      })
      return respondToWarmup(c, anthropicPayload)
    }
    debugLazy(logger, () => [
      "no-tool beta request, not warmup-shaped",
      { msgCount: anthropicPayload.messages.length },
    ])
  }

  if (compactType) {
    logger.debug("Compact request type:", compactType)
  }

  stripToolReferenceTurnBoundary(anthropicPayload)

  // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
  // (caused by skill invocations, edit hooks, plan or to do reminders)
  // e.g. {"role":"user","content":[{"type":"tool_result","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
  // not only for claude, but also for opencode
  // compact requests still run this processing, except for the final compact message itself
  mergeToolResultForClaude(anthropicPayload, {
    skipLastMessage: compactType === COMPACT_REQUEST,
  })

  const requestId = resolveRequestId(c, anthropicPayload, sessionId)
  logger.debug("Generated request ID:", requestId)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const selectedModel = findEndpointModel(anthropicPayload.model)
  anthropicPayload.model = selectedModel?.id ?? anthropicPayload.model
  recordMessagesUsageMeta({
    c,
    payload: anthropicPayload,
    sessionId: resolveMessagesUsageSessionId(anthropicPayload, sessionId),
    selectedModel,
    isCompact: compactType === COMPACT_REQUEST,
    viaWebTools: webToolPolicy.declarations.length > 0,
  })

  if (webToolPolicy.declarations.length > 0) {
    return await handleWithWebToolsAgent({
      c,
      payload: anthropicPayload,
      options: { subagentMarker, requestId, sessionId, compactType, logger },
      policy: webToolPolicy,
      selectedModel,
    })
  }

  if (shouldUseMessagesApi(selectedModel)) {
    return await handleWithMessagesApi(c, anthropicPayload, {
      anthropicBetaHeader: anthropicBeta,
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      compactType,
      logger,
    })
  }

  if (shouldUseResponsesApi(selectedModel)) {
    return await handleWithResponsesApi(c, anthropicPayload, {
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      compactType,
      logger,
    })
  }

  return await handleWithChatCompletions(c, anthropicPayload, {
    subagentMarker,
    requestId,
    sessionId,
    compactType,
    logger,
  })
}

const RESPONSES_ENDPOINT = "/responses"
const MESSAGES_ENDPOINT = "/v1/messages"

const shouldUseResponsesApi = (selectedModel: Model | undefined): boolean => {
  return (
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false
  )
}

const shouldUseMessagesApi = (selectedModel: Model | undefined): boolean => {
  const useMessagesApi = isMessagesApiEnabled()
  if (!useMessagesApi) {
    return false
  }
  return (
    selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
  )
}
