import { describe, expect, test } from "bun:test"

import type {
  AnthropicMessagesPayload,
  AnthropicTool,
} from "~/lib/models/anthropic-types"

import { splitWebTools } from "~/routes/messages/web-tools/rewriter"

const basePayload = (
  tools: Array<AnthropicTool>,
): AnthropicMessagesPayload => ({
  model: "claude-opus-5",
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  tools,
})

describe("splitWebTools", () => {
  test("preserves unrelated server-tool discriminators", () => {
    const webSearch = {
      type: "web_search_20250305",
      name: "web_search",
    } as unknown as AnthropicTool
    const advisor = {
      type: "advisor_20260301",
      name: "advisor",
      model: "claude-opus-5",
    } as unknown as AnthropicTool
    const payload = basePayload([webSearch, advisor])

    const policy = splitWebTools(payload)

    expect(policy.declarations).toHaveLength(1)
    expect(payload.tools).toEqual([advisor])
  })
})
