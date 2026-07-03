import { describe, expect, test } from "bun:test"

import {
  mapOpenAIStopReasonToAnthropic,
  parseToolCallArguments,
} from "~/routes/messages/utils"

describe("parseToolCallArguments", () => {
  test("returns {} for a non-string input", () => {
    // Callers type it as string, but the signature accepts null/undefined —
    // the guard must short-circuit before JSON.parse throws on those.
    expect(parseToolCallArguments(undefined)).toEqual({})
    expect(parseToolCallArguments(null)).toEqual({})
  })

  test("returns {} for an empty or whitespace-only string", () => {
    expect(parseToolCallArguments("")).toEqual({})
    // Whitespace must be trimmed before the empty check — `"   "` is empty args.
    expect(parseToolCallArguments("   ")).toEqual({})
    expect(parseToolCallArguments("\n\t")).toEqual({})
  })

  test("passes through a parsed object unchanged", () => {
    expect(parseToolCallArguments('{"message":"hi","to":"agent"}')).toEqual({
      message: "hi",
      to: "agent",
    })
  })

  test("returns {} for an argument-less tool call sent as {}", () => {
    // Copilot's normal shape for a no-arg tool call.
    expect(parseToolCallArguments("{}")).toEqual({})
  })

  test("wraps a top-level JSON array under `arguments`", () => {
    // A bare array isn't a valid Anthropic input object, so it's nested.
    expect(parseToolCallArguments('["a","b"]')).toEqual({
      arguments: ["a", "b"],
    })
    expect(parseToolCallArguments("[]")).toEqual({ arguments: [] })
  })

  test("preserves malformed JSON under `raw_arguments`", () => {
    expect(parseToolCallArguments('{"location": "Boston')).toEqual({
      raw_arguments: '{"location": "Boston',
    })
    expect(parseToolCallArguments("not json")).toEqual({
      raw_arguments: "not json",
    })
  })

  test("wraps a non-object JSON scalar under `raw_arguments`", () => {
    // Valid JSON that isn't an object or array (e.g. a bare number/string)
    // falls through to the raw_arguments fallback rather than returning {}.
    expect(parseToolCallArguments("42")).toEqual({ raw_arguments: "42" })
    expect(parseToolCallArguments('"hello"')).toEqual({
      raw_arguments: '"hello"',
    })
    expect(parseToolCallArguments("null")).toEqual({ raw_arguments: "null" })
  })
})

describe("mapOpenAIStopReasonToAnthropic", () => {
  test("maps null finish_reason to null", () => {
    expect(mapOpenAIStopReasonToAnthropic(null)).toBeNull()
  })

  test("maps each OpenAI finish_reason to its Anthropic stop_reason", () => {
    expect(mapOpenAIStopReasonToAnthropic("stop")).toBe("end_turn")
    expect(mapOpenAIStopReasonToAnthropic("length")).toBe("max_tokens")
    expect(mapOpenAIStopReasonToAnthropic("tool_calls")).toBe("tool_use")
    expect(mapOpenAIStopReasonToAnthropic("content_filter")).toBe("end_turn")
  })
})
