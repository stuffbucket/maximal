import type { Context } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { pickCopilotVariantId, reverseId } from "~/lib/anthropic-id-rewrite"
import { type AnthropicMessagesPayload } from "~/lib/anthropic-types"
import { awaitApproval } from "~/lib/approval"
import { COMPACT_REQUEST } from "~/lib/compact"
import { getSmallModel, isMessagesApiEnabled } from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getRootSessionId } from "~/lib/utils"

import {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
} from "./api-flows"
import {
  getCompactType,
  mergeToolResultForClaude,
  sanitizeIdeTools,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"
import { handleWithWebToolsAgent, splitWebTools } from "./web-tools"

const logger = createHandlerLogger("messages-handler")

// Reverse the dash-date sentinel form (added by /v1/models for Claude
// Desktop's normalizer) back to Copilot's original dot-form, then route
// to the variant SKU when the inbound request set effort or requested
// the 1M-context beta.
function resolveCopilotModel(
  c: Context,
  payload: AnthropicMessagesPayload,
): string {
  const reversed = reverseId(payload.model)
  const longContext =
    c.req.header("anthropic-beta")?.includes("context-1m-2025-08-07") ?? false
  return pickCopilotVariantId(
    reversed,
    { effort: payload.output_config?.effort, longContext },
    state.models?.data.map((m) => m.id) ?? [],
  )
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  debugJson(logger, "Anthropic request payload:", anthropicPayload)

  anthropicPayload.model = resolveCopilotModel(c, anthropicPayload)

  sanitizeIdeTools(anthropicPayload)

  // Detect Anthropic-server-side web tools (web_search_20250305,
  // web_fetch_20250910). Copilot rejects these tool types; the agent
  // flow strips them, substitutes client-side shims, and drives a
  // multi-turn loop synthesizing the server-side result blocks back to
  // the client. Splitting before the rest of preprocessing means later
  // steps see only the cleaned tools list.
  const webToolPolicy = splitWebTools(anthropicPayload)

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  const sessionId = getRootSessionId(anthropicPayload, c)
  logger.debug("Extracted session ID:", sessionId)

  // claude code and opencode compact / auto-continue detection
  const compactType = getCompactType(anthropicPayload)

  // fix claude code 2.0.28+ warmup request consume premium request, forcing small model if no tools are used
  // set "CLAUDE_CODE_SUBAGENT_MODEL": "you small model" also can avoid this
  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (anthropicBeta && noTools && compactType === 0) {
    anthropicPayload.model = getSmallModel()
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

  const requestId = generateRequestIdFromPayload(anthropicPayload, sessionId)
  logger.debug("Generated request ID:", requestId)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const selectedModel = findEndpointModel(anthropicPayload.model)
  anthropicPayload.model = selectedModel?.id ?? anthropicPayload.model

  if (webToolPolicy.declarations.length > 0) {
    return await handleWithWebToolsAgent({
      c,
      payload: anthropicPayload,
      options: { subagentMarker, requestId, sessionId, compactType, logger },
      policy: webToolPolicy,
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
