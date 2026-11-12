import { describe, expect, it } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"
import type { ResponseInputMessage } from "~/services/copilot/create-responses"

import { translateAnthropicMessagesToResponsesPayload } from "~/routes/messages/responses-translation"

const PNG = { type: "base64", media_type: "image/png", data: "aGk=" } as const
const PNG_URL = "data:image/png;base64,aGk="

const messagesPayload = (messages: Array<unknown>): AnthropicMessagesPayload =>
  ({
    model: "gpt-4.1",
    max_tokens: 1024,
    messages,
  }) as unknown as AnthropicMessagesPayload

describe("Anthropic image blocks to Responses input_image", () => {
  it("translates a user image block", () => {
    const result = translateAnthropicMessagesToResponsesPayload(
      messagesPayload([
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", source: PNG },
          ],
        },
      ]),
    )

    const [message] = result.input as Array<ResponseInputMessage>
    expect(message.content).toEqual([
      { type: "input_text", text: "what is this?" },
      { type: "input_image", image_url: PNG_URL, detail: "auto" },
    ])
  })

  it("translates an image inside a tool result", () => {
    const result = translateAnthropicMessagesToResponsesPayload(
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

    const output = (result.input as Array<Record<string, unknown>>).find(
      (item) => item.type === "function_call_output",
    )
    expect(output?.output).toEqual([
      { type: "input_image", image_url: PNG_URL, detail: "auto" },
    ])
  })
})
