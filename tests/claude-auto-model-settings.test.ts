import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import {
  AUTO_MODELS_JOURNAL_KEY,
  AUTO_MODELS_OWNERSHIP_KEY,
  UNAVAILABLE_CLASSIFIER_MODEL,
} from "~/apps/claude-code/auto-model-settings"
import {
  applyProxyBaseUrl,
  getClaudeAutoModelsState,
  readClaudeCodeSettings,
  revertProxyBaseUrl,
  revertProxyBaseUrlForShutdown,
  writeClaudeCodeSettings,
} from "~/apps/claude-code/config"
import { writeConfig } from "~/lib/config/config"
import { setModels, state } from "~/lib/runtime-state/state"

const resolveTestKey = () =>
  ({ ok: true, key: "auto-model-test-key", source: "app" }) as const

function model(
  id: string,
  family: string,
  options: {
    vendor: string
    endpoint?: "/v1/messages" | "/responses"
  },
): Model {
  return {
    id,
    name: id,
    object: "model",
    version: "1",
    vendor: options.vendor,
    model_picker_enabled: true,
    preview: false,
    supported_endpoints: [options.endpoint ?? "/responses"],
    capabilities: {
      family,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      limits: {},
      supports: { tool_calls: true, streaming: true },
    },
  }
}

const haiku = model("claude-haiku-4.6", "claude-haiku", {
  vendor: "anthropic",
  endpoint: "/v1/messages",
})
const sonnet = model("claude-sonnet-4.7", "claude-sonnet", {
  vendor: "anthropic",
  endpoint: "/v1/messages",
})
const olderSmallGpt = model("gpt-5.5-mini", "gpt-5.5-mini", {
  vendor: "openai",
})
const smallGpt = model("gpt-5.6-mini", "gpt-5.6-mini", {
  vendor: "openai",
})
const fullGpt = model("gpt-5.6", "gpt-5.6", { vendor: "openai" })

let dir: string
let settingsPath: string
const savedModels = state.models

function setCatalog(models: Array<Model>): void {
  setModels({ object: "list", data: models } satisfies ModelsResponse)
}

function readEnv(): Record<string, unknown> {
  const settings = readClaudeCodeSettings(settingsPath)
  return (settings.env ?? {}) as Record<string, unknown>
}

function apply() {
  return applyProxyBaseUrl(settingsPath, resolveTestKey)
}

beforeEach(() => {
  writeConfig({})
  setCatalog([haiku, sonnet, smallGpt, fullGpt])
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-auto-models-"))
  settingsPath = path.join(dir, "settings.json")
})

afterEach(() => {
  writeConfig({})
  if (savedModels) setModels(savedModels)
  else state.models = undefined
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("Claude Code model settings", () => {
  test("first apply writes automatic Haiku and Sonnet defaults only", () => {
    expect(apply().wrote).toBe(true)
    expect(readEnv()).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku.id,
      ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet.id,
      CLAUDE_CODE_AUTO_MODE_MODEL: smallGpt.id,
    })
    expect(readEnv()).not.toHaveProperty("ANTHROPIC_MODEL")

    const state = getClaudeAutoModelsState(settingsPath)
    expect(state.applied).toBe(true)
    expect(state.fast).toMatchObject({
      effective: haiku.id,
      source: "automatic",
      reason: "haiku",
    })
    expect(state.capable).toMatchObject({
      effective: sonnet.id,
      source: "automatic",
      reason: "sonnet",
    })
    expect(state.classifier).toMatchObject({
      effective: smallGpt.id,
      source: "automatic",
      reason: "small-gpt",
    })
    expect(state.options.map((option) => option.id)).toEqual([
      haiku.id,
      sonnet.id,
      smallGpt.id,
      fullGpt.id,
    ])
    expect(state.classifier_options.map((option) => option.id)).toEqual([
      smallGpt.id,
      fullGpt.id,
    ])
  })

  test("uses the configured GPT session model for permission checks when Haiku is unavailable", () => {
    writeClaudeCodeSettings(settingsPath, { model: fullGpt.id })

    apply()

    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(fullGpt.id)
    expect(getClaudeAutoModelsState(settingsPath).classifier).toMatchObject({
      effective: fullGpt.id,
      source: "automatic",
      reason: "gpt",
    })
  })

  test("prefers ANTHROPIC_MODEL for GPT permission checks", () => {
    writeClaudeCodeSettings(settingsPath, {
      model: smallGpt.id,
      env: { ANTHROPIC_MODEL: fullGpt.id },
    })

    apply()

    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(fullGpt.id)
  })

  test("resolves the configured GPT session model through model mappings", () => {
    writeClaudeCodeSettings(settingsPath, { model: "my-gpt" })
    writeConfig({
      modelMappings: [
        {
          match: { type: "exact", value: "my-gpt" },
          target: fullGpt.id,
        },
      ],
    })

    apply()

    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(fullGpt.id)
  })

  test("explicit Maximal overrides supersede pre-existing tier settings", () => {
    writeClaudeCodeSettings(settingsPath, {
      env: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku.id,
        ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet.id,
      },
    })
    writeConfig({
      apps: {
        claudeCode: {
          fastModel: smallGpt.id,
          capableModel: fullGpt.id,
          classifierModel: fullGpt.id,
        },
      },
    })

    apply()
    expect(readEnv()).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: smallGpt.id,
      ANTHROPIC_DEFAULT_SONNET_MODEL: fullGpt.id,
      CLAUDE_CODE_AUTO_MODE_MODEL: fullGpt.id,
    })
    expect(getClaudeAutoModelsState(settingsPath).fast.source).toBe(
      "maximal-override",
    )

    revertProxyBaseUrl(settingsPath)
    expect(readEnv()).toEqual({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku.id,
      ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet.id,
    })
  })

  test("preserves eligible pre-existing settings as external overrides", () => {
    writeClaudeCodeSettings(settingsPath, {
      env: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: fullGpt.id,
        ANTHROPIC_DEFAULT_SONNET_MODEL: smallGpt.id,
        CLAUDE_CODE_AUTO_MODE_MODEL: fullGpt.id,
      },
    })

    apply()
    expect(readEnv()).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: fullGpt.id,
      ANTHROPIC_DEFAULT_SONNET_MODEL: smallGpt.id,
      CLAUDE_CODE_AUTO_MODE_MODEL: fullGpt.id,
    })
    const auto = getClaudeAutoModelsState(settingsPath)
    expect(auto.fast.source).toBe("claude-code-setting")
    expect(auto.capable.source).toBe("claude-code-setting")
    expect(auto.classifier.source).toBe("claude-code-setting")
  })

  test("preserves an external setting that is absent from the catalog", () => {
    writeClaudeCodeSettings(settingsPath, {
      env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "gpt-retired" },
    })

    apply()
    expect(readEnv().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("gpt-retired")
    expect(getClaudeAutoModelsState(settingsPath).fast).toMatchObject({
      effective: "gpt-retired",
      source: "claude-code-setting",
      status: "unavailable",
      reason: "external-unavailable",
    })
  })

  test("does not apply or replace an unavailable saved override", () => {
    writeConfig({
      apps: { claudeCode: { fastModel: "gpt-retired" } },
    })

    apply()
    expect(readEnv()).not.toHaveProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL")
    expect(getClaudeAutoModelsState(settingsPath).fast).toEqual({
      configured: "gpt-retired",
      effective: null,
      source: "maximal-override",
      status: "unavailable",
      reason: "override-unavailable",
    })
  })
})

describe("Claude Code model-setting ownership transitions", () => {
  test("an alias mapping restores its prior value during a catalog gap", () => {
    apply()
    expect(readEnv().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(haiku.id)

    setCatalog([sonnet])
    apply()
    expect(readEnv()).not.toHaveProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL")

    setCatalog([haiku, sonnet, smallGpt, fullGpt])
    apply()
    expect(readEnv().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(haiku.id)
  })

  test("automatic classifier ownership survives a temporary catalog gap", () => {
    apply()
    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(smallGpt.id)

    setCatalog([sonnet])
    apply()
    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(smallGpt.id)

    setCatalog([haiku, sonnet, smallGpt, fullGpt])
    apply()
    expect(getClaudeAutoModelsState(settingsPath).classifier).toMatchObject({
      effective: smallGpt.id,
      source: "automatic",
    })
  })

  test("a cataloged classifier that becomes incompatible is replaced by the sentinel", () => {
    apply()
    const incompatible = {
      ...smallGpt,
      capabilities: {
        ...smallGpt.capabilities,
        supports: { ...smallGpt.capabilities.supports, streaming: false },
      },
    }

    setCatalog([sonnet, incompatible])
    apply()

    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(
      UNAVAILABLE_CLASSIFIER_MODEL,
    )

    setCatalog([haiku, sonnet, smallGpt, fullGpt])
    apply()
    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(smallGpt.id)
  })

  test("Automatic reclaims an unavailable external classifier without a replacement", () => {
    writeClaudeCodeSettings(settingsPath, {
      env: { CLAUDE_CODE_AUTO_MODE_MODEL: "gpt-retired" },
    })
    setCatalog([sonnet])
    apply()

    applyProxyBaseUrl(settingsPath, resolveTestKey, {
      claimAutoModels: new Set(["classifier"]),
    })

    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(
      UNAVAILABLE_CLASSIFIER_MODEL,
    )
    expect(getClaudeAutoModelsState(settingsPath).classifier).toMatchObject({
      configured: null,
      effective: null,
      source: "none",
      status: "unresolved",
    })

    setCatalog([haiku, sonnet, smallGpt, fullGpt])
    apply()
    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(smallGpt.id)

    revertProxyBaseUrl(settingsPath)
    expect(readEnv()).toEqual({ CLAUDE_CODE_AUTO_MODE_MODEL: "gpt-retired" })
  })

  test("keeps an applied override through a temporary catalog gap", () => {
    writeConfig({ apps: { claudeCode: { fastModel: smallGpt.id } } })
    apply()

    setCatalog([haiku, sonnet, fullGpt])
    apply()

    expect(readEnv().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(smallGpt.id)
    expect(getClaudeAutoModelsState(settingsPath).fast).toEqual({
      configured: smallGpt.id,
      effective: null,
      source: "maximal-override",
      status: "unavailable",
      reason: "override-unavailable",
    })
  })

  test("a direct edit after apply becomes user-owned and survives reapply and revert", () => {
    apply()
    const settings = readClaudeCodeSettings(settingsPath)
    writeClaudeCodeSettings(settingsPath, {
      ...settings,
      env: {
        ...(settings.env as Record<string, unknown>),
        ANTHROPIC_DEFAULT_HAIKU_MODEL: fullGpt.id,
      },
    })

    apply()
    expect(readEnv().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(fullGpt.id)
    expect(getClaudeAutoModelsState(settingsPath).fast.source).toBe(
      "claude-code-setting",
    )

    revertProxyBaseUrl(settingsPath)
    expect(readEnv()).toEqual({ ANTHROPIC_DEFAULT_HAIKU_MODEL: fullGpt.id })
  })

  test("a direct classifier edit becomes user-owned and survives revert", () => {
    apply()
    const settings = readClaudeCodeSettings(settingsPath)
    writeClaudeCodeSettings(settingsPath, {
      ...settings,
      env: {
        ...(settings.env as Record<string, unknown>),
        CLAUDE_CODE_AUTO_MODE_MODEL: fullGpt.id,
      },
    })

    apply()

    expect(getClaudeAutoModelsState(settingsPath).classifier).toMatchObject({
      effective: fullGpt.id,
      source: "claude-code-setting",
    })
    revertProxyBaseUrl(settingsPath)
    expect(readEnv()).toEqual({ CLAUDE_CODE_AUTO_MODE_MODEL: fullGpt.id })
  })
})

describe("Claude Code model ownership across shutdown", () => {
  test("a direct classifier edit survives shutdown and fresh boot", () => {
    writeConfig({
      apps: { claudeCode: { classifierModel: smallGpt.id } },
    })
    apply()
    const settings = readClaudeCodeSettings(settingsPath)
    writeClaudeCodeSettings(settingsPath, {
      ...settings,
      env: {
        ...(settings.env as Record<string, unknown>),
        CLAUDE_CODE_AUTO_MODE_MODEL: fullGpt.id,
      },
    })
    apply()

    revertProxyBaseUrlForShutdown(settingsPath)
    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(fullGpt.id)
    expect(readClaudeCodeSettings(settingsPath)).toHaveProperty(
      AUTO_MODELS_JOURNAL_KEY,
    )

    apply()
    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(fullGpt.id)
    expect(getClaudeAutoModelsState(settingsPath).classifier.source).toBe(
      "claude-code-setting",
    )
  })

  test("an edit made while Maximal is stopped becomes user-owned", () => {
    writeConfig({
      apps: { claudeCode: { classifierModel: smallGpt.id } },
    })
    apply()
    revertProxyBaseUrlForShutdown(settingsPath)
    const settings = readClaudeCodeSettings(settingsPath)
    writeClaudeCodeSettings(settingsPath, {
      ...settings,
      env: {
        ...(settings.env as Record<string, unknown>),
        CLAUDE_CODE_AUTO_MODE_MODEL: fullGpt.id,
      },
    })

    apply()

    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(fullGpt.id)
    expect(getClaudeAutoModelsState(settingsPath).classifier.source).toBe(
      "claude-code-setting",
    )
  })

  test("a direct deletion survives shutdown and fresh boot", () => {
    writeConfig({ apps: { claudeCode: { fastModel: smallGpt.id } } })
    apply()
    const settings = readClaudeCodeSettings(settingsPath)
    const { ANTHROPIC_DEFAULT_HAIKU_MODEL: _removed, ...env } =
      settings.env as Record<string, unknown>
    writeClaudeCodeSettings(settingsPath, { ...settings, env })
    apply()

    revertProxyBaseUrlForShutdown(settingsPath)
    apply()

    expect(readEnv()).not.toHaveProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL")
    expect(getClaudeAutoModelsState(settingsPath).fast.source).toBe(
      "claude-code-setting",
    )
  })

  test("an Automatic choice stays sticky across shutdown and catalog reorder", () => {
    apply()
    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(smallGpt.id)

    revertProxyBaseUrlForShutdown(settingsPath)
    setCatalog([haiku, sonnet, olderSmallGpt, smallGpt, fullGpt])
    apply()

    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(smallGpt.id)
    expect(getClaudeAutoModelsState(settingsPath).classifier.source).toBe(
      "automatic",
    )
  })

  test("an explicit Maximal choice survives shutdown and fresh boot", () => {
    writeConfig({
      apps: { claudeCode: { classifierModel: fullGpt.id } },
    })
    apply()

    revertProxyBaseUrlForShutdown(settingsPath)
    expect(readEnv()).not.toHaveProperty("CLAUDE_CODE_AUTO_MODE_MODEL")
    apply()

    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(fullGpt.id)
    expect(getClaudeAutoModelsState(settingsPath).classifier.source).toBe(
      "maximal-override",
    )
  })

  test("explicit disable restores prior state and clears suspended ownership", () => {
    writeClaudeCodeSettings(settingsPath, {
      env: { CLAUDE_CODE_AUTO_MODE_MODEL: "gpt-original" },
    })
    writeConfig({
      apps: { claudeCode: { classifierModel: fullGpt.id } },
    })
    apply()
    revertProxyBaseUrlForShutdown(settingsPath)

    revertProxyBaseUrl(settingsPath)

    expect(readEnv()).toEqual({ CLAUDE_CODE_AUTO_MODE_MODEL: "gpt-original" })
    expect(readClaudeCodeSettings(settingsPath)).not.toHaveProperty(
      AUTO_MODELS_JOURNAL_KEY,
    )
  })

  test("repeated shutdown hooks preserve the ownership journal", () => {
    apply()
    expect(revertProxyBaseUrlForShutdown(settingsPath).wrote).toBe(true)
    const suspended = readClaudeCodeSettings(settingsPath)

    expect(revertProxyBaseUrlForShutdown(settingsPath).wrote).toBe(false)
    expect(readClaudeCodeSettings(settingsPath)).toEqual(suspended)
  })

  test("live ownership after a crash takes precedence over a stale journal", () => {
    apply()
    revertProxyBaseUrlForShutdown(settingsPath)
    const journal =
      readClaudeCodeSettings(settingsPath)[AUTO_MODELS_JOURNAL_KEY]
    setCatalog([haiku, sonnet, olderSmallGpt, smallGpt, fullGpt])
    apply()
    const active = readClaudeCodeSettings(settingsPath)
    writeClaudeCodeSettings(settingsPath, {
      ...active,
      env: {
        ...(active.env as Record<string, unknown>),
        CLAUDE_CODE_AUTO_MODE_MODEL: olderSmallGpt.id,
      },
      [AUTO_MODELS_OWNERSHIP_KEY]: {
        ...((active[AUTO_MODELS_OWNERSHIP_KEY] ?? {}) as Record<
          string,
          unknown
        >),
        classifier: { id: olderSmallGpt.id, source: "automatic" },
      },
      [AUTO_MODELS_JOURNAL_KEY]: journal,
    })

    apply()

    expect(readEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe(olderSmallGpt.id)
    expect(readClaudeCodeSettings(settingsPath)).not.toHaveProperty(
      AUTO_MODELS_JOURNAL_KEY,
    )
  })
})

describe("Claude Code model-setting external ownership", () => {
  test("a direct edit wins over a still-persisted Maximal override", () => {
    writeConfig({ apps: { claudeCode: { fastModel: smallGpt.id } } })
    apply()
    const settings = readClaudeCodeSettings(settingsPath)
    writeClaudeCodeSettings(settingsPath, {
      ...settings,
      env: {
        ...(settings.env as Record<string, unknown>),
        ANTHROPIC_DEFAULT_HAIKU_MODEL: fullGpt.id,
      },
    })

    apply()

    expect(readEnv().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(fullGpt.id)
    expect(getClaudeAutoModelsState(settingsPath).fast).toMatchObject({
      configured: smallGpt.id,
      effective: fullGpt.id,
      source: "claude-code-setting",
    })
  })

  test("a directly deleted tier remains externally unmanaged", () => {
    apply()
    const settings = readClaudeCodeSettings(settingsPath)
    const { ANTHROPIC_DEFAULT_HAIKU_MODEL: _removed, ...env } =
      settings.env as Record<string, unknown>
    writeClaudeCodeSettings(settingsPath, { ...settings, env })

    apply()

    expect(readEnv()).not.toHaveProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL")
    expect(getClaudeAutoModelsState(settingsPath).fast).toMatchObject({
      configured: null,
      effective: null,
      source: "claude-code-setting",
      status: "ready",
      reason: "external-setting",
    })
  })

  test("clearing a manual override does not make it the sticky automatic choice", () => {
    const alternateHaiku = { ...haiku, id: "claude-haiku-alternate" }
    setCatalog([haiku, alternateHaiku, sonnet, smallGpt, fullGpt])
    writeConfig({
      apps: { claudeCode: { fastModel: alternateHaiku.id } },
    })
    apply()
    expect(readEnv().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(alternateHaiku.id)

    writeConfig({})
    apply()

    expect(readEnv().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(haiku.id)
    expect(getClaudeAutoModelsState(settingsPath).fast.source).toBe("automatic")
  })

  test("restores a snapshotted null tier value exactly", () => {
    writeClaudeCodeSettings(settingsPath, {
      env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: null },
    })
    writeConfig({ apps: { claudeCode: { fastModel: smallGpt.id } } })

    apply()
    revertProxyBaseUrl(settingsPath)

    expect(readEnv()).toHaveProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL", null)
  })

  test("a later direct edit survives when an unavailable override becomes available", () => {
    const later = model("gpt-later", "gpt-later", { vendor: "openai" })
    writeClaudeCodeSettings(settingsPath, {
      env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: fullGpt.id },
    })
    writeConfig({ apps: { claudeCode: { fastModel: later.id } } })
    apply()
    const settings = readClaudeCodeSettings(settingsPath)
    writeClaudeCodeSettings(settingsPath, {
      ...settings,
      env: {
        ...(settings.env as Record<string, unknown>),
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "my-x2",
      },
    })
    setCatalog([haiku, sonnet, smallGpt, fullGpt, later])

    apply()
    expect(readEnv().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("my-x2")
    revertProxyBaseUrl(settingsPath)
    expect(readEnv().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("my-x2")
  })

  test("reapply is idempotent while owned automatic choices are eligible", () => {
    expect(apply().wrote).toBe(true)
    expect(apply()).toMatchObject({
      wrote: false,
      skippedReason: "already-ours",
    })
  })
})
