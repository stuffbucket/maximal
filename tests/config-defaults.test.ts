import { describe, expect, it } from "bun:test"

import {
  defaultConfig,
  getConfig,
  mergeConfigWithDefaults,
  type ModelMappingRule,
  writeConfig,
} from "~/lib/config/config"
import {
  ReasoningEffortSchema,
  validateAppConfig,
} from "~/lib/config/config-schema"
import { PATHS } from "~/lib/platform/paths"

const defaultMapping: ModelMappingRule = {
  match: { type: "exact", value: "codex-auto-review" },
  target: "gpt-5.6-luna",
}

describe("defaultConfig", () => {
  it("satisfies the runtime config schema", () => {
    expect(() => validateAppConfig(defaultConfig)).not.toThrow()
  })

  it("keeps prompt and reasoning-effort model ids aligned", () => {
    expect(Object.keys(defaultConfig.extraPrompts ?? {}).sort()).toEqual(
      Object.keys(defaultConfig.modelReasoningEfforts ?? {}).sort(),
    )
  })

  it("uses a configured model as the small model", () => {
    const smallModel = defaultConfig.smallModel ?? ""
    expect(smallModel).not.toBe("")
    expect(defaultConfig.extraPrompts).toHaveProperty(smallModel)
    expect(defaultConfig.modelReasoningEfforts).toHaveProperty(smallModel)
  })

  it("uses only supported reasoning efforts", () => {
    for (const effort of Object.values(
      defaultConfig.modelReasoningEfforts ?? {},
    )) {
      expect(ReasoningEffortSchema.options).toContain(effort)
    }
  })
})

it("backfills and persists the default model mapping when absent", async () => {
  const original = getConfig()
  try {
    writeConfig({ smallModel: "test-model" })

    const merged = mergeConfigWithDefaults()
    const onDisk = (await Bun.file(PATHS.CONFIG_PATH).json()) as {
      modelMappings?: Array<ModelMappingRule>
    }

    expect(merged.modelMappings).toEqual([defaultMapping])
    expect(onDisk.modelMappings).toEqual([defaultMapping])
  } finally {
    writeConfig(original)
  }
})

it("preserves an explicit model mapping list without appending defaults", () => {
  const original = getConfig()
  const customMappings: Array<ModelMappingRule> = [
    {
      match: { type: "glob", value: "local-*" },
      target: "gpt-5-mini",
    },
  ]
  try {
    writeConfig({ modelMappings: customMappings })

    expect(mergeConfigWithDefaults().modelMappings).toEqual(customMappings)
  } finally {
    writeConfig(original)
  }
})

it("preserves an explicit empty model mapping list", () => {
  const original = getConfig()
  try {
    writeConfig({ modelMappings: [] })

    expect(mergeConfigWithDefaults().modelMappings).toEqual([])
  } finally {
    writeConfig(original)
  }
})
