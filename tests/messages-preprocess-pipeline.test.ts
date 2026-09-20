import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import {
  prepareMessagesApiPayload,
  stripToolReferenceTurnBoundary,
} from "../src/routes/messages/preprocess"

// Mutation-coverage for the pre-request pipeline helpers OUTSIDE the
// thinking/effort block of prepareMessagesApiPayload: hasToolRef,
// stripCacheControl / stripCacheControlScope, filterAssistantThinkingBlocks,
// and the adaptive branch of stripSamplingParams. Closes pre-existing Stryker
// gaps. Payloads reach this code from an unauthenticated `c.req.json()` with no
// schema validation, so malformed shapes (null system blocks, string
// cache_control, thinking blocks on user turns, non-array content) are all
// reachable inputs, not hypotheticals.

const nonAdaptiveModel = {
  capabilities: { supports: { adaptive_thinking: false } },
} as never

describe("stripToolReferenceTurnBoundary — hasToolRef predicate (line 492)", () => {
  // 492:8 `.some` -> `.every`. Mixed content (a tool_reference plus a text
  // block): `.some` sees the reference and strips the boundary; `.every` would
  // not, because the text block fails the predicate.
  test("strips the boundary when only SOME tool_result content is a tool_reference", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [
                { type: "text", text: "some prose" },
                { type: "tool_reference", tool_name: "AskUserQuestion" },
              ],
            },
            { type: "text", text: "Tool loaded." },
          ],
        },
      ],
    }

    stripToolReferenceTurnBoundary(payload)

    expect(payload.messages[0].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: [
          { type: "text", text: "some prose" },
          { type: "tool_reference", tool_name: "AskUserQuestion" },
        ],
      },
    ])
  })

  // 492:34 `c.type === "tool_reference"` -> `true`. Array content with NO
  // reference: real predicate is false so the boundary is kept; the `true`
  // mutant treats the text block as a reference and strips "Tool loaded.".
  test("keeps the boundary when array tool_result content has no tool_reference", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [{ type: "text", text: "plain result" }],
            },
            { type: "text", text: "Tool loaded." },
          ],
        },
      ],
    }

    stripToolReferenceTurnBoundary(payload)

    expect(payload.messages[0].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: [{ type: "text", text: "plain result" }],
      },
      { type: "text", text: "Tool loaded." },
    ])
  })
})

describe("prepareMessagesApiPayload — stripCacheControlScope guards (497, 500)", () => {
  // 497:7 `if (!obj || typeof obj !== "object") return` -> `if(false)` / `&&`.
  // A null system block: real code returns early; the mutants fall through and
  // dereference null.cache_control, throwing.
  test("tolerates a null system block (line 497 null-guard)", () => {
    const payload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      system: [null],
      messages: [{ role: "user", content: "hello" }],
    } as unknown as AnthropicMessagesPayload

    expect(() =>
      prepareMessagesApiPayload(payload, nonAdaptiveModel),
    ).not.toThrow()
  })

  // 500:7 `if (cc && typeof cc === "object")` -> `if(true)` / `cc || ...`.
  // cache_control is null: real code skips; both mutants destructure null.
  test("tolerates a null cache_control on a system block (line 500 truthiness)", () => {
    const payload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      system: [{ type: "text", text: "sys", cache_control: null }],
      messages: [{ role: "user", content: "hello" }],
    } as unknown as AnthropicMessagesPayload

    expect(() =>
      prepareMessagesApiPayload(payload, nonAdaptiveModel),
    ).not.toThrow()
    const sys = payload.system as unknown as Array<Record<string, unknown>>
    expect(sys[0].cache_control).toBeNull()
  })

  // 500:13 `cc && typeof cc === "object"` -> `cc && true`. A string
  // cache_control is truthy but not an object: real code leaves it; the mutant
  // spreads it into a char-index object.
  test("leaves a non-object cache_control untouched (line 500 type check)", () => {
    const payload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      system: [{ type: "text", text: "sys", cache_control: "keep-me" }],
      messages: [{ role: "user", content: "hello" }],
    } as unknown as AnthropicMessagesPayload

    prepareMessagesApiPayload(payload, nonAdaptiveModel)

    const sys = payload.system as unknown as Array<Record<string, unknown>>
    expect(sys[0].cache_control).toBe("keep-me")
  })
})

describe("prepareMessagesApiPayload — stripCacheControl tools + tool_result", () => {
  // 519:7 `if (payload.tools)` -> `if(false)`, plus the 519:22 / 520:39 loop
  // body removals. Real code strips scope AND eager_input_streaming per tool.
  test("strips scope and eager_input_streaming from tools (lines 519-520)", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      tools: [
        {
          name: "do_thing",
          input_schema: { type: "object" },
          eager_input_streaming: true,
          cache_control: { type: "ephemeral", scope: "user" },
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    }

    prepareMessagesApiPayload(payload, nonAdaptiveModel)

    expect(payload.tools?.[0].eager_input_streaming).toBeUndefined()
    expect(payload.tools?.[0].cache_control).toEqual({ type: "ephemeral" })
  })

  // Kills the 526-533 for-loop body removals and the 528:38, 529:26 ("" ->
  // type), 529:43 (dropped `!`), and 533:35 (delete body) mutants: cache_control
  // nested inside a well-formed tool_result.content[] item must be deleted.
  test("strips cache_control nested inside tool_result content (lines 526-533)", () => {
    const payload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [
                {
                  type: "text",
                  text: "inner",
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    prepareMessagesApiPayload(payload, nonAdaptiveModel)

    const inner = (
      payload.messages[0].content as unknown as Array<{
        content: Array<Record<string, unknown>>
      }>
    )[0].content[0]
    expect("cache_control" in inner).toBe(false)
  })

  // 527:9 `if (!Array.isArray(msg.content)) continue` -> `if(false) continue`.
  // Non-iterable message content (null): real code skips; the mutant runs
  // `for (const block of null)` and throws. A string would not distinguish
  // (its chars are skipped by 529), so a non-iterable is required.
  test("skips non-array message content instead of iterating it (line 527 guard)", () => {
    const payload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      messages: [{ role: "user", content: null }],
    } as unknown as AnthropicMessagesPayload

    expect(() =>
      prepareMessagesApiPayload(payload, nonAdaptiveModel),
    ).not.toThrow()
  })

  // 529:11 `block.type !== "tool_result" || ...` -> `false || ...`. Dropping the
  // type guard makes ANY block with an array `content` get its inner
  // cache_control stripped; a non-tool_result block must be left untouched.
  test("only strips cache_control inside tool_result blocks (line 529 type guard)", () => {
    const payload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "x",
              content: [
                {
                  type: "text",
                  text: "inner",
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    prepareMessagesApiPayload(payload, nonAdaptiveModel)

    const outer = (
      payload.messages[0].content as unknown as Array<{
        content: Array<Record<string, unknown>>
      }>
    )[0]
    expect("cache_control" in outer.content[0]).toBe(true)
  })
})

describe("prepareMessagesApiPayload — filterAssistantThinkingBlocks (547)", () => {
  // 547:9 `msg.role === "assistant" && Array.isArray(msg.content)` -> `||`.
  // String-content assistant message: real code skips (content is not an
  // array); the `||` mutant calls "string".filter(...) and throws.
  test("does not filter string-content assistant messages (line 547 conjunction)", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      messages: [{ role: "assistant", content: "plain assistant reply" }],
    }

    expect(() =>
      prepareMessagesApiPayload(payload, nonAdaptiveModel),
    ).not.toThrow()
    expect(payload.messages[0].content).toBe("plain assistant reply")
  })

  // 547:9 `... && ...` -> `true && ...`. A thinking block on a USER turn: real
  // code only filters assistant turns so it is kept; dropping the role check
  // filters the user turn and discards the block.
  test("does not filter thinking blocks on non-assistant turns (line 547 role check)", () => {
    const payload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "thinking", thinking: "Thinking...", signature: "sig" },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    prepareMessagesApiPayload(payload, nonAdaptiveModel)

    expect(payload.messages[0].content).toEqual([
      { type: "thinking", thinking: "Thinking...", signature: "sig" },
    ])
  })
})

describe("prepareMessagesApiPayload — stripSamplingParams adaptive branch (573)", () => {
  // 573:7 optional chaining `selectedModel?.` -> `selectedModel.`. No model
  // resolved (findEndpointModel can return undefined): real code skips the
  // branch; the mutant dereferences undefined.capabilities and throws.
  test("tolerates an undefined selectedModel (line 573 optional chaining)", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    }

    expect(() => prepareMessagesApiPayload(payload, undefined)).not.toThrow()
  })

  // 573:7 `if(false)` and 573:63 body removal. An adaptive-thinking model must
  // strip temperature, top_p AND top_k. The pre-existing suite only asserted
  // the non-adaptive top_p drop, so temperature/top_k removal on an adaptive
  // model was never pinned. (The 579 fallback still drops top_p regardless.)
  test("adaptive-thinking model strips temperature, top_p, and top_k (line 573 body)", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.7",
      max_tokens: 64,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      messages: [{ role: "user", content: "hello" }],
    }

    prepareMessagesApiPayload(payload, {
      capabilities: { supports: { adaptive_thinking: true } },
    } as never)

    expect(payload.temperature).toBeUndefined()
    expect(payload.top_p).toBeUndefined()
    expect(payload.top_k).toBeUndefined()
  })
})
