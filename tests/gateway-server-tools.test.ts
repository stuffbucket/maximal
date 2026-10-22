import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import {
  normalizeToolSchema,
  translateToOpenAI,
} from "~/routes/messages/non-stream-translation"
import {
  mergeToolResultForClaude,
  prepareMessagesApiPayload,
  stripToolReferenceTurnBoundary,
} from "~/routes/messages/preprocess"
import { translateAnthropicMessagesToResponsesPayload } from "~/routes/messages/responses-translation"
import { splitWebTools } from "~/routes/messages/web-tools"

describe("normalizeToolSchema for schema-less server tools", () => {
  test("returns default empty object schema when input_schema is undefined or empty object", () => {
    expect(normalizeToolSchema(undefined)).toEqual({
      type: "object",
      properties: {},
    })
    expect(normalizeToolSchema({})).toEqual({
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

    prepareMessagesApiPayload(payload)
    expect(payload.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Tool WebFetch loaded" },
          { type: "text", text: "Use WebFetch now" },
        ],
      },
    ])
  })

  test("splitWebTools intercepts 20260209 dynamic-filtering web_search and web_fetch tools", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-5.5",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "web_search_20260209",
          name: "web_search",
        } as unknown as NonNullable<AnthropicMessagesPayload["tools"]>[number],
        {
          type: "web_fetch_20260209",
          name: "web_fetch",
        } as unknown as NonNullable<AnthropicMessagesPayload["tools"]>[number],
      ],
    }

    const policy = splitWebTools(payload)
    expect(policy.hasSearch).toBe(true)
    expect(policy.hasFetch).toBe(true)
    expect(payload.tools).toEqual([])
  })

  test("stripToolReferenceTurnBoundary rewrites top-level tool_reference before mergeToolResultForClaude", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-5.5",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_search",
              content: "found WebFetch",
            },
            {
              type: "tool_reference",
              tool_name: "WebFetch",
            },
            {
              type: "text",
              text: "Tool loaded.",
            },
          ],
        },
      ],
    }

    stripToolReferenceTurnBoundary(payload)
    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_search",
          content: "found WebFetch\n\nTool WebFetch loaded",
        },
      ],
    })
  })
})
