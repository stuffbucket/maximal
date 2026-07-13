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

export const createMessages = async (
  payload: AnthropicMessagesPayload,
  anthropicBetaHeader: string | undefined,
  options: CopilotCallOptions,
): Promise<CreateMessagesReturn> => {
  requireCopilotToken()

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

  const headers = buildCopilotHeaders(state, {
    ...options,
    vision: enableVision,
    initiator: messagesInitiator(payload),
  })

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
  )
  if (anthropicBeta) {
    headers["anthropic-beta"] = anthropicBeta
  }

  consola.log(`<-- model: ${payload.model}`)

  const response = await sendRequest(`${copilotBaseUrl(state)}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  return finishUpstreamResponse<AnthropicResponse>(response, {
    stream: Boolean(payload.stream),
    errorMessage: "Failed to create messages",
  })
}
