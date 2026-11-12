import { describe, expect, test } from "bun:test"

import type { AnthropicResponse } from "~/lib/models/anthropic-types"
import type { UsageTokens } from "~/lib/token-usage"

import { MAX_AGENT_TURNS } from "~/routes/messages/web-tools/vocab"

import {
  answerTurn,
  callTurn,
  decideCall,
  decideTool,
  fakeDeps,
  loopApp,
  payload,
  planFor,
  post,
  reply,
  toolsBytes,
} from "./helpers/server-tools-loop"

// A hidden server tool through the buffered loop, and the prompt-cache
// stability of the tools array on both paths.

const callReply = reply({
  id: "msg_1",
  content: [
    { type: "text", text: "Let me check. " },
    { type: "tool_use", ...decideCall },
  ],
  stopReason: "tool_use",
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
  nano: 5,
})
const answerReply = reply({
  id: "msg_2",
  content: [{ type: "text", text: "Option B." }],
  stopReason: "end_turn",
  usage: { input_tokens: 150, output_tokens: 5, cache_read_input_tokens: 120 },
  nano: 7,
})

async function buffered(
  replies: Parameters<typeof fakeDeps>[0],
  recordUsage?: (usage: UsageTokens) => void,
) {
  const decide = decideTool()
  const body = payload(false)
  const plan = planFor(body, [decide.listing])
  const { deps, calls } = fakeDeps(replies)
  const res = await loopApp({ body, plan, deps, recordUsage }).request(
    "/",
    post,
  )
  return { decide, calls, res, json: (await res.json()) as AnthropicResponse }
}

describe("hidden server tool, non-streaming", () => {
  test("synthesizes one response without the call or its result", async () => {
    const { decide, calls, res, json } = await buffered([
      callReply,
      answerReply,
    ])

    expect(res.status).toBe(200)
    expect(decide.calls).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(json.content).toEqual([
      { type: "text", text: "Let me check. " },
      { type: "text", text: "Option B." },
    ])
    expect(json.stop_reason).toBe("end_turn")
    expect(json.usage).toEqual({
      input_tokens: 250,
      output_tokens: 25,
      cache_read_input_tokens: 200,
    })
    expect(json.copilot_usage).toEqual({ total_nano_aiu: 12 })
    expect(JSON.stringify(json)).not.toContain("tool_use")
  })

  test("hands a turn with a client tool call back, minus the hidden call", async () => {
    const mixed = reply({
      id: "msg_1",
      content: [
        { type: "text", text: "Checking. " },
        { type: "tool_use", ...decideCall },
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Read",
          input: { path: "/a" },
        },
      ],
      stopReason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20 },
    })

    const { calls, json } = await buffered([mixed, answerReply])

    expect(calls).toHaveLength(1)
    expect(json.stop_reason).toBe("tool_use")
    expect(json.content).toEqual([
      { type: "text", text: "Checking. " },
      { type: "tool_use", id: "toolu_2", name: "Read", input: { path: "/a" } },
    ])
  })

  test("running out of turns on hidden calls ends the turn", async () => {
    const { calls, json } = await buffered([callReply])

    expect(calls).toHaveLength(MAX_AGENT_TURNS)
    expect(json.stop_reason).toBe("end_turn")
    expect(JSON.stringify(json.content)).not.toContain("tool_use")
  })

  test("a hidden call cut off by max_tokens is not shown either", async () => {
    const cut = reply({
      id: "msg_1",
      content: [
        { type: "text", text: "Let me " },
        { type: "tool_use", id: "toolu_1", name: "decide", input: {} },
      ],
      stopReason: "max_tokens",
      usage: { input_tokens: 100, output_tokens: 1024 },
    })

    const { decide, calls, json } = await buffered([cut])

    expect(calls).toHaveLength(1)
    expect(decide.calls).toEqual([])
    expect(json.stop_reason).toBe("max_tokens")
    expect(json.content).toEqual([{ type: "text", text: "Let me " }])
  })

  test("records the whole request's usage once, with cost", async () => {
    const recorded: Array<UsageTokens> = []

    await buffered([callReply, answerReply], (usage) => {
      recorded.push(usage)
    })

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      input_tokens: 250,
      output_tokens: 25,
      cache_read_input_tokens: 200,
      total_nano_aiu: 12,
    })
  })
})

function severalTools() {
  const probe = decideTool().listing
  return [
    { ...probe, name: "zeta" },
    { ...probe, name: "alpha", description: "Alpha." },
    probe,
  ]
}

describe("the tools array is byte-identical across turns", () => {
  test("non-streaming", async () => {
    const body = payload(false)
    const plan = planFor(body, severalTools())
    const { deps, calls } = fakeDeps([callReply, answerReply])

    await (await loopApp({ body, plan, deps }).request("/", post)).json()

    expect(calls).toHaveLength(2)
    expect(toolsBytes(calls[1])).toBe(toolsBytes(calls[0]))
    expect(calls[0].payload.tools?.map((tool) => tool.name)).toEqual([
      "Read",
      "alpha",
      "decide",
      "zeta",
    ])
  })

  test("streaming", async () => {
    const body = payload(true)
    const plan = planFor(body, severalTools())
    const { deps, calls } = fakeDeps([callTurn, answerTurn])

    await (await loopApp({ body, plan, deps }).request("/", post)).text()

    expect(calls).toHaveLength(2)
    expect(toolsBytes(calls[1])).toBe(toolsBytes(calls[0]))
  })

  test("across client turns of one conversation, whatever order the providers list in", async () => {
    const send = async (
      messages: ReturnType<typeof payload>["messages"],
      order: ReturnType<typeof severalTools>,
    ) => {
      const body = { ...payload(false), messages }
      const plan = planFor(body, order)
      const { deps, calls } = fakeDeps([answerReply])
      await (await loopApp({ body, plan, deps }).request("/", post)).json()
      return toolsBytes(calls[0])
    }
    const tools = severalTools()
    const first = await send([{ role: "user", content: "hello" }], tools)
    const second = await send(
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
        { role: "user", content: "and now?" },
      ],
      [...tools].reverse(),
    )
    expect(second).toBe(first)
  })
})
