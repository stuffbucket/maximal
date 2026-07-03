import consola from "consola"
import { events } from "fetch-event-stream"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/anthropic-types"
import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"

import {
  copilotBaseUrl,
  copilotHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
  prepareMessageProxyHeaders,
} from "~/lib/api-config"
import { authFetch } from "~/lib/auth-fetch"
import { isAuthFatal, parseCopilotErrorBody } from "~/lib/copilot-error-parser"
import { logCopilotRateLimits } from "~/lib/copilot-rate-limit"
import { CopilotAuthFatalError, HTTPError } from "~/lib/error"
import {
  clearLastUpstreamRejection,
  setLastUpstreamRejection,
  state,
} from "~/lib/state"
import { parseUserIdMetadata } from "~/lib/utils"

export type MessagesStream = ReturnType<typeof events>
export type CreateMessagesReturn = AnthropicResponse | MessagesStream

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14"
const ADVANCED_TOOL_USE_BETA = "advanced-tool-use-2025-11-20"
const allowedAnthropicBetas = new Set([
  INTERLEAVED_THINKING_BETA,
  "context-management-2025-06-27",
  ADVANCED_TOOL_USE_BETA,
])

const buildAnthropicBetaHeader = (
  anthropicBetaHeader: string | undefined,
  thinking: AnthropicMessagesPayload["thinking"],
  _model: string,
): string | undefined => {
  const isAdaptiveThinking = thinking?.type === "adaptive"

  if (anthropicBetaHeader) {
    const filteredBeta = anthropicBetaHeader
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .filter((item) => allowedAnthropicBetas.has(item))

    // in vscode copilot extension, advanced-tool-use is enabled by default
    // align header with vscode copilot extension
    const uniqueFilteredBetas = [...filteredBeta]
    if (uniqueFilteredBetas.length > 0) {
      return uniqueFilteredBetas.join(",")
    }

    return undefined
  }

  if (thinking?.budget_tokens && !isAdaptiveThinking) {
    return INTERLEAVED_THINKING_BETA
  }

  return undefined
}

export const createMessages = async (
  payload: AnthropicMessagesPayload,
  anthropicBetaHeader: string | undefined,
  options: {
    subagentMarker?: SubagentMarker | null
    requestId: string
    sessionId?: string
    compactType?: CompactType
  },
): Promise<CreateMessagesReturn> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some((message) => {
    if (!Array.isArray(message.content)) return false
    return message.content.some(
      (block) =>
        block.type === "image"
        || (block.type === "tool_result"
          && Array.isArray(block.content)
          && block.content.some((inner) => inner.type === "image")),
    )
  })

  let isInitiateRequest = false
  const lastMessage = payload.messages.at(-1)
  if (lastMessage?.role === "user") {
    isInitiateRequest =
      Array.isArray(lastMessage.content) ?
        lastMessage.content.some((block) => block.type !== "tool_result")
      : true
  }

  const headers: Record<string, string> = {
    ...copilotHeaders(state, options.requestId, enableVision),
    "x-initiator": isInitiateRequest ? "user" : "agent",
  }

  prepareInteractionHeaders(
    options.sessionId,
    Boolean(options.subagentMarker),
    headers,
  )

  prepareForCompact(headers, options.compactType)

  const { safetyIdentifier, sessionId } = parseUserIdMetadata(
    payload.metadata?.user_id,
  )
  // from claude code
  // claude-opus-4.8 WAF rejects the Claude-Code user-agent unless
  // copilot-integration-id is also present. prepareMessageProxyHeaders
  // sets the Claude-Code UA without that header, triggering a 403 on 4.8
  // but not on 4.7. Skip it for 4.8 until Copilot upstream is fixed.
  if (
    safetyIdentifier
    && sessionId
    && !payload.model.startsWith("claude-opus-4.8")
  ) {
    prepareMessageProxyHeaders(headers)
  }

  // align with vscode copilot extension anthropic-beta
  const anthropicBeta = buildAnthropicBetaHeader(
    anthropicBetaHeader,
    payload.thinking,
    payload.model,
  )
  if (anthropicBeta) {
    headers["anthropic-beta"] = anthropicBeta
  }

  consola.log(`<-- model: ${payload.model}`)

  const response = await authFetch(`${copilotBaseUrl(state)}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  logCopilotRateLimits(response.headers)

  if (!response.ok) {
    consola.error("Failed to create messages", response)
    const body = await response.clone().text()
    const parsed = parseCopilotErrorBody(body)
    if (isAuthFatal(response.status, parsed)) {
      throw new CopilotAuthFatalError(
        parsed.message,
        response.status,
        parsed.remediationUrl,
      )
    }
    setLastUpstreamRejection({
      message: parsed.message,
      remediationUrl: parsed.remediationUrl,
      status: response.status,
    })
    throw new HTTPError("Failed to create messages", response)
  }

  clearLastUpstreamRejection()

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as AnthropicResponse
}
