import { describe, expect, test } from "bun:test"

import {
  contextManagementStrategy,
  getObservedContextManagementSupport,
  listObservedContextManagementCapabilities,
  observeContextManagementSupport,
} from "~/services/copilot/context-management-capabilities"

describe("context-management capability observations", () => {
  test("normalizes object key order while distinguishing strategy parameters", () => {
    const first = contextManagementStrategy({
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { value: 1000, type: "input_tokens" },
          keep: "all",
        },
      ],
    })
    const reordered = contextManagementStrategy({
      edits: [
        {
          keep: "all",
          trigger: { type: "input_tokens", value: 1000 },
          type: "clear_tool_uses_20250919",
        },
      ],
    })
    const different = contextManagementStrategy({
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: 2000 },
          keep: "all",
        },
      ],
    })

    expect(first).toBe(reordered)
    expect(first).not.toBe(different)
  })

  test("caches only rejections without a time-based expiry", () => {
    const scope = {
      account: "negative-cache-test",
      host: "https://api.example.test",
      model: "claude-test",
      strategy: "clear_thinking_20251015",
    }
    const observedAt = Date.parse("2026-09-19T00:00:00.000Z")

    observeContextManagementSupport(scope, "supported", observedAt)
    expect(getObservedContextManagementSupport(scope)).toBeNull()
    expect(listObservedContextManagementCapabilities()).not.toContainEqual(
      expect.objectContaining(scope),
    )

    observeContextManagementSupport(scope, "rejected", observedAt)
    expect(getObservedContextManagementSupport(scope)).toBe("rejected")
  })
})
