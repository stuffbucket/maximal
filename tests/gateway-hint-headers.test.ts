import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import {
  COMPACT_AUTO_CONTINUE,
  COMPACT_REQUEST,
  compactAutoContinueClaudeCodePromptStart,
} from "~/lib/models/compact"
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

    expect(
      parseSubagentMarkerFromFirstUser(basePayload, {
        requestClass: "background_agent",
        sessionId: "   ",
      }),
    ).toEqual({
      session_id: "gateway-hint",
      agent_id: "background_agent",
      agent_type: "background_agent",
    })

    expect(
      parseSubagentMarkerFromFirstUser(
        {
          model: "claude-opus-4.6",
          max_tokens: 128,
          messages: [
            {
              role: "user",
              content:
                '<system-reminder>\n__SUBAGENT_MARKER__{"session_id":"s-1","agent_id":"a-1","agent_type":"Explore"}\n</system-reminder>\nfind files',
            },
          ],
        },
        undefined,
      ),
    ).toEqual({
      session_id: "s-1",
      agent_id: "a-1",
      agent_type: "Explore",
    })
  })

  test("getCompactType recognizes x-claude-code-compaction header values without masking COMPACT_AUTO_CONTINUE", () => {
    for (const mode of ["manual", "auto", "reactive", "snip", "background"]) {
      expect(getCompactType(basePayload, mode)).toBe(COMPACT_REQUEST)
    }
    expect(getCompactType(basePayload, undefined)).toBe(0)

    const autoContinuePayload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: compactAutoContinueClaudeCodePromptStart,
        },
      ],
    }
    expect(getCompactType(autoContinuePayload, "auto")).toBe(
      COMPACT_AUTO_CONTINUE,
    )
  })
})
