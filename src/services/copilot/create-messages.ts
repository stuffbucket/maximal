import consola from "consola"
import { events } from "fetch-event-stream"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/models/anthropic-types"

import {
  copilotBaseUrl,
  prepareMessageProxyHeaders,
} from "~/lib/config/api-config"
import { sendRequest } from "~/lib/http/send-request"
import { parseUserIdMetadata } from "~/lib/platform/utils"
import { state } from "~/lib/runtime-state/state"

import type { CopilotCallOptions } from "./upstream-request"

import { messagesInitiator } from "./agent-initiator"
import {
  contextManagementStrategy,
  getObservedContextManagementSupport,
  observeContextManagementSupport,
} from "./context-management-capabilities"
import {
  buildCopilotHeaders,
  finishUpstreamResponse,
  requireCopilotToken,
} from "./upstream-request"

export type MessagesStream = ReturnType<typeof events>
export type CreateMessagesReturn = AnthropicResponse | MessagesStream

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14"
const ADVANCED_TOOL_USE_BETA = "advanced-tool-use-2025-11-20"
const allowedAnthropicBetas = new Set([
  INTERLEAVED_THINKING_BETA,
  "context-management-2025-06-27",
  ADVANCED_TOOL_USE_BETA,
])

const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27"

const withoutContextManagementBeta = (
  header: string | undefined,
): string | undefined => {
  if (!header) return undefined
  const retained = header
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== CONTEXT_MANAGEMENT_BETA)
  return retained.length > 0 ? retained.join(",") : undefined
}

const withoutContextManagement = (
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload => {
  const { context_management: _contextManagement, ...rest } = payload
  return rest
}

const isContextManagementRejection = async (
  response: Response,
): Promise<boolean> => {
  if (response.status !== 400) return false
  const body = await response.clone().text()
  return /context[_-]management/iu.test(body)
}

const buildAnthropicBetaHeader = (
  anthropicBetaHeader: string | undefined,
  thinking: AnthropicMessagesPayload["thinking"],
): string | undefined => {
  const isAdaptiveThinking = thinking?.type === "adaptive"

  if (anthropicBetaHeader) {
    const filteredBeta = anthropicBetaHeader
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .filter((item) => allowedAnthropicBetas.has(item))

    if (filteredBeta.length > 0) {
      return filteredBeta.join(",")
    }

    return undefined
  }

  if (thinking?.budget_tokens && !isAdaptiveThinking) {
    return INTERLEAVED_THINKING_BETA
  }

  return undefined
}

type ContextManagementScope = Parameters<
  typeof observeContextManagementSupport
>[0]

const resolveContextCompatibility = (
  payload: AnthropicMessagesPayload,
  baseUrl: string,
): {
  capabilityScope: ContextManagementScope | null
  omitContextManagement: boolean
  requestPayload: AnthropicMessagesPayload
} => {
  const strategy = contextManagementStrategy(payload.context_management)
  const capabilityScope =
    strategy ?
      {
        account: state.userName ?? "unknown",
        host: baseUrl,
        model: payload.model,
        strategy,
      }
    : null
  const advertisedSupport = state.models?.data.find(
    (model) => model.id === payload.model,
  )?.capabilities.supports.context_editing
  const observedSupport =
    capabilityScope ?
      getObservedContextManagementSupport(capabilityScope)
    : null
  const omitContextManagement =
    advertisedSupport === false || observedSupport === "rejected"

  return {
    capabilityScope,
    omitContextManagement,
    requestPayload:
      omitContextManagement ? withoutContextManagement(payload) : payload,
  }
}

interface ContextFallbackRequest {
  baseUrl: string
  headers: Record<string, string>
  payload: AnthropicMessagesPayload
  requestPayload: AnthropicMessagesPayload
  capabilityScope: ContextManagementScope | null
  omitContextManagement: boolean
}

const sendWithContextFallback = async ({
  baseUrl,
  headers,
  payload,
  requestPayload,
  capabilityScope,
  omitContextManagement,
}: ContextFallbackRequest): Promise<Response> => {
  const requestUrl = `${baseUrl}/v1/messages`
  const response = await sendRequest(requestUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(requestPayload),
  })

  if (response.ok && capabilityScope && !omitContextManagement) {
    observeContextManagementSupport(capabilityScope, "supported")
    return response
  }
  if (
    !capabilityScope
    || omitContextManagement
    || !(await isContextManagementRejection(response))
  ) {
    return response
  }

  observeContextManagementSupport(capabilityScope, "rejected")
  consola.warn("Copilot rejected context_management; retrying once without it")
  const retryHeaders = { ...headers }
  const retryBeta = withoutContextManagementBeta(retryHeaders["anthropic-beta"])
  if (retryBeta) {
    retryHeaders["anthropic-beta"] = retryBeta
  } else {
    delete retryHeaders["anthropic-beta"]
  }
  return sendRequest(requestUrl, {
    method: "POST",
    headers: retryHeaders,
    body: JSON.stringify(withoutContextManagement(payload)),
  })
}

export const createMessages = async (
  payload: AnthropicMessagesPayload,
  anthropicBetaHeader: string | undefined,
  options: CopilotCallOptions,
): Promise<CreateMessagesReturn> => {
  requireCopilotToken()

  const baseUrl = copilotBaseUrl(state)
  const { capabilityScope, omitContextManagement, requestPayload } =
    resolveContextCompatibility(payload, baseUrl)

  const enableVision = requestPayload.messages.some((message) => {
    if (!Array.isArray(message.content)) return false
    return message.content.some(
      (block) =>
        block.type === "image"
        || (block.type === "tool_result"
          && Array.isArray(block.content)
          && block.content.some((inner) => inner.type === "image")),
    )
  })

  const headers = buildCopilotHeaders(state, {
    ...options,
    vision: enableVision,
    initiator: messagesInitiator(requestPayload),
  })

  const { safetyIdentifier, sessionId } = parseUserIdMetadata(
    requestPayload.metadata?.user_id,
  )
  // from claude code
  // claude-opus-4.8 WAF rejects the Claude-Code user-agent unless
  // copilot-integration-id is also present. prepareMessageProxyHeaders
  // sets the Claude-Code UA without that header, triggering a 403 on 4.8
  // but not on 4.7. Skip it for 4.8 until Copilot upstream is fixed.
  if (
    safetyIdentifier
    && sessionId
    && !requestPayload.model.startsWith("claude-opus-4.8")
  ) {
    prepareMessageProxyHeaders(headers)
  }

  // align with vscode copilot extension anthropic-beta
  const anthropicBeta = buildAnthropicBetaHeader(
    omitContextManagement ?
      withoutContextManagementBeta(anthropicBetaHeader)
    : anthropicBetaHeader,
    requestPayload.thinking,
  )
  if (anthropicBeta) {
    headers["anthropic-beta"] = anthropicBeta
  }

  consola.log(`<-- model: ${requestPayload.model}`)

  const response = await sendWithContextFallback({
    baseUrl,
    headers,
    payload,
    requestPayload,
    capabilityScope,
    omitContextManagement,
  })

  return finishUpstreamResponse<AnthropicResponse>(response, {
    stream: Boolean(requestPayload.stream),
    errorMessage: "Failed to create messages",
  })
}
