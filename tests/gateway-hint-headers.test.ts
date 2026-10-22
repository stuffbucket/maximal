import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import { COMPACT_REQUEST } from "~/lib/models/compact"
import { getCompactType } from "~/routes/messages/preprocess"
import { parseSubagentMarkerFromFirstUser } from "~/routes/messages/subagent-marker"

describe("gateway hint headers support", () => {
  const basePayload: AnthropicMessagesPayload = {
    model: "claude-opus-4.6",
    max_tokens: 128,
    messages: [{ role: "user", content: "find files" }],
  }

  test("parseSubagentMarkerFromFirstUser falls back to hint headers when prompt marker is absent", () => {
    expect(
      parseSubagentMarkerFromFirstUser(basePayload, {
        requestClass: "subagent",
        agentType: "Explore",
        sessionId: "sess-123",
      }),
    ).toEqual({
      session_id: "sess-123",
      agent_id: "subagent",
      agent_type: "Explore",
    })

    expect(
      parseSubagentMarkerFromFirstUser(basePayload, {
        requestClass: "interactive",
        agentType: "Explore",
      }),
    ).toBeNull()
  })

  test("getCompactType recognizes x-claude-code-compaction header values", () => {
    for (const mode of ["manual", "auto", "reactive", "snip", "background"]) {
      expect(getCompactType(basePayload, mode)).toBe(COMPACT_REQUEST)
    }
    expect(getCompactType(basePayload, undefined)).toBe(0)
  })
})
