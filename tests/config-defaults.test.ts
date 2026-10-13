import { expect, it } from "bun:test"

import {
  getConfig,
  mergeConfigWithDefaults,
  type ModelMappingRule,
  writeConfig,
} from "~/lib/config/config"
import { PATHS } from "~/lib/platform/paths"

const defaultMapping: ModelMappingRule = {
  match: { type: "exact", value: "codex-auto-review" },
  target: "gpt-5.6-luna",
}

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
