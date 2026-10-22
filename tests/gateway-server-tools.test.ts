import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import {
  normalizeToolSchema,
  translateToOpenAI,
} from "~/routes/messages/non-stream-translation"
import { translateAnthropicMessagesToResponsesPayload } from "~/routes/messages/responses-translation"

describe("normalizeToolSchema for schema-less server tools", () => {
  test("returns default empty object schema when input_schema is undefined", () => {
    expect(normalizeToolSchema(undefined)).toEqual({
      type: "object",
      properties: {},
    })
  })

  test("translateToOpenAI and translateAnthropicMessagesToResponsesPayload tolerate server tools without input_schema", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "advisor_20260301",
          name: "advisor",
        } as unknown as NonNullable<AnthropicMessagesPayload["tools"]>[number],
      ],
    }

    const openAiPayload = translateToOpenAI(payload)
    expect(openAiPayload.tools).toEqual([
      {
        type: "function",
        function: {
          name: "advisor",
          description: undefined,
          parameters: { type: "object", properties: {} },
        },
      },
    ])

    const responsesPayload =
      translateAnthropicMessagesToResponsesPayload(payload)
    expect(responsesPayload.tools).toEqual([
      {
        type: "function",
        name: "advisor",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ])
  })
})

describe("Responses translation of top-level tool_reference blocks", () => {
  test("converts top-level user tool_reference blocks into input_text", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_reference",
              tool_name: "WebFetch",
            },
            {
              type: "text",
              text: "Use WebFetch now",
            },
          ],
        },
      ],
    }

    const responsesPayload =
      translateAnthropicMessagesToResponsesPayload(payload)
    expect(responsesPayload.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Tool WebFetch loaded" },
          { type: "input_text", text: "Use WebFetch now" },
        ],
      },
    ])
  })
})
