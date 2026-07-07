import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/lib/anthropic-types"
import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "../src/services/copilot/create-responses"

import {
  chatCompletionsInitiator,
  messagesInitiator,
  responsesInitiator,
} from "../src/services/copilot/agent-initiator"

// Pins the agent-vs-user initiator detection — the single source of truth that
// drives `x-initiator` and therefore Copilot credit accounting. These cases
// mirror the three previously-divergent inline implementations byte-for-byte so
// the unification stays behavior-preserving.

const messages = (
  messages: AnthropicMessagesPayload["messages"],
): AnthropicMessagesPayload => ({ model: "claude", messages, max_tokens: 1 })

const chat = (
  msgs: ChatCompletionsPayload["messages"],
): ChatCompletionsPayload => ({ model: "gpt", messages: msgs })

const resp = (input: ResponsesPayload["input"]): ResponsesPayload => ({
  model: "gpt",
  input,
})

describe("messagesInitiator (/v1/messages)", () => {
  test("last user message with real text is user-initiated", () => {
    expect(messagesInitiator(messages([{ role: "user", content: "hi" }]))).toBe(
      "user",
    )
  })

  test("last user message with array text block is user-initiated", () => {
    expect(
      messagesInitiator(
        messages([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
      ),
    ).toBe("user")
  })

  test("last user message with only tool_result is agent-initiated", () => {
    expect(
      messagesInitiator(
        messages([
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "out" },
            ],
          },
        ]),
      ),
    ).toBe("agent")
  })

  test("last assistant message is agent-initiated", () => {
    expect(
      messagesInitiator(
        messages([
          { role: "user", content: "hi" },
          { role: "assistant", content: "there" },
        ]),
      ),
    ).toBe("agent")
  })

  test("empty history is agent-initiated", () => {
    expect(messagesInitiator(messages([]))).toBe("agent")
  })
})

describe("chatCompletionsInitiator (/chat/completions)", () => {
  test("last tool message is agent-initiated", () => {
    expect(
      chatCompletionsInitiator(
        chat([
          { role: "user", content: "hi" },
          { role: "tool", content: "tool call" },
        ]),
      ),
    ).toBe("agent")
  })

  test("last assistant message is agent-initiated", () => {
    expect(
      chatCompletionsInitiator(chat([{ role: "assistant", content: "hey" }])),
    ).toBe("agent")
  })

  test("last user message is user-initiated", () => {
    expect(
      chatCompletionsInitiator(
        chat([
          { role: "user", content: "hi" },
          { role: "user", content: "again" },
        ]),
      ),
    ).toBe("user")
  })

  test("empty history is user-initiated", () => {
    expect(chatCompletionsInitiator(chat([]))).toBe("user")
  })
})

describe("responsesInitiator (/responses)", () => {
  test("empty / missing input is user-initiated", () => {
    expect(responsesInitiator(resp([]))).toBe("user")
    expect(responsesInitiator(resp(undefined))).toBe("user")
    expect(responsesInitiator(resp("plain string"))).toBe("user")
  })

  test("last item missing a role is agent-initiated", () => {
    expect(
      responsesInitiator(
        resp([
          {
            type: "function_call",
            call_id: "c1",
            name: "f",
            arguments: "{}",
          },
        ]),
      ),
    ).toBe("agent")
  })

  test("last assistant item is agent-initiated (case-insensitive)", () => {
    expect(
      responsesInitiator(resp([{ role: "assistant", content: "hey" }])),
    ).toBe("agent")
    expect(responsesInitiator(resp([{ role: "ASSISTANT" }]))).toBe("agent")
  })

  test("last user item is user-initiated", () => {
    expect(responsesInitiator(resp([{ role: "user", content: "hi" }]))).toBe(
      "user",
    )
  })
})
