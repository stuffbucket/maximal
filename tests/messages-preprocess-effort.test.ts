import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import {
  getConfig,
  getReasoningEffortForModel,
  writeConfig,
} from "../src/lib/config/config"
import { prepareMessagesApiPayload } from "../src/routes/messages/preprocess"

// Mutation-rigor coverage for the reasoning-effort normalization block of
// prepareMessagesApiPayload (effort floor line ~613, supported-tier clamp
// line ~617, tool_choice disable-guard line ~596). These tests drive
// getReasoningEffortForModel() through config so each branch is exercised
// deterministically rather than relying on the static default map. Lives in
// its own companion file because messages-preprocess.test.ts already sits at
// the 800-line max-lines cap on main.

const adaptiveModel = (
  reasoningEffort?: Array<"low" | "medium" | "high">,
): never =>
  ({
    capabilities: {
      supports: {
        adaptive_thinking: true,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
    },
  }) as never

describe("prepareMessagesApiPayload — reasoning-effort normalization", () => {
  let original: ReturnType<typeof getConfig>

  beforeEach(() => {
    original = getConfig()
    writeConfig({
      ...original,
      modelReasoningEfforts: {
        ...original.modelReasoningEfforts,
        "test-effort-none": "none",
        "test-effort-minimal": "minimal",
        "test-effort-high": "high",
        "test-effort-medium": "medium",
      },
    })
  })

  afterEach(() => {
    writeConfig(original)
  })

  // 1. Effort floor: a resolved effort of "none" is coerced up to "low".
  //    With no reasoning_effort set on the model, the clamp never fires, so
  //    this isolates the floor. Kills `=== "none"` → false, `"none"` → "",
  //    the `if(false)`, and the empty-body mutant.
  test("floors a resolved effort of 'none' up to 'low'", () => {
    const payload: AnthropicMessagesPayload = {
      model: "test-effort-none",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    }

    prepareMessagesApiPayload(payload, adaptiveModel())

    expect(payload.output_config).toEqual({ effort: "low" })
  })

  // 1b. Same floor for "minimal". Needed alongside the "none" case to kill the
  //     `|| → &&` mutant and the `=== "minimal"` → false / `"minimal"` → ""
  //     mutants (the "none" case short-circuits the `||`, so it can't reach the
  //     second comparison).
  test("floors a resolved effort of 'minimal' up to 'low'", () => {
    const payload: AnthropicMessagesPayload = {
      model: "test-effort-minimal",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    }

    prepareMessagesApiPayload(payload, adaptiveModel())

    expect(payload.output_config).toEqual({ effort: "low" })
  })

  // 2. Supported-tier clamp: a resolved effort of "high" that is NOT in the
  //    model's advertised reasoning_effort set is clamped to the last element.
  //    Kills the `!`-removal, the whole-condition → false, and the empty-body
  //    mutants on the clamp line.
  test("clamps an unsupported effort to the last supported tier", () => {
    const payload: AnthropicMessagesPayload = {
      model: "test-effort-high",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    }

    prepareMessagesApiPayload(payload, adaptiveModel(["low", "medium"]))

    // "high" ∉ ["low","medium"] → clamp to reasoningEffort.at(-1) === "medium".
    expect(payload.output_config).toEqual({ effort: "medium" })
  })

  // 3. Passthrough: a resolved effort already inside the supported set is left
  //    untouched. Guards against over-clamping — e.g. dropping the `!` would
  //    wrongly clamp "medium" to the last tier ("high"), which this assertion
  //    catches.
  test("passes through an effort already within the supported set", () => {
    const payload: AnthropicMessagesPayload = {
      model: "test-effort-medium",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    }

    prepareMessagesApiPayload(payload, adaptiveModel(["low", "medium", "high"]))

    expect(payload.output_config).toEqual({ effort: "medium" })
  })

  // Covers the tool_choice disable-guard `type === "any"` branch (the existing
  // suite already covers the `"tool"` branch). Kills `=== "any"` → false / ""
  // and the optional-chaining mutant on that comparison.
  test("does not enable adaptive thinking when tool_choice forces any tool", () => {
    const payload: AnthropicMessagesPayload = {
      model: "test-effort-high",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      tool_choice: { type: "any" },
    }

    prepareMessagesApiPayload(payload, adaptiveModel())

    expect(payload.thinking).toBeUndefined()
    expect(payload.output_config).toBeUndefined()
  })
})

describe("getReasoningEffortForModel — model-aware baseline", () => {
  let original: ReturnType<typeof getConfig>

  beforeEach(() => {
    original = getConfig()
    // Clear user overrides so the fallback baseline is what's under test; the
    // static defaultConfig curated map (gpt-*) still applies underneath.
    writeConfig({ ...original, modelReasoningEfforts: {} })
  })

  afterEach(() => {
    writeConfig(original)
  })

  test("Claude models with no curated entry default to Anthropic's 'high'", () => {
    // "high" is Anthropic's own default (omitting output_config.effort == high).
    expect(getReasoningEffortForModel("claude-opus-4.8")).toBe("high")
    expect(getReasoningEffortForModel("claude-sonnet-4.6")).toBe("high")
    // Dated / variant forms still start with "claude".
    expect(getReasoningEffortForModel("claude-opus-4-8-20260301")).toBe("high")
  })

  test("non-Claude models with no curated entry fall to the 'medium' baseline", () => {
    expect(getReasoningEffortForModel("some-future-model")).toBe("medium")
  })

  test("a curated per-model default still wins over the baseline", () => {
    expect(getReasoningEffortForModel("gpt-5.4")).toBe("xhigh")
    expect(getReasoningEffortForModel("gpt-5.6-sol")).toBe("medium")
  })

  test("an explicit user override wins over the baseline", () => {
    writeConfig({
      ...original,
      modelReasoningEfforts: { "claude-opus-4.8": "medium" },
    })
    expect(getReasoningEffortForModel("claude-opus-4.8")).toBe("medium")
  })
})
