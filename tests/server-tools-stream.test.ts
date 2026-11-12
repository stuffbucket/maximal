import type { SSEStreamingApi } from "hono/streaming"

import { describe, expect, test } from "bun:test"
import consola from "consola"

import type { UsageTokens } from "~/lib/token-usage"

import { runStreamingAgent } from "~/routes/messages/web-tools/stream"
import { MAX_AGENT_TURNS } from "~/routes/messages/web-tools/vocab"

import { FakeExecutor } from "./helpers/fake-executor"
import { HIDDEN_GOLDEN } from "./helpers/server-tools-golden"
import {
  answerTurn,
  callTurn,
  decideCall,
  decideInput,
  decideTool,
  fakeDeps,
  finish,
  loopApp,
  messageStart,
  noWebTools,
  parseSse,
  payload,
  planFor,
  post,
  textBlock,
  toolBlock,
} from "./helpers/server-tools-loop"

// A hidden, always-offered server tool through the streaming loop.

async function streamed(replies: Parameters<typeof fakeDeps>[0], delayMs = 0) {
  const decide = decideTool({ delayMs })
  const body = payload(true)
  const plan = planFor(body, [decide.listing])
  const { deps, calls } = fakeDeps(replies)
  const res = await loopApp({ body, plan, deps }).request("/", post)
  return { decide, calls, res, events: parseSse(await res.text()) }
}

describe("hidden server tool, streaming", () => {
  test("golden transcript: the text before the call streams, the call and its result never do", async () => {
    const { decide, calls, res, events } = await streamed([
      callTurn,
      answerTurn,
    ])

    expect(res.status).toBe(200)
    expect(decide.calls).toEqual([decideInput])
    expect(calls).toHaveLength(2)
    expect(events).toEqual(HIDDEN_GOLDEN)
  })

  test("the model gets the call and its result on the next turn", async () => {
    const { calls } = await streamed([callTurn, answerTurn])

    const turn2 = calls[1].payload.messages
    expect(turn2.at(-2)).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me check. " },
        { type: "tool_use", ...decideCall },
      ],
    })
    expect(turn2.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "option B" },
      ],
    })
  })

  test("keeps pings flowing while the tool runs, and writes nothing else for it", async () => {
    const decide = decideTool({ delayMs: 80 })
    const body = payload(true)
    const plan = planFor(body, [decide.listing])
    const { deps } = fakeDeps([callTurn, answerTurn])
    const written: Array<{ event: string; data: unknown }> = []
    const stream = {
      writeSSE: (msg: { event?: string; data: string }) => {
        written.push({
          event: msg.event ?? "",
          data: JSON.parse(msg.data) as unknown,
        })
        return Promise.resolve()
      },
    } as unknown as SSEStreamingApi

    await runStreamingAgent({
      initialPayload: body,
      policy: noWebTools,
      stream,
      executor: new FakeExecutor(),
      options: { requestId: "r", logger: consola.create({ level: 0 }) },
      transport: "messages",
      deps,
      serverTools: plan,
      heartbeatIntervalMs: 10,
    })

    const kinds = written.map((e) => e.event)
    const firstText = kinds.indexOf("content_block_stop")
    const secondText = kinds.indexOf("content_block_start", firstText)
    const pings = kinds.slice(firstText, secondText).filter((k) => k === "ping")
    expect(pings.length).toBeGreaterThanOrEqual(2)
    // Nothing the tool's call or result would have written.
    expect(JSON.stringify(written)).not.toContain("tool_use")
    expect(JSON.stringify(written)).not.toContain("tool_result")
    expect(kinds.at(-1)).toBe("message_stop")
  })

  test("a turn that also calls a client tool goes back to the client", async () => {
    const mixed = [
      messageStart("msg_1", { input_tokens: 100, output_tokens: 1 }),
      ...textBlock(0, "Checking. "),
      ...toolBlock(1, decideCall),
      ...toolBlock(2, { id: "toolu_2", name: "Read", input: { path: "/a" } }),
      ...finish("tool_use", 20),
    ]

    const { calls, events } = await streamed([mixed, answerTurn])

    // One upstream call: the client's tool result is not ours to supply.
    expect(calls).toHaveLength(1)
    const starts = events
      .filter((e) => e.event === "content_block_start")
      .map(
        (e) =>
          e.data as {
            index: number
            content_block: { type: string; name?: string }
          },
      )
    expect(
      starts.map((s) => [s.index, s.content_block.type, s.content_block.name]),
    ).toEqual([
      [0, "text", undefined],
      [1, "tool_use", "Read"],
    ])
    const delta = events.find((e) => e.event === "message_delta")
    expect(
      (delta?.data as { delta: { stop_reason: string } } | undefined)?.delta
        .stop_reason,
    ).toBe("tool_use")
  })

  test("running out of turns on hidden calls ends the turn instead of claiming a tool call", async () => {
    const { decide, calls, events } = await streamed([callTurn])

    expect(calls).toHaveLength(MAX_AGENT_TURNS)
    expect(decide.calls).toHaveLength(MAX_AGENT_TURNS)
    const deltas = events.filter((e) => e.event === "message_delta")
    expect(deltas).toHaveLength(1)
    expect(
      (deltas[0].data as { delta: { stop_reason: string } }).delta.stop_reason,
    ).toBe("end_turn")
    expect(JSON.stringify(events)).not.toContain('"tool_use"')
  })

  test("a failing tool is an error result for the model, not for the client", async () => {
    const decide = decideTool({
      result: {
        ok: false,
        code: "tool_error",
        toolResult: {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "it broke",
          is_error: true,
        },
      },
    })
    const body = payload(true)
    const plan = planFor(body, [decide.listing])
    const { deps, calls } = fakeDeps([callTurn, answerTurn])

    const res = await loopApp({ body, plan, deps }).request("/", post)
    const text = await res.text()

    expect(text).not.toContain("event: error")
    expect(JSON.stringify(calls[1].payload.messages.at(-1))).toContain(
      '"is_error":true',
    )
  })

  test("records the whole request's usage once", async () => {
    const decide = decideTool()
    const body = payload(true)
    const plan = planFor(body, [decide.listing])
    const { deps } = fakeDeps([callTurn, answerTurn])
    const recorded: Array<UsageTokens> = []

    const res = await loopApp({
      body,
      plan,
      deps,
      recordUsage: (usage) => void recorded.push(usage),
    }).request("/", post)
    await res.text()

    expect(recorded).toEqual([
      {
        input_tokens: 250,
        output_tokens: 25,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: undefined,
        total_tokens: undefined,
      },
    ])
  })
})
