import { describe, expect, it } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { familyDefaultReasoningEffort } from "~/lib/config/config"
import { resolveModelProfile } from "~/lib/models/model-profile"

/** Minimal catalog Model with the given `supports` + `limits` capability maps. */
function modelWith(
  id: string,
  supports: Record<string, unknown>,
  limits: Record<string, unknown> = {},
): Model {
  return {
    id,
    name: id,
    capabilities: { supports, limits },
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

  it("resolves a plain model to conservative (unsupported / zero) defaults", () => {
    const profile = resolveModelProfile(modelWith("gpt-4o-mini", {}))
    expect(profile.isReasoning).toBe(false)
    expect(profile.supportsVision).toBe(false)
    expect(profile.supportsAdaptiveThinking).toBe(false)
    expect(profile.supportsToolCalls).toBe(false)
    expect(profile.supportsStructuredOutputs).toBe(false)
    expect(profile.reasoningEffortLadder).toBeUndefined()
    expect(profile.maxThinkingBudget).toBe(0)
    expect(profile.minThinkingBudget).toBe(1024) // historical default floor
    expect(profile.maxContextWindowTokens).toBe(0)
    expect(profile.maxOutputTokens).toBe(0)
    expect(profile.maxPromptTokens).toBe(0)
  })

  it("resolves token limits and capability flags from a populated model", () => {
    const profile = resolveModelProfile(
      modelWith(
        "some-model",
        {
          vision: true,
          tool_calls: true,
          structured_outputs: true,
          max_thinking_budget: 32_000,
          min_thinking_budget: 2048,
        },
        {
          max_context_window_tokens: 1_000_000,
          max_output_tokens: 64_000,
          max_prompt_tokens: 900_000,
        },
      ),
    )
    expect(profile.supportsVision).toBe(true)
    expect(profile.supportsToolCalls).toBe(true)
    expect(profile.supportsStructuredOutputs).toBe(true)
    expect(profile.maxThinkingBudget).toBe(32_000)
    expect(profile.minThinkingBudget).toBe(2048)
    expect(profile.maxContextWindowTokens).toBe(1_000_000)
    expect(profile.maxOutputTokens).toBe(64_000)
    expect(profile.maxPromptTokens).toBe(900_000)
  })

  it("keeps adaptive thinking and the effort ladder as INDEPENDENT flags", () => {
    // The design crux: a Copilot-served adaptive Claude model carries BOTH a
    // budget mechanism (adaptive_thinking) AND an effort ladder that
    // applyAdaptiveThinking clamps into. An exclusive budget|effort union would
    // drop one — so the profile exposes them separately.
    const profile = resolveModelProfile(
      modelWith("claude-opus-4.7", {
        adaptive_thinking: true,
        reasoning_effort: ["low", "medium", "high"],
      }),
    )
    expect(profile.supportsAdaptiveThinking).toBe(true)
    expect(profile.reasoningEffortLadder).toEqual(["low", "medium", "high"])
  })

  it("resolves an empty effort ladder to undefined, not [] (clamp-skip trap)", () => {
    // undefined — not [] — so the applyAdaptiveThinking clamp is skipped rather
    // than corrupting effort via `[].at(-1)`.
    const profile = resolveModelProfile(
      modelWith("weird-model", { reasoning_effort: [] }),
    )
    expect(profile.reasoningEffortLadder).toBeUndefined()
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
