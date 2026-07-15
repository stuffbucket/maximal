import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"

import {
  getConfig,
  mergeConfigWithDefaults,
  writeConfig,
} from "~/lib/config/config"
import { PATHS } from "~/lib/platform/paths"

/**
 * End-to-end guard for the forced write-back: a legacy config file on disk must
 * be rewritten in the consolidated `models` shape at boot (mergeConfigWithDefaults),
 * with the three legacy keys removed. Exercises the shim + the readConfigFromDisk
 * hook + the `migrated`→write-back path together.
 *
 * Uses the throwaway COPILOT_API_HOME temp dir (test-setup.ts). Restores the
 * original config in afterEach so the module cache + disk don't leak into other
 * tests in this worker.
 */
describe("config load — legacy tuning migration write-back", () => {
  let original: ReturnType<typeof getConfig>

  beforeEach(() => {
    original = getConfig()
  })

  afterEach(() => {
    writeConfig(original) // restores both disk and the module cache
  })

  it("rewrites a legacy on-disk file into `models` and drops the legacy keys", () => {
    const legacy = {
      smallModel: "gpt-5-mini",
      extraPrompts: { "gpt-5.4": "explore" },
      modelReasoningEfforts: { "gpt-5.4": "xhigh" },
      responsesApiContextManagementModels: ["gpt-5.4"],
    }
    fs.writeFileSync(
      PATHS.CONFIG_PATH,
      `${JSON.stringify(legacy, null, 2)}\n`,
      "utf8",
    )

    mergeConfigWithDefaults()

    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    const rawWritten = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
    const written = JSON.parse(rawWritten) as Record<string, unknown>
    // Legacy keys gone.
    expect("extraPrompts" in written).toBe(false)
    expect("modelReasoningEfforts" in written).toBe(false)
    expect("responsesApiContextManagementModels" in written).toBe(false)
    // Folded into models (user entry preserved alongside back-filled defaults).
    const models = written.models as Record<string, Record<string, unknown>>
    expect(models["gpt-5.4"]).toEqual({
      extraPrompt: "explore",
      reasoningEffort: "xhigh",
      responsesApiContextManagement: true,
    })
    // A curated default model was back-filled by mergeDefaultConfig.
    expect(models["gpt-5-mini"]).toBeDefined()
  })
})
