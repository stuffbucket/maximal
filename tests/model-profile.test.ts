import { describe, expect, it } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

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

  it("resolves a sparse/un-normalized entry to conservative defaults", () => {
    // No capabilities container at all — must not throw; everything defaults.
    const profile = resolveModelProfile({
      id: "sparse",
      name: "sparse",
    } as unknown as Model)
    expect(profile.isReasoning).toBe(false)
    expect(profile.supportsVision).toBe(false)
    expect(profile.id).toBe("sparse")
  })
})
