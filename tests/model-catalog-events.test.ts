import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { readClaudeCodeSettings } from "~/apps/claude-code/config"
import {
  reconcileClaudeCodeOnBoot,
  reconcileClaudeCodeOnShutdown,
} from "~/apps/claude-code/reconcile"
import { writeConfig } from "~/lib/config/config"
import {
  publishModelCatalogChanged,
  subscribeModelCatalogChanged,
} from "~/lib/models/catalog-events"
import { cacheModels } from "~/lib/platform/utils"
import { setModels, state } from "~/lib/runtime-state/state"

function model(id: string, family: string): Model {
  const claude = family.includes("claude")
  return {
    id,
    name: id,
    object: "model",
    version: "1",
    vendor: claude ? "anthropic" : "openai",
    model_picker_enabled: true,
    preview: false,
    supported_endpoints: [claude ? "/v1/messages" : "/responses"],
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

const sonnet = model("claude-sonnet-4.7", "claude-sonnet")
const haikuA = model("claude-haiku-4.6-a", "claude-haiku")
const haikuB = model("claude-haiku-4.6-b", "claude-haiku")
const haikuC = model("claude-haiku-4.6-c", "claude-haiku")

const originalFetch = globalThis.fetch
const saved = {
  models: state.models,
  copilotToken: state.copilotToken,
  copilotApiUrl: state.copilotApiUrl,
}
const unsubs: Array<() => void> = []
const dirs: Array<string> = []

function catalog(models: Array<Model>): ModelsResponse {
  return { object: "list", data: models }
}

function envAt(filePath: string): Record<string, unknown> {
  return (readClaudeCodeSettings(filePath).env ?? {}) as Record<string, unknown>
}

afterEach(() => {
  while (unsubs.length > 0) unsubs.pop()?.()
  globalThis.fetch = originalFetch
  state.copilotToken = saved.copilotToken
  state.copilotApiUrl = saved.copilotApiUrl
  if (saved.models) setModels(saved.models)
  else state.models = undefined
  writeConfig({})
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("model catalog events", () => {
  test("publishes only after cacheModels installs the fresh catalog", async () => {
    state.copilotToken = "test-token"
    state.copilotApiUrl = "https://models.test" as typeof state.copilotApiUrl
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json(catalog([haikuA, sonnet])),
      )) as unknown as typeof fetch

    let observed: string | null = null
    unsubs.push(
      subscribeModelCatalogChanged(() => {
        observed = state.models?.data[0]?.id ?? null
      }),
    )

    await cacheModels()

    expect(observed as string | null).toBe(haikuA.id)
    expect(state.models?.data.map((entry) => entry.id)).toEqual([
      haikuA.id,
      sonnet.id,
    ])
  })

  test("isolates listener failures", () => {
    let completed = false
    unsubs.push(
      subscribeModelCatalogChanged(() => {
        throw new Error("listener failed")
      }),
      subscribeModelCatalogChanged(() => {
        completed = true
      }),
    )

    expect(() => publishModelCatalogChanged()).not.toThrow()
    expect(completed).toBe(true)
  })

  test("repeated boot reconciliation keeps one effective subscription", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-reconcile-"))
    dirs.push(dir)
    const settingsPath = path.join(dir, "settings.json")
    writeConfig({
      auth: { apiKeys: ["test-key"] },
      apps: { claudeCode: { enabled: true } },
    })
    setModels(catalog([haikuA, sonnet]))

    reconcileClaudeCodeOnBoot(true, settingsPath)
    reconcileClaudeCodeOnBoot(true, settingsPath)
    expect(envAt(settingsPath).ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(haikuA.id)

    setModels(catalog([haikuB, sonnet]))
    publishModelCatalogChanged()
    expect(envAt(settingsPath).ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(haikuB.id)

    setModels(catalog([haikuC, haikuB, sonnet]))
    publishModelCatalogChanged()
    expect(envAt(settingsPath).ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(haikuB.id)

    reconcileClaudeCodeOnShutdown(true, settingsPath)
  })
})
