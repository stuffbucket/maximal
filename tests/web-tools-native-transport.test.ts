import { describe, expect, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/models/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { handleWithWebToolsAgent } from "~/routes/messages/web-tools/flow"
import {
  selectTurnTransport,
  type WebToolsUpstreamDeps,
} from "~/routes/messages/web-tools/transport"

import { FakeExecutor } from "./helpers/fake-executor"

// The native `/v1/messages` turn transport, driven end to end through
// handleWithWebToolsAgent with injected upstream fakes (no mock.module, no
// fetch stub). The chat and Responses fakes throw, so a test fails loudly if
// the loop leaves the transport it was given.

const claudeModel = {
  id: "claude-sonnet-4.6",
  name: "Claude Sonnet 4.6",
  object: "model",
  preview: false,
  vendor: "Anthropic",
  version: "4.6",
  model_picker_enabled: true,
  supported_endpoints: ["/chat/completions", "/v1/messages"],
  capabilities: {
    family: "claude-sonnet-4.6",
    limits: { max_prompt_tokens: 200_000 },
    object: "model_capabilities",
    supports: {
      tool_calls: true,
      streaming: true,
      adaptive_thinking: true,
      reasoning_effort: ["low", "medium", "high"],
    },
    tokenizer: "o200k_base",
    type: "chat",
  },
} satisfies Model

const clientTool = {
  name: "Read",
  description: "Read a file",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
}

const policy = {
  declarations: [
    { type: "web_search_20250305" as const, name: "web_search" as const },
  ],
  hasSearch: true,
  hasFetch: false,
}

function payload(stream: boolean): AnthropicMessagesPayload {
  return {
    model: claudeModel.id,
    max_tokens: 1024,
    stream,
    system: [{ type: "text", text: "You are helpful." }],
    messages: [{ role: "user", content: "who invented information theory?" }],
    tools: [clientTool],
  }
}

interface MessagesCall {
  payload: AnthropicMessagesPayload
  beta: string | undefined
  /** The payload as serialized at call time: the loop keeps appending to the
   *  same messages array, so a later snapshot would show later turns. */
  bytes: string
}

const unexpected = (): never => {
  throw new Error("native transport called a translated upstream")
}

function fakeDeps(
  replies: Array<AnthropicResponse | Array<Record<string, unknown>>>,
): { deps: Partial<WebToolsUpstreamDeps>; calls: Array<MessagesCall> } {
  const calls: Array<MessagesCall> = []
  let turn = 0
  const createMessages: WebToolsUpstreamDeps["createMessages"] = (
    sent,
    beta,
  ) => {
    calls.push({ payload: sent, beta, bytes: JSON.stringify(sent) })
    const reply = replies[turn++]
    if (!Array.isArray(reply)) return Promise.resolve(reply)
    const frames = reply.map((event) => ({
      event: String(event.type),
      data: JSON.stringify(event),
    }))
    return Promise.resolve({
      [Symbol.asyncIterator]: function* () {
        for (const frame of frames) yield frame
      },
    } as unknown as Awaited<ReturnType<WebToolsUpstreamDeps["createMessages"]>>)
  }
  return {
    calls,
    deps: {
      createMessages,
      createChatCompletions: unexpected,
      createResponses: unexpected,
    },
  }
}

const post = {
  method: "POST",
  headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" },
}

function app(
  body: AnthropicMessagesPayload,
  deps: Partial<WebToolsUpstreamDeps>,
  opts: { executor?: FakeExecutor; nativeMessages?: boolean } = {},
): Hono {
  const { executor = new FakeExecutor(), nativeMessages = true } = opts
  const hono = new Hono()
  hono.post("/", (c) =>
    handleWithWebToolsAgent({
      c,
      payload: body,
      options: {
        logger: consola.create({ level: 0 }),
        requestId: "req-native",
        sessionId: "session-native",
      },
      policy,
      selectedModel: claudeModel,
      executor,
      transportPolicy: { nativeMessages },
      deps,
    }),
  )
  return hono
}

/** The bytes Copilot's prompt cache keys on, minus the growing message tail. */
function cachePrefix(call: MessagesCall): string {
  const sent = JSON.parse(call.bytes) as AnthropicMessagesPayload
  return JSON.stringify({
    model: sent.model,
    system: sent.system,
    tools: sent.tools,
    thinking: sent.thinking,
    output_config: sent.output_config,
    tool_choice: sent.tool_choice,
  })
}

/** Turn N's messages must be a byte-identical prefix of turn N+1's. */
function expectMessagesPrefix(earlier: MessagesCall, later: MessagesCall) {
  const a = (JSON.parse(earlier.bytes) as AnthropicMessagesPayload).messages
  const b = (JSON.parse(later.bytes) as AnthropicMessagesPayload).messages
  expect(b.length).toBeGreaterThan(a.length)
  expect(JSON.stringify(b.slice(0, a.length))).toBe(JSON.stringify(a))
}

const toolUseResponse: AnthropicResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: claudeModel.id,
  content: [
    { type: "thinking", thinking: "Search first.", signature: "sig-1" },
    { type: "text", text: "Let me search." },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "web_search",
      input: { query: "information theory inventor" },
    },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
  copilot_usage: { total_nano_aiu: 5 },
}

const finalResponse: AnthropicResponse = {
  id: "msg_2",
  type: "message",
  role: "assistant",
  model: claudeModel.id,
  content: [{ type: "text", text: "Claude Shannon." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 150, output_tokens: 5, cache_read_input_tokens: 120 },
  copilot_usage: { total_nano_aiu: 7 },
}

describe("selectTurnTransport", () => {
  test("keeps today's choice unless the caller allows native Messages", () => {
    expect(selectTurnTransport(claudeModel)).toBe("chat")
    expect(selectTurnTransport(claudeModel, { nativeMessages: true })).toBe(
      "messages",
    )
    const responsesModel = {
      ...claudeModel,
      supported_endpoints: ["/responses"],
    }
    expect(selectTurnTransport(responsesModel)).toBe("responses")
    expect(selectTurnTransport(responsesModel, { nativeMessages: true })).toBe(
      "responses",
    )
    expect(selectTurnTransport(undefined, { nativeMessages: true })).toBe(
      "chat",
    )
  })
})

describe("native Messages transport, non-streaming", () => {
  test("runs one web_search round-trip against /v1/messages", async () => {
    const { deps, calls } = fakeDeps([toolUseResponse, finalResponse])
    const executor = new FakeExecutor()

    const response = await app(payload(false), deps, { executor }).request(
      "/",
      post,
    )
    const body = (await response.json()) as {
      content: Array<{ type: string; name?: string }>
      usage: AnthropicResponse["usage"]
      copilot_usage?: { total_nano_aiu?: number }
    }

    expect(response.status).toBe(200)
    expect(executor.searchCalls).toEqual(["information theory inventor"])
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.payload.stream).toBe(false)
      expect(call.beta).toBe("interleaved-thinking-2025-05-14")
    }
    // The Messages preprocessing ran once, before the first turn.
    expect(calls[0].payload.thinking?.type).toBe("adaptive")

    // Turn 2 replays the signed thinking with the tool call, then the result.
    const turn2 = calls[1].payload.messages
    expect(turn2.at(-2)).toEqual({
      role: "assistant",
      content: toolUseResponse.content,
    })
    const result = turn2.at(-1)
    expect(result?.role).toBe("user")
    expect(JSON.stringify(result?.content)).toContain('"tool_use_id":"toolu_1"')

    // The client sees Anthropic's server-tool shape, as on the other transports.
    expect(body.content.map((b) => b.type)).toEqual([
      "thinking",
      "text",
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
    expect(body.usage).toEqual({
      input_tokens: 250,
      output_tokens: 25,
      cache_read_input_tokens: 200,
    })
    expect(body.copilot_usage).toEqual({ total_nano_aiu: 12 })
  })

  test("keeps the cached prefix byte-stable across turns", async () => {
    const { deps, calls } = fakeDeps([toolUseResponse, finalResponse])

    await app(payload(false), deps).request("/", post)

    expect(calls).toHaveLength(2)
    expect(cachePrefix(calls[1])).toBe(cachePrefix(calls[0]))
    expectMessagesPrefix(calls[0], calls[1])
    // The shim tool is appended after the client's tools, never before.
    expect(calls[0].payload.tools?.map((t) => t.name)).toEqual([
      "Read",
      "web_search",
    ])
  })

  test("the same request across two client turns declares identical tools", async () => {
    const first = fakeDeps([finalResponse])
    await app(payload(false), first.deps).request("/", post)
    const next = payload(false)
    next.messages.push(
      { role: "assistant", content: [{ type: "text", text: "Shannon." }] },
      { role: "user", content: "and when?" },
    )
    const second = fakeDeps([finalResponse])
    await app(next, second.deps).request("/", post)

    expect(cachePrefix(second.calls[0])).toBe(cachePrefix(first.calls[0]))
  })

  test("drops echoed server-tool blocks from the history it sends", async () => {
    const body = payload(false)
    body.messages.push(
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching." },
          {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "web_search",
            input: { query: "q" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [],
          },
          { type: "text", text: "Found it." },
        ] as unknown as Array<{ type: "text"; text: string }>,
      },
      { role: "user", content: "thanks" },
    )
    const { deps, calls } = fakeDeps([finalResponse])

    await app(body, deps).request("/", post)

    const sent = calls[0].payload.messages
    expect(sent).toHaveLength(3)
    expect(sent[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Searching." },
        { type: "text", text: "Found it." },
      ],
    })
  })
})

// ── streaming ─────────────────────────────────────────────────────────

function messageStart(id: string, usage: Record<string, number>) {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: claudeModel.id,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  }
}

const toolUseTurnEvents = [
  messageStart("msg_1", {
    input_tokens: 100,
    output_tokens: 1,
    cache_read_input_tokens: 80,
  }),
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Search first." },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "sig-1" },
  },
  { type: "content_block_stop", index: 0 },
  { type: "ping" },
  {
    type: "content_block_start",
    index: 1,
    content_block: {
      type: "redacted_thinking",
      data: "opaque",
    },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "content_block_start",
    index: 2,
    content_block: {
      type: "tool_use",
      id: "toolu_1",
      name: "web_search",
      input: {},
    },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: {
      type: "input_json_delta",
      partial_json: '{"query":"information theory inventor"}',
    },
  },
  { type: "content_block_stop", index: 2 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 20 },
  },
  { type: "message_stop" },
]

const finalTurnEvents = [
  messageStart("msg_2", {
    input_tokens: 150,
    output_tokens: 1,
    cache_read_input_tokens: 120,
  }),
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Claude Shannon." },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 5 },
  },
  { type: "message_stop" },
]

function parseSse(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n")
      const event = lines
        .find((l) => l.startsWith("event:"))
        ?.slice(6)
        .trim()
      const data = lines
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim()
      return { event: event ?? "", data: JSON.parse(data ?? "null") as unknown }
    })
}

describe("native Messages transport, streaming", () => {
  test("streams one web_search round-trip from /v1/messages", async () => {
    const { deps, calls } = fakeDeps([toolUseTurnEvents, finalTurnEvents])
    const executor = new FakeExecutor()

    const response = await app(payload(true), deps, { executor }).request(
      "/",
      post,
    )
    const events = parseSse(await response.text())

    expect(response.status).toBe(200)
    expect(executor.searchCalls).toEqual(["information theory inventor"])
    expect(calls).toHaveLength(2)
    for (const call of calls) expect(call.payload.stream).toBe(true)

    expect(events.filter((e) => e.event === "message_start")).toHaveLength(1)
    const starts = events
      .filter((e) => e.event === "content_block_start")
      .map((e) => e.data as { index: number; content_block: { type: string } })
    expect(starts.map((s) => s.content_block.type)).toEqual([
      "thinking",
      "redacted_thinking",
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
    expect(starts.map((s) => s.index)).toEqual([0, 1, 2, 3, 4])
    expect(events.some((e) => e.event === "ping")).toBe(true)
    // Thinking and its signature reach the client as Copilot sent them.
    expect(
      events.some(
        (e) =>
          e.event === "content_block_delta"
          && (e.data as { delta: { type: string } }).delta.type
            === "signature_delta",
      ),
    ).toBe(true)

    // One terminal pair, carrying every turn's usage: start-of-turn input and
    // cache counts plus end-of-turn output.
    const deltas = events.filter((e) => e.event === "message_delta")
    expect(deltas).toHaveLength(1)
    expect((deltas[0].data as { usage: unknown }).usage).toEqual({
      input_tokens: 250,
      output_tokens: 25,
      cache_read_input_tokens: 200,
    })
    expect(events.filter((e) => e.event === "message_stop")).toHaveLength(1)
    expect(events.at(-1)?.event).toBe("message_stop")

    // Turn 2 replays signed and redacted thinking with the tool call.
    const turn2 = calls[1].payload.messages
    expect(turn2.at(-2)).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Search first.", signature: "sig-1" },
        { type: "redacted_thinking", data: "opaque" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "web_search",
          input: { query: "information theory inventor" },
        },
      ],
    } as unknown as (typeof turn2)[number])
    expect(turn2.at(-1)?.role).toBe("user")
  })

  test("keeps the cached prefix byte-stable across streamed turns", async () => {
    const { deps, calls } = fakeDeps([toolUseTurnEvents, finalTurnEvents])

    const response = await app(payload(true), deps).request("/", post)
    await response.text()

    expect(calls).toHaveLength(2)
    expect(cachePrefix(calls[1])).toBe(cachePrefix(calls[0]))
    expectMessagesPrefix(calls[0], calls[1])
  })

  test("a Messages-API model without the native opt-in keeps chat completions", async () => {
    const { deps } = fakeDeps([])
    let chatCalls = 0
    const chatStub: WebToolsUpstreamDeps["createChatCompletions"] = () => {
      chatCalls++
      return Promise.resolve({
        [Symbol.asyncIterator]: function* () {
          yield { data: "[DONE]" }
        },
      } as unknown as Awaited<
        ReturnType<WebToolsUpstreamDeps["createChatCompletions"]>
      >)
    }

    const response = await app(
      payload(true),
      {
        ...deps,
        createChatCompletions: chatStub,
        createMessages: () => {
          throw new Error("native transport used without the opt-in")
        },
      },
      { nativeMessages: false },
    ).request("/", post)
    const text = await response.text()

    expect(chatCalls).toBe(1)
    expect(text).not.toContain("event: error")
  })
})
