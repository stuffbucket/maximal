import type { SSEStreamingApi } from "hono/streaming"

import { beforeEach, describe, expect, it, mock } from "bun:test"
import consola from "consola"

import type {
  AnthropicMessagesPayload,
  AnthropicTool,
} from "~/lib/anthropic-types"
import type { WebToolPolicy } from "~/routes/messages/web-tools-rewriter"

import {
  runStreamingAgent,
  type UpstreamCall,
} from "~/routes/messages/web-tools-stream"

import { FakeExecutor } from "./helpers/fake-executor"

// Per-test queue of synthetic upstream chunk arrays. The injected
// upstreamCall pops one array per Copilot turn and yields its chunks.
const turns: Array<Array<{ data?: string }>> = []
let turnIdx = 0

const upstreamCall = mock((_payload: unknown) => {
  const chunks = turns[turnIdx++] ?? []
  return Promise.resolve({
    [Symbol.asyncIterator]: function* () {
      for (const c of chunks) yield c
    },
  })
}) as unknown as UpstreamCall

// ────────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────────

interface CapturedEvent {
  event: string
  data: unknown
}

function captureStream(): {
  stream: SSEStreamingApi
  events: Array<CapturedEvent>
} {
  const events: Array<CapturedEvent> = []
  const stream = {
    writeSSE: (msg: { event?: string; data: string }) => {
      events.push({
        event: msg.event ?? "",
        data: JSON.parse(msg.data) as unknown,
      })
      return Promise.resolve()
    },
  } as unknown as SSEStreamingApi
  return { stream, events }
}

const basePayload: AnthropicMessagesPayload = {
  model: "claude-3-5-sonnet",
  max_tokens: 1024,
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
}

const searchTool: AnthropicTool = {
  name: "web_search",
  description: "search",
  input_schema: { type: "object", properties: {} },
}

const searchPolicy: WebToolPolicy = {
  declarations: [{ type: "web_search_20250305", name: "web_search" }],
  hasSearch: true,
  hasFetch: false,
}

// Synthetic chunk builders. Each function returns an array suitable
// for one entry of `turns`. Keeping these terse — only the fields
// translateChunkToAnthropicEvents reads.

function chunk(payload: unknown): { data: string } {
  return { data: JSON.stringify(payload) }
}

function toolUseTurn(opts: {
  toolId: string
  toolName: string
  input: Record<string, unknown>
}): Array<{ data?: string }> {
  return [
    chunk({
      id: "msg_1",
      object: "chat.completion.chunk",
      created: 0,
      model: "x",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
    }),
    chunk({
      id: "msg_1",
      object: "chat.completion.chunk",
      created: 0,
      model: "x",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: opts.toolId,
                type: "function",
                function: { name: opts.toolName, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    chunk({
      id: "msg_1",
      object: "chat.completion.chunk",
      created: 0,
      model: "x",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: JSON.stringify(opts.input) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    chunk({
      id: "msg_1",
      object: "chat.completion.chunk",
      created: 0,
      model: "x",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { data: "[DONE]" },
  ]
}

function textTurn(text: string): Array<{ data?: string }> {
  return [
    chunk({
      id: "msg_2",
      object: "chat.completion.chunk",
      created: 0,
      model: "x",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    }),
    chunk({
      id: "msg_2",
      object: "chat.completion.chunk",
      created: 0,
      model: "x",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { data: "[DONE]" },
  ]
}

function setNextTurns(...turnArrays: Array<Array<{ data?: string }>>): void {
  turns.length = 0
  turns.push(...turnArrays)
  turnIdx = 0
}

const baseOptions = {
  requestId: "req_test",
  logger: consola.create({ level: 0 }),
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe("runStreamingAgent", () => {
  beforeEach(() => {
    ;(upstreamCall as unknown as { mockClear: () => void }).mockClear()
    turns.length = 0
    turnIdx = 0
  })

  it("rewrites a single web_search round-trip into server_tool_use + result", async () => {
    setNextTurns(
      toolUseTurn({
        toolId: "tooluse_1",
        toolName: "web_search",
        input: { query: "shannon" },
      }),
      textTurn("Claude Shannon was born in 1916."),
    )
    const exec = new FakeExecutor()
    const { stream, events } = captureStream()

    await runStreamingAgent({
      initialPayload: { ...basePayload, tools: [searchTool] },
      policy: searchPolicy,
      stream,
      executor: exec,
      options: baseOptions,
      upstreamCall,
    })

    expect(exec.searchCalls).toEqual(["shannon"])
    expect(
      (upstreamCall as unknown as { mock: { calls: Array<unknown> } }).mock
        .calls.length,
    ).toBe(2)

    // Block types in order — one server_tool_use, one result block,
    // one final text block.
    const blockStarts = events
      .filter((e) => e.event === "content_block_start")
      .map(
        (e) =>
          (e.data as { content_block: { type: string } }).content_block.type,
      )
    expect(blockStarts).toContain("server_tool_use")
    expect(blockStarts).toContain("web_search_tool_result")
    expect(blockStarts).toContain("text")

    const resultBlock = events
      .map(
        (e) =>
          e.data as {
            content_block?: {
              type: string
              tool_use_id?: string
              content?: unknown
            }
          },
      )
      .find((d) => d.content_block?.type === "web_search_tool_result")
    expect(resultBlock?.content_block?.tool_use_id).toBe("tooluse_1")

    // Last event is message_stop after a message_delta with stop_reason.
    const lastTwo = events.slice(-2).map((e) => e.event)
    expect(lastTwo).toEqual(["message_delta", "message_stop"])
  })

  it("emits an error block on max_uses_exceeded without re-invoking executor", async () => {
    const policy: WebToolPolicy = {
      declarations: [
        { type: "web_search_20250305", name: "web_search", max_uses: 1 },
      ],
      hasSearch: true,
      hasFetch: false,
    }
    setNextTurns(
      toolUseTurn({
        toolId: "tooluse_1",
        toolName: "web_search",
        input: { query: "first" },
      }),
      toolUseTurn({
        toolId: "tooluse_2",
        toolName: "web_search",
        input: { query: "second" },
      }),
      textTurn("done"),
    )
    const exec = new FakeExecutor()
    const { stream, events } = captureStream()

    await runStreamingAgent({
      initialPayload: { ...basePayload, tools: [searchTool] },
      policy,
      stream,
      executor: exec,
      options: baseOptions,
      upstreamCall,
    })

    // First call should hit the executor; the second should be
    // short-circuited by policy.
    expect(exec.searchCalls).toEqual(["first"])

    const errorBlock = events
      .map(
        (e) =>
          e.data as {
            content_block?: { type: string; content?: { error_code?: string } }
          },
      )
      .find((d) => d.content_block?.type === "web_search_tool_result_error")
    expect(errorBlock?.content_block?.content?.error_code).toBe(
      "max_uses_exceeded",
    )
  })

  it("passes through a plain text response without invoking executor", async () => {
    setNextTurns(textTurn("no search needed"))
    const exec = new FakeExecutor()
    const { stream, events } = captureStream()

    await runStreamingAgent({
      initialPayload: { ...basePayload, tools: [searchTool] },
      policy: searchPolicy,
      stream,
      executor: exec,
      options: baseOptions,
      upstreamCall,
    })

    expect(exec.searchCalls).toEqual([])
    const blockStarts = events
      .filter((e) => e.event === "content_block_start")
      .map(
        (e) =>
          (e.data as { content_block: { type: string } }).content_block.type,
      )
    expect(blockStarts).toContain("text")
    expect(blockStarts).not.toContain("server_tool_use")
  })

  it("preserves a non-web tool_use block unchanged", async () => {
    setNextTurns(
      toolUseTurn({
        toolId: "tooluse_x",
        toolName: "my_custom_tool",
        input: { foo: "bar" },
      }),
    )
    const exec = new FakeExecutor()
    const { stream, events } = captureStream()

    await runStreamingAgent({
      initialPayload: { ...basePayload, tools: [searchTool] },
      policy: searchPolicy,
      stream,
      executor: exec,
      options: baseOptions,
      upstreamCall,
    })

    expect(exec.searchCalls).toEqual([])
    const blockStarts = events
      .filter((e) => e.event === "content_block_start")
      .map(
        (e) =>
          (e.data as { content_block: { type: string; name?: string } })
            .content_block,
      )
    const toolUseStart = blockStarts.find((b) => b.type === "tool_use")
    expect(toolUseStart?.name).toBe("my_custom_tool")
    expect(
      blockStarts.find((b) => b.type === "server_tool_use"),
    ).toBeUndefined()
  })
})
