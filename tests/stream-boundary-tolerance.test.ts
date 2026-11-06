import { describe, expect, test } from "bun:test"

import type { AnthropicStreamState } from "~/lib/models/anthropic-types"

import {
  asRecord,
  readNestedUsage,
  readUsage,
} from "~/lib/http/untrusted-frame"
import {
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import { translateChunkToAnthropicEvents } from "~/routes/messages/stream-translation"
import {
  createStreamIdTracker,
  fixStreamIds,
} from "~/routes/responses/stream-id-sync"

const freshChatState = (): AnthropicStreamState => ({
  messageStartSent: false,
  contentBlockIndex: 0,
  contentBlockOpen: false,
  toolCalls: {},
  thinkingBlockOpen: false,
})

const malformedChatChunks: Array<[string, unknown]> = [
  ["null body", null],
  ["array body", [1, 2]],
  ["string body", "hello"],
  ["number body", 42],
  ["empty object", {}],
  ["no choices key", { id: "a", model: "m" }],
  ["choices null", { choices: null }],
  ["choices string", { choices: "xx" }],
  ["choice null", { choices: [null] }],
  ["choice without delta", { choices: [{ finish_reason: "stop" }] }],
  ["delta null", { choices: [{ delta: null }] }],
  ["tool call null", { choices: [{ delta: { tool_calls: [null] } }] }],
  ["tool calls string", { choices: [{ delta: { tool_calls: "x" } }] }],
  ["usage string", { choices: [{ delta: {} }], usage: "lots" }],
  ["finish reason number", { choices: [{ delta: {}, finish_reason: 7 }] }],
]

describe("chat stream boundary tolerance", () => {
  test.each(malformedChatChunks)("%s does not throw", (_label, chunk) => {
    const state = freshChatState()
    expect(() => translateChunkToAnthropicEvents(chunk, state)).not.toThrow()
    expect(state.contentBlockIndex).toBeGreaterThanOrEqual(0)
  })

  test("a valid chunk still translates after a malformed one", () => {
    const state = freshChatState()
    translateChunkToAnthropicEvents({}, state)
    const events = translateChunkToAnthropicEvents(
      {
        id: "c1",
        model: "m",
        choices: [{ delta: { content: "hi" } }],
      },
      state,
    )
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
    ])
  })
})

const malformedResponsesEvents: Array<[string, unknown]> = [
  ["null body", null],
  ["array body", []],
  ["string body", "hello"],
  ["empty object", {}],
  ["unknown type", { type: "response.whatever" }],
  ["created without response", { type: "response.created" }],
  ["created response null", { type: "response.created", response: null }],
  ["added without item", { type: "response.output_item.added" }],
  ["added item null", { type: "response.output_item.added", item: null }],
  ["done without item", { type: "response.output_item.done" }],
  ["completed without response", { type: "response.completed" }],
  ["completed response string", { type: "response.completed", response: "x" }],
  ["completed response empty", { type: "response.completed", response: {} }],
  ["incomplete without response", { type: "response.incomplete" }],
  ["failed without response", { type: "response.failed" }],
  ["error without message", { type: "error" }],
  [
    "function delta object",
    { type: "response.function_call_arguments.delta", delta: {} },
  ],
]

describe("Responses stream boundary tolerance", () => {
  test.each(malformedResponsesEvents)("%s does not throw", (_label, event) => {
    const state = createResponsesStreamState()
    expect(() => translateResponsesStreamEvent(event, state)).not.toThrow()
    expect(state.nextContentBlockIndex).toBeGreaterThanOrEqual(0)
  })

  test("a malformed terminal frame terminates with an error", () => {
    const state = createResponsesStreamState()
    const events = translateResponsesStreamEvent(
      { type: "response.completed" },
      state,
    )
    expect(events.at(-1)?.type).toBe("error")
    expect(state.messageCompleted).toBe(true)
  })
})

describe("stream ID boundary tolerance", () => {
  test("passes non-JSON and malformed output-item frames through", () => {
    const tracker = createStreamIdTracker()
    expect(fixStreamIds("[DONE]", undefined, tracker)).toBe("[DONE]")
    expect(
      fixStreamIds("{truncated", "response.output_item.added", tracker),
    ).toBe("{truncated")
    expect(
      fixStreamIds('{"output_index":0}', "response.output_item.done", tracker),
    ).toBe('{"output_index":0}')
  })

  test("synchronizes IDs across a valid added/done pair", () => {
    const tracker = createStreamIdTracker()
    fixStreamIds(
      '{"output_index":0,"item":{"id":"first"}}',
      "response.output_item.added",
      tracker,
    )
    const done = fixStreamIds(
      '{"output_index":0,"item":{"id":"second"}}',
      "response.output_item.done",
      tracker,
    )
    expect(JSON.parse(done)).toEqual({
      output_index: 0,
      item: { id: "first" },
    })
  })
})

describe("untrusted frame readers", () => {
  test("rejects non-objects and reads usage without throwing", () => {
    for (const value of [null, undefined, 1, "s", true]) {
      expect(asRecord(value)).toBeUndefined()
    }
    expect(readNestedUsage({ response: "done" }, "response")).toBeUndefined()
    expect(
      readNestedUsage({ response: { usage: { input_tokens: 4 } } }, "response"),
    ).toEqual({ input_tokens: 4 })
    expect(readUsage({ usage: { output_tokens: 2 } })).toEqual({
      output_tokens: 2,
    })
  })
})
