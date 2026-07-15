import { describe, expect, it } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { familyDefaultReasoningEffort } from "~/lib/config/config"
import { resolveModelProfile } from "~/lib/models/model-profile"

/** Minimal catalog Model with the given `supports` capability flags. */
function modelWith(id: string, supports: Record<string, unknown>): Model {
  return {
    id,
    name: id,
    capabilities: { supports },
  } as unknown as Model
}

describe("resolveModelProfile — intrinsic capability derivation", () => {
  it("marks an adaptive-thinking model as reasoning", () => {
    const profile = resolveModelProfile(
      modelWith("claude-opus-4.7", { adaptive_thinking: true }),
    )
    expect(profile.isReasoning).toBe(true)
  })

  it("marks a reasoning-effort-ladder model as reasoning (GPT-5.6 shape)", () => {
    // No adaptive_thinking, but a non-empty effort ladder — the exact shape that
    // used to slip past the id-branching predicates.
    const profile = resolveModelProfile(
      modelWith("gpt-5.6-sol", {
        reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
      }),
    )
    expect(profile.isReasoning).toBe(true)
  })

  it("marks a plain model as neither reasoning nor vision", () => {
    const profile = resolveModelProfile(modelWith("gpt-4o-mini", {}))
    expect(profile.isReasoning).toBe(false)
    expect(profile.supportsVision).toBe(false)
  })

  it("derives supportsVision from the single vision flag", () => {
    expect(
      resolveModelProfile(modelWith("gpt-5.6-terra", { vision: true }))
        .supportsVision,
    ).toBe(true)
    expect(
      resolveModelProfile(modelWith("some-text-model", { vision: false }))
        .supportsVision,
    ).toBe(false)
  })

  it("carries the forward id through", () => {
    expect(resolveModelProfile(modelWith("gpt-5.6-luna", {})).id).toBe(
      "gpt-5.6-luna",
    )
  })
})

describe("familyDefaultReasoningEffort — new-model-without-a-branch", () => {
  it("gives an unconfigured GPT-5.x reasoning model xhigh by default", () => {
    // The payoff: a brand-new gpt-5.7 needs NO config entry and NO code branch —
    // it inherits the family's high-effort default automatically.
    expect(familyDefaultReasoningEffort("gpt-5.7")).toBe("xhigh")
    expect(familyDefaultReasoningEffort("gpt-5.7-codex")).toBe("xhigh")
  })

  it("gives GPT-5.x mini/nano tiers low, matching gpt-5-mini", () => {
    expect(familyDefaultReasoningEffort("gpt-5.7-mini")).toBe("low")
    expect(familyDefaultReasoningEffort("gpt-5-nano")).toBe("low")
  })

  it("has no opinion outside the GPT-5.x family (falls through to global)", () => {
    expect(familyDefaultReasoningEffort("claude-opus-4.7")).toBeUndefined()
    expect(familyDefaultReasoningEffort("gpt-4o")).toBeUndefined()
    // Must not match gpt-50 / gpt-5000 etc. — the boundary is anchored.
    expect(familyDefaultReasoningEffort("gpt-50-turbo")).toBeUndefined()
  })
})
