import { describe, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import {
  isClaudeTierClass,
  isGptClass,
  isSmallGptClass,
} from "~/lib/models/model-identity"

function identityModel(id: unknown, family: unknown, vendor: unknown): Model {
  return {
    id,
    vendor,
    capabilities: { family },
  } as unknown as Model
}

describe("Claude tier identity", () => {
  test("accepts a Claude signal from family or id, case-insensitively", () => {
    expect(
      isClaudeTierClass(
        identityModel("opaque", "Claude-Haiku", "other"),
        "haiku",
      ),
    ).toBe(true)
    expect(
      isClaudeTierClass(
        identityModel("CLAUDE-SONNET-X", "opaque", "other"),
        "sonnet",
      ),
    ).toBe(true)
  })

  test("requires both the Claude and requested tier signals", () => {
    expect(
      isClaudeTierClass(identityModel("opaque", "haiku", "anthropic"), "haiku"),
    ).toBe(false)
    expect(
      isClaudeTierClass(
        identityModel("claude-opus", "claude", "anthropic"),
        "haiku",
      ),
    ).toBe(false)
    expect(
      isClaudeTierClass(
        identityModel("claude-haiku", "claude", "anthropic"),
        "sonnet",
      ),
    ).toBe(false)
  })

  test("treats sparse and malformed identities as non-Claude", () => {
    expect(isClaudeTierClass(identityModel(42, null, null), "haiku")).toBe(
      false,
    )
    expect(
      isClaudeTierClass({ capabilities: {} } as unknown as Model, "sonnet"),
    ).toBe(false)
  })
})

describe("GPT identity", () => {
  test("recognizes GPT independently by id, family, or vendor", () => {
    expect(isGptClass(identityModel("gpt-special", "other", "other"))).toBe(
      true,
    )
    expect(isGptClass(identityModel("opaque", "family-gpt", "other"))).toBe(
      true,
    )
    expect(isGptClass(identityModel("opaque", "other", "OpenAI"))).toBe(true)
  })

  test("rejects unrelated and malformed identities", () => {
    expect(isGptClass(identityModel("gemini", "flash", "google"))).toBe(false)
    expect(isGptClass(identityModel(42, null, null))).toBe(false)
  })
})

describe("small GPT identity", () => {
  test.each([
    ["gpt-mini", "gpt", "other"],
    ["gpt.nano", "gpt", "other"],
    ["gpt", "gpt_small_v2", "other"],
    ["gpt", "mini", "openai"],
  ])("recognizes bounded small-class names %#", (id, family, vendor) => {
    expect(isSmallGptClass(identityModel(id, family, vendor))).toBe(true)
  })

  test.each([
    ["gptmini", "gpt", "other"],
    ["gpt-minimum", "gpt", "other"],
    ["vendor-mini", "mini", "other"],
    ["gemini", "small", "google"],
  ])("rejects partial or non-GPT small names %#", (id, family, vendor) => {
    expect(isSmallGptClass(identityModel(id, family, vendor))).toBe(false)
  })
})
