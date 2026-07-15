import { describe, expect, it } from "bun:test"

import { migrateLegacyModelTuning } from "~/lib/config/config"

/**
 * Unit tests for the legacy→`models` config migration shim. Pure over the raw
 * parsed JSON — no disk I/O. Covers the fold, the mandatory delete of legacy
 * keys, idempotency, half-migrated merge precedence, and non-object passthrough.
 */
describe("migrateLegacyModelTuning", () => {
  it("folds all three legacy maps into `models` with correct per-field mapping", () => {
    const { config, migrated } = migrateLegacyModelTuning({
      extraPrompts: { "gpt-5.4": "explore", "gpt-5-mini": "mini" },
      modelReasoningEfforts: { "gpt-5.4": "xhigh", "gpt-5-mini": "low" },
      responsesApiContextManagementModels: ["gpt-5.4"],
    })
    expect(migrated).toBe(true)
    expect((config as Record<string, unknown>).models).toEqual({
      "gpt-5.4": {
        extraPrompt: "explore",
        reasoningEffort: "xhigh",
        responsesApiContextManagement: true,
      },
      "gpt-5-mini": { extraPrompt: "mini", reasoningEffort: "low" },
    })
  })

  it("deletes all three legacy keys from the output", () => {
    const { config } = migrateLegacyModelTuning({
      extraPrompts: { m: "p" },
      modelReasoningEfforts: { m: "high" },
      responsesApiContextManagementModels: ["m"],
      smallModel: "gpt-5-mini",
    })
    const obj = config as Record<string, unknown>
    expect("extraPrompts" in obj).toBe(false)
    expect("modelReasoningEfforts" in obj).toBe(false)
    expect("responsesApiContextManagementModels" in obj).toBe(false)
    // Untouched keys survive.
    expect(obj.smallModel).toBe("gpt-5-mini")
  })

  it("is a no-op (migrated:false, same object) when no legacy key is present", () => {
    const input = {
      models: { m: { reasoningEffort: "high" } },
      smallModel: "x",
    }
    const { config, migrated } = migrateLegacyModelTuning(input)
    expect(migrated).toBe(false)
    expect(config).toBe(input) // same reference
  })

  it("is idempotent — running twice equals running once", () => {
    const input = {
      extraPrompts: { m: "p" },
      modelReasoningEfforts: { m: "high" },
    }
    const once = migrateLegacyModelTuning(input).config
    const twice = migrateLegacyModelTuning(once)
    expect(twice.migrated).toBe(false)
    expect(twice.config).toEqual(once)
  })

  it("merges a half-migrated file without clobbering existing `models` entries", () => {
    // Both shapes present: the existing `models` value wins over the legacy one.
    const { config } = migrateLegacyModelTuning({
      models: { m: { reasoningEffort: "medium", extraPrompt: "kept" } },
      modelReasoningEfforts: { m: "high", n: "low" },
    })
    const models = (config as Record<string, Record<string, unknown>>).models
    expect(models.m).toEqual({ reasoningEffort: "medium", extraPrompt: "kept" })
    expect(models.n).toEqual({ reasoningEffort: "low" })
  })

  it("passes non-object / null / array input through untouched", () => {
    for (const raw of [null, undefined, 42, "str", [1, 2, 3]]) {
      const { config, migrated } = migrateLegacyModelTuning(raw)
      expect(migrated).toBe(false)
      expect(config).toBe(raw)
    }
  })

  it("skips a malformed legacy container instead of iterating it into junk", () => {
    // A hand-edited config where extraPrompts is a string, not a map. The old
    // schema would have rejected it loudly; the shim must not turn it into
    // bogus per-character model entries. The key is still dropped.
    const { config, migrated } = migrateLegacyModelTuning({
      extraPrompts: "oops-not-an-object",
      modelReasoningEfforts: { "gpt-5.4": "xhigh" },
    })
    expect(migrated).toBe(true)
    const obj = config as Record<string, unknown>
    expect("extraPrompts" in obj).toBe(false)
    // Only the well-formed map was folded.
    expect(obj.models).toEqual({ "gpt-5.4": { reasoningEffort: "xhigh" } })
  })
})
