import { describe, expect, it } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { translateAnthropicMessagesToResponsesPayload } from "~/routes/messages/responses-translation"
import { getResponsesRequestOptions } from "~/routes/responses/utils"

const PNG = { type: "base64", media_type: "image/png", data: "aGk=" } as const
const PNG_URL = "data:image/png;base64,aGk="

const responsesPayload = (
  input: ResponsesPayload["input"],
): ResponsesPayload => ({ model: "gpt-test", input })

const messagesPayload = (messages: Array<unknown>): AnthropicMessagesPayload =>
  ({
    model: "gpt-4.1",
    max_tokens: 1024,
    messages,
  }) as unknown as AnthropicMessagesPayload

describe("getResponsesRequestOptions vision detection", () => {
  it("is false for text-only input", () => {
    expect(getResponsesRequestOptions(responsesPayload("hello")).vision).toBe(
      false,
    )
    expect(
      getResponsesRequestOptions(
        responsesPayload([
          {
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ]),
      ).vision,
    ).toBe(false)
  })

  it("is true for an input_image in a user message", () => {
    const payload = responsesPayload([
      {
        role: "user",
        content: [
          { type: "input_text", text: "what is this?" },
          { type: "input_image", image_url: PNG_URL, detail: "auto" },
        ],
      },
    ])

    expect(getResponsesRequestOptions(payload).vision).toBe(true)
  })

  it("is true for an input_image in a function_call_output", () => {
    const payload = responsesPayload([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [{ type: "input_image", image_url: PNG_URL, detail: "auto" }],
      },
    ])

    expect(getResponsesRequestOptions(payload).vision).toBe(true)
  })

  it("is false for a function_call_output that is only text", () => {
    const payload = responsesPayload([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [{ type: "input_text", text: "done" }],
      },
    ])

    expect(getResponsesRequestOptions(payload).vision).toBe(false)
  })

  it("is true when a /v1/messages tool-result image is translated", () => {
    const translated = translateAnthropicMessagesToResponsesPayload(
      messagesPayload([
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_1", name: "screenshot", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [{ type: "image", source: PNG }],
            },
          ],
        },
      ]),
    )

    expect(getResponsesRequestOptions(translated).vision).toBe(true)
  })

  it("is true when a /v1/messages user image is translated", () => {
    const translated = translateAnthropicMessagesToResponsesPayload(
      messagesPayload([
        { role: "user", content: [{ type: "image", source: PNG }] },
      ]),
    )

    expect(getResponsesRequestOptions(translated).vision).toBe(true)
  })
})
