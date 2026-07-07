import type { AnthropicMessagesPayload } from "~/lib/anthropic-types"

import type { ChatCompletionsPayload } from "./create-chat-completions"
import type { ResponsesPayload } from "./create-responses"

/**
 * Single source of truth for agent-vs-user initiator detection.
 *
 * The `x-initiator` header this drives feeds Copilot's credit accounting
 * (an "agent" turn is billed differently from a "user" turn), so this is a
 * billing-correctness surface, not cosmetics. Historically each of the three
 * upstream builders re-derived it a subtly different way; they now all route
 * through this module.
 *
 * The three request shapes genuinely differ (Anthropic content blocks vs
 * OpenAI chat roles vs Responses input items), so the rules are kept as three
 * explicit, per-shape functions rather than being forced through one leaky
 * predicate. What is shared is the *intent* — "does the last turn originate
 * from the agent rather than the user?" — and its home.
 */

export type Initiator = "agent" | "user"

/**
 * Anthropic Messages (`/v1/messages`).
 *
 * A turn is user-initiated only when the last message is a genuine user
 * message — i.e. role `user` whose content is not composed solely of
 * `tool_result` blocks (those are the agent feeding tool output back in).
 * Everything else (assistant turns, tool-result-only user turns, an empty
 * history) counts as agent-initiated.
 */
export const messagesInitiator = (
  payload: AnthropicMessagesPayload,
): Initiator => {
  let isInitiateRequest = false
  const lastMessage = payload.messages.at(-1)
  if (lastMessage?.role === "user") {
    isInitiateRequest =
      Array.isArray(lastMessage.content) ?
        lastMessage.content.some((block) => block.type !== "tool_result")
      : true
  }
  return isInitiateRequest ? "user" : "agent"
}

/**
 * Chat Completions (`/chat/completions`).
 *
 * Agent-initiated when the last message is from the model side (`assistant`)
 * or is tool output (`tool`). An empty history counts as user-initiated.
 */
export const chatCompletionsInitiator = (
  payload: ChatCompletionsPayload,
): Initiator => {
  const lastMessage = payload.messages.at(-1)
  if (lastMessage && ["assistant", "tool"].includes(lastMessage.role)) {
    return "agent"
  }
  return "user"
}

/**
 * Responses (`/responses`).
 *
 * Agent-initiated when the last input item is an `assistant` message, or when
 * it carries no role at all (e.g. function-call / reasoning items — the agent
 * feeding state back in). An empty input counts as user-initiated.
 */
export const responsesInitiator = (payload: ResponsesPayload): Initiator => {
  const input = payload.input
  const lastItem = Array.isArray(input) ? input.at(-1) : undefined
  if (!lastItem) {
    return "user"
  }
  if (!("role" in lastItem) || !lastItem.role) {
    return "agent"
  }
  const role =
    typeof lastItem.role === "string" ? lastItem.role.toLowerCase() : ""
  return role === "assistant" ? "agent" : "user"
}
