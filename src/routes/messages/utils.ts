import consola from "consola"

import { type AnthropicResponse } from "~/lib/models/anthropic-types"

/**
 * Parse the `arguments` string of an OpenAI/Copilot tool call into the object
 * shape Anthropic's `tool_use.input` expects.
 *
 * Copilot normally sends `"{}"` for an argument-less tool call, but an empty
 * string or malformed JSON can still arrive (empty deltas, truncated streams).
 * A bare `JSON.parse` throws on both, crashing the whole request — so this
 * degrades gracefully instead: empty/whitespace → `{}`, unparseable → the raw
 * string preserved under `raw_arguments` (with a warning). Mirrors the
 * defensive behaviour already used on the Responses path
 * (`parseFunctionCallArguments` in responses-translation.ts).
 */
export function parseToolCallArguments(
  rawArguments: string | undefined | null,
): Record<string, unknown> {
  if (typeof rawArguments !== "string" || rawArguments.trim().length === 0) {
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(rawArguments)
    if (Array.isArray(parsed)) {
      return { arguments: parsed }
    }
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>
    }
  } catch (error) {
    consola.warn("Failed to parse tool call arguments", { error, rawArguments })
  }

  return { raw_arguments: rawArguments }
}

export function mapOpenAIStopReasonToAnthropic(
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): AnthropicResponse["stop_reason"] {
  if (finishReason === null) {
    return null
  }
  const stopReasonMap = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "end_turn",
  } as const
  return stopReasonMap[finishReason]
}
