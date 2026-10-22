import { describe, expect, test } from "bun:test"

import type { AnthropicStreamEventData } from "~/lib/models/anthropic-types"
import type { ResponseOutputItemAddedEvent } from "~/services/copilot/create-responses"

import {
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"

const createFunctionCallAddedEvent = (): ResponseOutputItemAddedEvent => ({
  type: "response.output_item.added",
  sequence_number: 1,
  output_index: 1,
  item: {
    id: "item-1",
    type: "function_call",
    call_id: "call-1",
    name: "TodoWrite",
    arguments: "",
    status: "in_progress",
  },
})

describe("translateResponsesStreamEvent tool calls", () => {
  test("streams function call arguments across deltas", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.delta",
          item_id: "item-1",
          output_index: 1,
          sequence_number: 2,
          delta: '{"todos":',
        },
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.delta",
          item_id: "item-1",
          output_index: 1,
          sequence_number: 3,
          delta: "[]}",
        },
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 4,
          arguments: '{"todos":[]}',
        },
        state,
      ),
    ].flat()

    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-1",
        name: "TodoWrite",
        input: {},
      })
    }

    const deltas = events.filter(
      (
        event,
      ): event is Extract<
        AnthropicStreamEventData,
        { type: "content_block_delta" }
      > => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(2)
    expect(deltas[0].delta).toEqual({
      type: "input_json_delta",
      partial_json: '{"todos":',
    })
    expect(deltas[1].delta).toEqual({
      type: "input_json_delta",
      partial_json: "[]}",
    })

    expect(state.openBlocks.size).toBe(1)
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })

  test("emits full arguments when only done payload is present", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 2,
          arguments:
            '{"todos":[{"content":"Review src/routes/responses/translation.ts"}]}',
        },
        state,
      ),
    ].flat()

    const deltas = events.filter(
      (
        event,
      ): event is Extract<
        AnthropicStreamEventData,
        { type: "content_block_delta" }
      > => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(1)
    expect(deltas[0].delta).toEqual({
      type: "input_json_delta",
      partial_json:
        '{"todos":[{"content":"Review src/routes/responses/translation.ts"}]}',
    })

    expect(state.openBlocks.size).toBe(1)
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })

  test("emits no argument delta for an all-empty function call", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 2,
          arguments: "",
        },
        state,
      ),
    ].flat()

    // A tool_use block is still opened, with empty input — same shape as the
    // Chat Completions streaming path.
    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-1",
        name: "TodoWrite",
        input: {},
      })
    }

    // But NO input_json_delta is ever emitted for an all-empty call: the
    // output_item.added guard skips the empty initial arguments, and the
    // function_call_arguments.done guard treats the empty string as falsy.
    const deltas = events.filter(
      (event) => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(0)

    expect(state.openBlocks.size).toBe(1)
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })
})

const errorOf = (events: Array<AnthropicStreamEventData>) =>
  events.find((e) => e.type === "error") as
    | { error: { type: string; message: string } }
    | undefined

describe("translateResponsesStreamEvent upstream failures", () => {
  test("an overflow in response.failed is reworded for auto-compaction", () => {
    const events = translateResponsesStreamEvent(
      {
        type: "response.failed",
        sequence_number: 1,
        response: {
          error: {
            message:
              "This model's maximum context length is 400000 tokens. However, your messages resulted in 412345 tokens.",
          },
        },
      } as never,
      createResponsesStreamState(),
    )
    expect(errorOf(events)?.error).toEqual({
      type: "invalid_request_error",
      message: "prompt is too long: 412345 tokens > 400000 maximum",
    })
  })

  test("an overflow in an error event is reworded too", () => {
    const events = translateResponsesStreamEvent(
      {
        type: "error",
        sequence_number: 1,
        code: "context_length_exceeded",
        param: null,
        message: "Your input exceeds the context window of this model.",
      },
      createResponsesStreamState(),
    )
    expect(errorOf(events)?.error.type).toBe("invalid_request_error")
    expect(errorOf(events)?.error.message).toStartWith("prompt is too long: ")
  })

  test("other upstream failures stay api_error", () => {
    const events = translateResponsesStreamEvent(
      {
        type: "error",
        sequence_number: 1,
        code: null,
        param: null,
        message: "content filtered",
      },
      createResponsesStreamState(),
    )
    expect(errorOf(events)?.error.type).toBe("api_error")
  })
})
