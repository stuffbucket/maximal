import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import {
  applyProxyBaseUrl,
  getClaudeAutoModelsState,
  readClaudeCodeSettings,
  revertProxyBaseUrl,
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

describe("Claude Code Auto model settings", () => {
  test("first apply writes automatic Haiku and Sonnet defaults only", () => {
    expect(apply().wrote).toBe(true)
    expect(readEnv()).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku.id,
      ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet.id,
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
    expect(state.options.map((option) => option.id)).toEqual([
      haiku.id,
      sonnet.id,
      smallGpt.id,
      fullGpt.id,
    ])
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
        claudeCode: { fastModel: smallGpt.id, capableModel: fullGpt.id },
      },
    })

    apply()
    expect(readEnv()).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: smallGpt.id,
      ANTHROPIC_DEFAULT_SONNET_MODEL: fullGpt.id,
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
      },
    })

    apply()
    expect(readEnv()).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: fullGpt.id,
      ANTHROPIC_DEFAULT_SONNET_MODEL: smallGpt.id,
    })
    const auto = getClaudeAutoModelsState(settingsPath)
    expect(auto.fast.source).toBe("claude-code-setting")
    expect(auto.capable.source).toBe("claude-code-setting")
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

  test("reapply is idempotent while owned automatic choices are eligible", () => {
    expect(apply().wrote).toBe(true)
    expect(apply()).toMatchObject({
      wrote: false,
      skippedReason: "already-ours",
    })
  })
})
