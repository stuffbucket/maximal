import type { Context } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { admitChat, gateChat } from "~/lib/budget/runtime"
import { anthropicMessagesConfig, getConfig } from "~/lib/config/config"
import { awaitApproval } from "~/lib/http/approval"
import { checkRateLimit } from "~/lib/http/rate-limit"
import { requestContext, setRequestUsage } from "~/lib/http/request-context"
import {
  pickCopilotVariantId,
  reverseId,
} from "~/lib/models/anthropic-id-rewrite"
import { resolveAnthropicModelAlias } from "~/lib/models/anthropic-model-aliases"
import { type AnthropicMessagesPayload } from "~/lib/models/anthropic-types"
import { COMPACT_REQUEST, type CompactType } from "~/lib/models/compact"
import { modelMappingErrorBody } from "~/lib/models/model-mapping"
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
import {
  createCopilotTokenUsageRecorder,
  type TokenUsageEndpoint,
} from "~/lib/token-usage"
import { deriveUsageClient } from "~/lib/token-usage/client"
import {
  anthropicCacheTtlSeconds,
  resolveContextWindow,
  responsesCacheTtlSeconds,
} from "~/lib/token-usage/request-meta"

import {
  type FlowBaseOptions,
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
  resolveMessagesUsageSessionId,
} from "./api-flows"
import {
  shouldUseMessagesApi,
  shouldUseResponsesApi,
} from "./endpoint-selection"
import {
  getCompactType,
  mergeToolResultForClaude,
  sanitizeIdeTools,
  stripUnsupportedClaudeCodeTools,
  stripUnsupportedTopLevelAnthropicFields,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import { planServerToolsForRequest } from "./server-tools/for-request"
import { type ServerToolPlan } from "./server-tools/types"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"
import { isWarmupRequest, respondToWarmup } from "./warmup"
import { handleWithWebToolsAgent, splitWebTools } from "./web-tools"
import { type WebToolPolicy } from "./web-tools/rewriter"
import {
  selectTurnTransport,
  type TransportPolicy,
  type TurnTransport,
} from "./web-tools/transport"

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
  /** The server-tools loop sends every turn over Responses or chat
   *  completions, not native Messages. */
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
    // On the Responses or chat completions transport the request goes
    // upstream with no retention set: the automatic-cache rule.
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

/** The usage endpoint a loop turn on `transport` is recorded under. */
const USAGE_ENDPOINT: Record<TurnTransport, TokenUsageEndpoint> = {
  messages: "messages",
  responses: "responses",
  chat: "chat_completions",
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
  const config = getConfig()
  const mapping = resolveAnthropicModelAlias({
    requestedModel: reverseId(payload.model),
    rules: config.modelMappings ?? [],
    config: anthropicMessagesConfig(config),
    models: state.models?.data ?? [],
  })
  if (mapping.status === "invalid-target") {
    return c.json(modelMappingErrorBody(mapping), 400)
  }
  payload.model = resolveCopilotVariant(c, payload, mapping.resolvedModel)
  return null
}

/** How a request's server tools take it through the loop. */
interface ServerToolLoop {
  plan: ServerToolPlan
  /** Any server tool was planned, so the loop handles the request. */
  active: boolean
  transportPolicy: TransportPolicy | undefined
  transport: TurnTransport
}

/**
 * The server tools this request offers: the web tools the client declared,
 * plus whatever plugins offer on every agent turn. Any of them sends the
 * request through the loop. A request that offers an `always` tool goes over
 * native Messages where the model allows it (thinking, cache_control and
 * context editing survive); web tools alone keep their own transport.
 */
function planServerToolLoop(input: {
  c: Context
  payload: AnthropicMessagesPayload
  webPolicy: WebToolPolicy
  sessionId: string | undefined
  compactType: CompactType
  selectedModel: Model | undefined
}): ServerToolLoop {
  const plan = planServerToolsForRequest({
    payload: input.payload,
    webPolicy: input.webPolicy,
    sessionId: input.sessionId,
    compact: input.compactType !== 0,
    signal: input.c.req.raw.signal,
    logger,
  })
  const transportPolicy: TransportPolicy | undefined =
    plan.offersAlways ? { nativeMessages: true } : undefined
  return {
    plan,
    active: plan.tools.size > 0,
    transportPolicy,
    transport: selectTurnTransport(input.selectedModel, transportPolicy),
  }
}

async function handleViaServerToolLoop(
  loop: ServerToolLoop,
  input: {
    c: Context
    payload: AnthropicMessagesPayload
    options: FlowBaseOptions
    webPolicy: WebToolPolicy
    selectedModel: Model | undefined
  },
): Promise<Response> {
  const { payload, options } = input
  return await handleWithWebToolsAgent({
    c: input.c,
    payload,
    options,
    policy: input.webPolicy,
    selectedModel: input.selectedModel,
    serverTools: loop.plan,
    transportPolicy: loop.transportPolicy,
    // Requests that only carry web tools have never recorded their usage
    // here; ones the loop took over from the ordinary flows must.
    recordUsage:
      loop.plan.offersAlways ?
        createCopilotTokenUsageRecorder({
          endpoint: USAGE_ENDPOINT[loop.transport],
          fallbackSessionId: options.sessionId,
          model: payload.model,
          sessionId: resolveMessagesUsageSessionId(payload, options.sessionId),
        })
      : undefined,
  })
}

/**
 * Claude Code 2.0.28+ fires a tool-less "Warmup" request on startup (and
 * around subagent spawns) that today round-trips upstream (~4s p50). When
 * the request precisely matches the warmup shape, short-circuit it with a
 * canned local response — no upstream call, no model mutation. The detector
 * errs tight (a false positive would canned-respond to a real request); we
 * also require the anthropic-beta header (warmups always carry it) to be
 * extra conservative. Non-warmup no-tool turns fall through untouched.
 */
function respondIfWarmup(
  c: Context,
  payload: AnthropicMessagesPayload,
  request: { anthropicBeta: string | undefined; compactType: CompactType },
): Response | undefined {
  const noTools = !payload.tools || payload.tools.length === 0
  if (!request.anthropicBeta || !noTools || request.compactType !== 0) {
    return undefined
  }
  if (isWarmupRequest(payload)) {
    logger.debug("warmup short-circuit", {
      model: payload.model,
      stream: payload.stream ?? false,
    })
    return respondToWarmup(c, payload)
  }
  debugLazy(logger, () => [
    "no-tool beta request, not warmup-shaped",
    { msgCount: payload.messages.length },
  ])
  return undefined
}

// eslint-disable-next-line max-lines-per-function
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

  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  const warmup = respondIfWarmup(c, anthropicPayload, {
    anthropicBeta,
    compactType,
  })
  if (warmup) return warmup

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

  const loop = planServerToolLoop({
    c,
    payload: anthropicPayload,
    webPolicy: webToolPolicy,
    sessionId,
    compactType,
    selectedModel,
  })

  recordMessagesUsageMeta({
    c,
    payload: anthropicPayload,
    sessionId: resolveMessagesUsageSessionId(anthropicPayload, sessionId),
    selectedModel,
    isCompact: compactType === COMPACT_REQUEST,
    viaWebTools: loop.active && loop.transport !== "messages",
  })

  const budgetRequest = {
    model: anthropicPayload.model,
    maxTokens: anthropicPayload.max_tokens,
  }
  if (loop.active) {
    // One server-tool request may make several upstream calls. Until that loop
    // can settle one durable hold against all turns atomically, gate it without
    // reserving a hold that no single turn owns.
    await gateChat("messages", budgetRequest)
    return await handleViaServerToolLoop(loop, {
      c,
      payload: anthropicPayload,
      options: { subagentMarker, requestId, sessionId, compactType, logger },
      webPolicy: webToolPolicy,
      selectedModel,
    })
  }

  const hold = await admitChat("messages", budgetRequest)
  if (shouldUseMessagesApi(selectedModel)) {
    return await handleWithMessagesApi(c, anthropicPayload, {
      anthropicBetaHeader: anthropicBeta,
      hold,
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
      hold,
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      compactType,
      logger,
    })
  }

  return await handleWithChatCompletions(c, anthropicPayload, {
    hold,
    subagentMarker,
    requestId,
    sessionId,
    compactType,
    logger,
  })
}
