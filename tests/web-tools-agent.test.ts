import { describe, expect, it } from "bun:test"

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicToolUseBlock,
} from "~/lib/anthropic-types"
import type { Executor } from "~/routes/messages/web-tools/executor"
import type { WebToolPolicy } from "~/routes/messages/web-tools/rewriter"

import { runAgentLoop } from "~/routes/messages/web-tools/agent"
import { MAX_AGENT_TURNS } from "~/routes/messages/web-tools/vocab"

import { FakeExecutor } from "./helpers/fake-executor"

const basePayload: AnthropicMessagesPayload = {
  model: "claude-3-5-sonnet",
  max_tokens: 1024,
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
}

const searchPolicy: WebToolPolicy = {
  declarations: [
    {
      type: "web_search_20250305",
      name: "web_search",
    },
  ],
  hasSearch: true,
  hasFetch: false,
}

function makeResponse(
  content: Array<AnthropicAssistantContentBlock>,
  stop_reason: AnthropicResponse["stop_reason"] = "end_turn",
): AnthropicResponse {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content,
    model: "claude-3-5-sonnet",
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function searchToolUse(id: string, query: string): AnthropicToolUseBlock {
  return { type: "tool_use", id, name: "web_search", input: { query } }
}

// Hoisted callOnce helper for tests that need it at outer scope (lint
// rule unicorn/consistent-function-scoping).
const fixedTextCallOnce = (text: string) => (_p: AnthropicMessagesPayload) =>
  Promise.resolve(makeResponse([{ type: "text", text }]))

// ────────────────────────────────────────────────────────────────────
// Tests.
// ────────────────────────────────────────────────────────────────────

describe("runAgentLoop", () => {
  it("rewrites a single web_search round-trip into server_tool_use + result", async () => {
    const responses: Array<AnthropicResponse> = [
      makeResponse([searchToolUse("toolu_1", "shannon")], "tool_use"),
      makeResponse([
        { type: "text", text: "Claude Shannon was born in 1916." },
      ]),
    ]
    let turn = 0
    const callOnce = (_p: AnthropicMessagesPayload) =>
      Promise.resolve(responses[turn++])

    const result = await runAgentLoop({
      initialPayload: basePayload,
      policy: searchPolicy,
      executor: new FakeExecutor(),
      callOnce,
    })

    expect(turn).toBe(2)
    const types = (result.content as unknown as Array<{ type: string }>).map(
      (b) => b.type,
    )
    expect(types).toEqual(["server_tool_use", "web_search_tool_result", "text"])
    const serverUse = result.content[0] as unknown as {
      type: string
      id: string
      name: string
      input: { query: string }
    }
    expect(serverUse.id).toBe("toolu_1")
    expect(serverUse.name).toBe("web_search")
    expect(serverUse.input.query).toBe("shannon")

    const resultBlock = result.content[1] as unknown as {
      type: string
      tool_use_id: string
      content: Array<{ url: string; title: string; encrypted_content: string }>
    }
    expect(resultBlock.tool_use_id).toBe("toolu_1")
    expect(resultBlock.content).toHaveLength(2)
    expect(resultBlock.content[0].url).toBe("https://example.com/a")
    expect(resultBlock.content[0].encrypted_content.length).toBeGreaterThan(0)
  })

  it("emits an error block on max_uses_exceeded without invoking executor again", async () => {
    const policy: WebToolPolicy = {
      declarations: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 1,
        },
      ],
      hasSearch: true,
      hasFetch: false,
    }
    const responses: Array<AnthropicResponse> = [
      makeResponse([searchToolUse("toolu_1", "first")], "tool_use"),
      makeResponse([searchToolUse("toolu_2", "second")], "tool_use"),
      makeResponse([{ type: "text", text: "done" }]),
    ]
    let turn = 0
    const callOnce = (_p: AnthropicMessagesPayload) =>
      Promise.resolve(responses[turn++])
    const exec = new FakeExecutor()

    const result = await runAgentLoop({
      initialPayload: basePayload,
      policy,
      executor: exec,
      callOnce,
    })

    expect(exec.searchCalls).toEqual(["first"])
    const looseContent = result.content as unknown as Array<{
      type: string
      content?: { error_code?: string }
    }>
    expect(looseContent.map((b) => b.type)).toContain(
      "web_search_tool_result_error",
    )
    const errorBlock = looseContent.find(
      (b) => b.type === "web_search_tool_result_error",
    )
    expect(errorBlock?.content?.error_code).toBe("max_uses_exceeded")
  })

  it("passes through plain text response unchanged when no tool_use", async () => {
    const result = await runAgentLoop({
      initialPayload: basePayload,
      policy: searchPolicy,
      executor: new FakeExecutor(),
      callOnce: fixedTextCallOnce("no search needed"),
    })

    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({
      type: "text",
      text: "no search needed",
    })
  })

  it("preserves non-web tool_use blocks unchanged", async () => {
    const customTool: AnthropicToolUseBlock = {
      type: "tool_use",
      id: "toolu_x",
      name: "my_custom_tool",
      input: { foo: "bar" },
    }
    const callOnce = (_p: AnthropicMessagesPayload) =>
      Promise.resolve(makeResponse([customTool], "tool_use"))

    const result = await runAgentLoop({
      initialPayload: basePayload,
      policy: searchPolicy,
      executor: new FakeExecutor(),
      callOnce,
    })

    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual(customTool)
  })

  it("terminates at MAX_AGENT_TURNS even if model keeps emitting web_search", async () => {
    let calls = 0
    const callOnce = (_p: AnthropicMessagesPayload) => {
      calls++
      return Promise.resolve(
        makeResponse(
          [searchToolUse(`toolu_${calls}`, `q${calls}`)],
          "tool_use",
        ),
      )
    }

    await runAgentLoop({
      initialPayload: basePayload,
      policy: {
        declarations: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 100,
          },
        ],
        hasSearch: true,
        hasFetch: false,
      },
      executor: new FakeExecutor(),
      callOnce,
    })

    expect(calls).toBeLessThanOrEqual(MAX_AGENT_TURNS)
  })

  it("appends synthesized assistant + user messages on each turn", async () => {
    // Snapshot lengths/roles synchronously: the agent reuses the same
    // messages array across turns, so a stored reference would observe
    // later mutations.
    const turnLens: Array<number> = []
    const turn2: { roles?: Array<string>; trType?: string } = {}
    const responses: Array<AnthropicResponse> = [
      makeResponse([searchToolUse("toolu_1", "q1")], "tool_use"),
      makeResponse([{ type: "text", text: "answer" }]),
    ]
    let turn = 0
    const callOnce = (p: AnthropicMessagesPayload) => {
      turnLens.push(p.messages.length)
      if (turn === 1) {
        turn2.roles = p.messages.map((m) => m.role)
        const last = p.messages.at(-1)
        if (last !== undefined) {
          const first = (last.content as Array<{ type: string }>)[0]
          turn2.trType = first.type
        }
      }
      return Promise.resolve(responses[turn++])
    }

    await runAgentLoop({
      initialPayload: basePayload,
      policy: searchPolicy,
      executor: new FakeExecutor(),
      callOnce,
    })

    expect(turnLens).toEqual([1, 3])
    expect(turn2.roles).toEqual(["user", "assistant", "user"])
    expect(turn2.trType).toBe("tool_result")
  })
})

describe("runAgentLoop — domain filtering", () => {
  it("post-filters search results to the declared allowed_domains", async () => {
    // The executor returns mixed hosts (a backend may ignore the domain
    // filter); the agent loop must drop hits outside the allowlist so the
    // client's constraint holds regardless.
    const mixedHostExecutor: Executor = {
      fetch: () => Promise.resolve({ ok: true, markdown: "" }),
      search: (_query, opts) => {
        // The declared domains are forwarded to the executor too.
        expect(opts?.allowedDomains).toEqual(["docs.python.org"])
        return Promise.resolve({
          ok: true,
          items: [
            { url: "https://docs.python.org/3/", title: "In", page_age: null },
            { url: "https://evil.example/x", title: "Out", page_age: null },
            {
              url: "https://sub.docs.python.org/y",
              title: "Sub allowed",
              page_age: null,
            },
          ],
        })
      },
    }
    const policy: WebToolPolicy = {
      declarations: [
        {
          type: "web_search_20250305",
          name: "web_search",
          allowed_domains: ["docs.python.org"],
        },
      ],
      hasSearch: true,
      hasFetch: false,
    }
    const responses: Array<AnthropicResponse> = [
      makeResponse([searchToolUse("toolu_1", "asyncio")], "tool_use"),
      makeResponse([{ type: "text", text: "done" }]),
    ]
    let turn = 0
    const callOnce = (_p: AnthropicMessagesPayload) =>
      Promise.resolve(responses[turn++])

    const result = await runAgentLoop({
      initialPayload: basePayload,
      policy,
      executor: mixedHostExecutor,
      callOnce,
    })

    const resultBlock = result.content[1] as unknown as {
      content: Array<{ url: string }>
    }
    // evil.example dropped; docs.python.org and its subdomain kept.
    expect(resultBlock.content.map((r) => r.url)).toEqual([
      "https://docs.python.org/3/",
      "https://sub.docs.python.org/y",
    ])
  })
})
