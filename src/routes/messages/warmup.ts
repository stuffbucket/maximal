import type { Context } from "hono"

import { streamSSE } from "hono/streaming"
import { randomUUID } from "node:crypto"

import type {
  AnthropicContentBlockDeltaEvent,
  AnthropicContentBlockStartEvent,
  AnthropicContentBlockStopEvent,
  AnthropicMessageDeltaEvent,
  AnthropicMessagesPayload,
  AnthropicMessageStartEvent,
  AnthropicMessageStopEvent,
  AnthropicResponse,
} from "~/lib/anthropic-types"

const WARMUP_TEXT = "Warmup"
const CANNED_REPLY = "OK"

/**
 * Extract the plain-text content of an Anthropic message, handling both the
 * `content: string` shape and the `content: Array<block>` shape. Only `text`
 * blocks contribute; every other block type (image, tool_result, …) is
 * ignored. Concatenates text blocks in order.
 */
function extractMessageText(payload: AnthropicMessagesPayload): string {
  const { content } = payload.messages[0]
  if (typeof content === "string") {
    return content
  }
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
}

/**
 * False-positive-safe detector for the Claude Code startup "Warmup" request.
 * Payload-only (header checks live in the caller) so it is unit-testable.
 *
 * Returns true ONLY when: no tools, exactly one user message, and that
 * message's concatenated text trims to exactly "Warmup" (case-sensitive). A
 * false positive would canned-respond to a real request — a correctness bug —
 * so this errs tight; a false negative just falls through to normal handling.
 */
export function isWarmupRequest(payload: AnthropicMessagesPayload): boolean {
  const noTools = !payload.tools || payload.tools.length === 0
  if (!noTools) {
    return false
  }
  if (payload.messages.length !== 1) {
    return false
  }
  const [message] = payload.messages
  if (message.role !== "user") {
    return false
  }
  return extractMessageText(payload).trim() === WARMUP_TEXT
}

/**
 * Respond to a warmup request with a canned minimal Anthropic response,
 * WITHOUT any upstream call. Handles both non-streaming and streaming.
 */
export function respondToWarmup(
  c: Context,
  payload: AnthropicMessagesPayload,
): Response {
  const id = `msg_warmup_${randomUUID()}`
  const { model } = payload

  if (!payload.stream) {
    const response: AnthropicResponse = {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: CANNED_REPLY }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }
    return c.json(response)
  }

  return streamSSE(c, async (stream) => {
    const messageStart: AnthropicMessageStartEvent = {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }
    const contentBlockStart: AnthropicContentBlockStartEvent = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }
    const contentBlockDelta: AnthropicContentBlockDeltaEvent = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: CANNED_REPLY },
    }
    const contentBlockStop: AnthropicContentBlockStopEvent = {
      type: "content_block_stop",
      index: 0,
    }
    const messageDelta: AnthropicMessageDeltaEvent = {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    }
    const messageStop: AnthropicMessageStopEvent = { type: "message_stop" }

    for (const event of [
      messageStart,
      contentBlockStart,
      contentBlockDelta,
      contentBlockStop,
      messageDelta,
      messageStop,
    ]) {
      await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
    }
  })
}
