import { describe, expect, test } from "bun:test"

import { webToolListings } from "~/routes/messages/web-tools/listings"

import { FakeExecutor } from "./helpers/fake-executor"
import { NATIVE_SEARCH_GOLDEN } from "./helpers/server-tools-golden"
import {
  answerTurn,
  decideCall,
  decideTool,
  fakeDeps,
  finish,
  loopApp,
  messageStart,
  parseSse,
  payload,
  planFor,
  post,
  searchPolicy,
  textBlock,
  toolBlock,
} from "./helpers/server-tools-loop"

// Anthropic-native rendering (`web_search`) through the streaming loop, on
// its own and next to a hidden tool.

describe("anthropic-native server tools, streaming", () => {
  test("golden transcript: web_search renders as server_tool_use and a web_search_tool_result", async () => {
    const executor = new FakeExecutor()
    const body = payload(true)
    const plan = planFor(body, webToolListings(searchPolicy, executor), [
      "web_search",
    ])
    const searchTurn = [
      messageStart("msg_1", { input_tokens: 100, output_tokens: 1 }),
      ...textBlock(0, "Searching. "),
      ...toolBlock(1, {
        id: "toolu_1",
        name: "web_search",
        input: { query: "shannon" },
      }),
      ...finish("tool_use", 20),
    ]
    const finalTurn = [
      messageStart("msg_2", { input_tokens: 150, output_tokens: 1 }),
      ...textBlock(0, "Claude Shannon."),
      ...finish("end_turn", 5),
    ]
    const { deps } = fakeDeps([searchTurn, finalTurn])

    const res = await loopApp({ body, plan, deps, executor }).request("/", post)

    const events = parseSse(await res.text())
    expect(executor.searchCalls).toEqual(["shannon"])
    expect(events).toEqual(NATIVE_SEARCH_GOLDEN)
  })

  test("a hidden and an anthropic-native tool in one turn each render their own way", async () => {
    const executor = new FakeExecutor()
    const decide = decideTool()
    const body = payload(true)
    const plan = planFor(
      body,
      [decide.listing, ...webToolListings(searchPolicy, executor)],
      ["web_search"],
    )
    const both = [
      messageStart("msg_1", { input_tokens: 100, output_tokens: 1 }),
      ...toolBlock(0, decideCall),
      ...toolBlock(1, {
        id: "toolu_2",
        name: "web_search",
        input: { query: "shannon" },
      }),
      ...finish("tool_use", 20),
    ]
    const { deps, calls } = fakeDeps([both, answerTurn])

    const res = await loopApp({ body, plan, deps, executor }).request("/", post)
    const events = parseSse(await res.text())

    expect(calls).toHaveLength(2)
    const types = events
      .filter((e) => e.event === "content_block_start")
      .map(
        (e) =>
          (e.data as { index: number; content_block: { type: string } })
            .content_block.type,
      )
    expect(types).toEqual(["server_tool_use", "web_search_tool_result", "text"])
    // Both results went back to the model in one user message.
    const results = calls[1].payload.messages.at(-1)?.content as Array<{
      tool_use_id: string
    }>
    expect(results.map((r) => r.tool_use_id)).toEqual(["toolu_1", "toolu_2"])
  })
})
