import { describe, expect, test } from "bun:test"

import { forwardId, reverseId } from "../src/lib/models/anthropic-id-rewrite"

describe("anthropic-id-rewrite", () => {
  const anthropicCases: Array<[string, string]> = [
    ["claude-opus-4.6", "claude-opus-4-6-20260301"],
    ["claude-opus-4.7-high", "claude-opus-4-7-high-20260301"],
    ["claude-opus-4.7-1m-internal", "claude-opus-4-7-1m-internal-20260301"],
    ["claude-haiku-4.5", "claude-haiku-4-5-20260301"],
    ["claude-sonnet-4.5", "claude-sonnet-4-5-20260301"],
  ]

  const passthroughCases = [
    "gpt-5.2",
    "gemini-3-flash-preview",
    "text-embedding-3-small",
    "claude-3-5-sonnet-20241022", // canonical Anthropic ID, no dot form
    "claude-sonnet-4", // already dashed, no minor
  ]

  test.each(anthropicCases)("forwardId(%s) -> %s", (input, expected) => {
    expect(forwardId(input)).toBe(expected)
  })

  test.each(anthropicCases)(
    "round-trip reverseId(forwardId(%s)) === %s",
    (input) => {
      expect(reverseId(forwardId(input))).toBe(input)
    },
  )

  test.each(passthroughCases)("forwardId passes through %s", (input) => {
    expect(forwardId(input)).toBe(input)
  })

  test.each(passthroughCases)("reverseId passes through %s", (input) => {
    expect(reverseId(input)).toBe(input)
  })

  test("reverseId accepts the original Copilot dot-form unchanged", () => {
    expect(reverseId("claude-opus-4.6")).toBe("claude-opus-4.6")
    expect(reverseId("claude-opus-4.7-high")).toBe("claude-opus-4.7-high")
  })
})
