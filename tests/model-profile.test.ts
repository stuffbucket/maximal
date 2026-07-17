import { describe, expect, it } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

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
    expect(
      resolveModelProfile(
        modelWith("claude-opus-4.7", { adaptive_thinking: true }),
      ).isReasoning,
    ).toBe(true)
  })

  it("marks a reasoning-effort-ladder model as reasoning (GPT-5.6 shape)", () => {
    // No adaptive_thinking, but a non-empty effort ladder — the shape that used
    // to slip past an adaptive_thinking-only predicate.
    expect(
      resolveModelProfile(
        modelWith("gpt-5.6-sol", {
          reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
        }),
      ).isReasoning,
    ).toBe(true)
  })

  it("marks a plain model as neither reasoning nor vision", () => {
    const profile = resolveModelProfile(modelWith("gpt-4o-mini", {}))
    expect(profile.isReasoning).toBe(false)
    expect(profile.supportsVision).toBe(false)
  })

  it("derives supportsVision from the single vision flag", () => {
    expect(
      resolveModelProfile(modelWith("m", { vision: true })).supportsVision,
    ).toBe(true)
    expect(
      resolveModelProfile(modelWith("m", { vision: false })).supportsVision,
    ).toBe(false)
  })

  it("resolves a sparse/un-normalized entry to conservative defaults", () => {
    // No capabilities at all — must not throw; everything defaults to false.
    const profile = resolveModelProfile({
      id: "sparse",
      name: "sparse",
    } as unknown as Model)
    expect(profile.isReasoning).toBe(false)
    expect(profile.supportsVision).toBe(false)
    expect(profile.id).toBe("sparse")
  })
})
