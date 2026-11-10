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
import { cacheModels } from "~/lib/platform/utils"
import {
  setModels,
  state,
  subscribeModelCatalogChanged,
} from "~/lib/runtime-state/state"

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

/** A model Copilot hides from its chat picker. */
function hidden(id: string, type: string, endpoints: Array<string>): Model {
  const entry = model(id, "gpt")
  return {
    ...entry,
    model_picker_enabled: false,
    supported_endpoints: endpoints,
    capabilities: { ...entry.capabilities, type },
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

  test("keeps hidden embeddings, image, decisions and routable chat models, drops other hidden ones", async () => {
    state.copilotToken = "test-token"
    state.copilotApiUrl = "https://models.test" as typeof state.copilotApiUrl
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json(
          catalog([
            sonnet,
            hidden("text-embedding-3-small", "embeddings", []),
            hidden("gpt-image-2.5-flare", "image", [
              "/v1/images/generations",
              "/v1/images/edits",
            ]),
            hidden("gpt-6-luna-decisions", "decisions", ["/v1/decisions"]),
            hidden("microsoft-decision-1", "decisions", ["/v1/systemone"]),
            hidden("gpt-5.4-nano", "chat", ["/responses", "ws:/responses"]),
            hidden("gpt-4o", "chat", []),
            {
              ...hidden("gpt-3.5-turbo", "chat", []),
              supported_endpoints: undefined,
            },
            hidden("gpt-4", "chat", ["/v1/audio"]),
            hidden("gpt-41-copilot", "completion", []),
            hidden("gpt-completion-routable", "completion", [
              "/chat/completions",
            ]),
          ]),
        ),
      )) as unknown as typeof fetch

    await cacheModels()

    expect(state.models?.data.map((entry) => entry.id)).toEqual([
      sonnet.id,
      "text-embedding-3-small",
      "gpt-image-2.5-flare",
      "gpt-6-luna-decisions",
      "microsoft-decision-1",
      "gpt-5.4-nano",
    ])
  })

  test("an older overlapping fetch cannot replace a newer catalog", async () => {
    state.copilotToken = "test-token"
    state.copilotApiUrl = "https://models.test" as typeof state.copilotApiUrl
    const first = { resolve: (_response: Response): void => undefined }
    const second = { resolve: (_response: Response): void => undefined }
    let request = 0
    globalThis.fetch = (() => {
      request += 1
      return new Promise<Response>((resolve) => {
        ;(request === 1 ? first : second).resolve = resolve
      })
    }) as unknown as typeof fetch
    let publications = 0
    unsubs.push(
      subscribeModelCatalogChanged(() => {
        publications += 1
      }),
    )

    const older = cacheModels()
    const newer = cacheModels()
    second.resolve(Response.json(catalog([haikuB, sonnet])))
    await newer
    first.resolve(Response.json(catalog([haikuA, sonnet])))
    await older

    expect(state.models?.data[0]?.id).toBe(haikuB.id)
    expect(publications).toBe(1)
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

    expect(() => setModels(catalog([haikuA, sonnet]))).not.toThrow()
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
    expect(envAt(settingsPath).ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(haikuB.id)

    setModels(catalog([haikuC, haikuB, sonnet]))
    expect(envAt(settingsPath).ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(haikuB.id)

    reconcileClaudeCodeOnShutdown(true, settingsPath)
  })
})
