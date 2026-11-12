import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ModelsListResponse } from "~/lib/config/settings-types"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import {
  applyProxyBaseUrl,
  getClaudeCodeSettingsPath,
  isProxyBaseUrlConfigured,
  readClaudeCodeSettings,
  writeClaudeCodeSettings,
} from "~/apps/claude-code/config"
import { createAuthMiddleware } from "~/lib/auth/request-auth"
import { getConfig, writeConfig } from "~/lib/config/config"
import { setModels, state } from "~/lib/runtime-state/state"
import { settingsApiRoutes } from "~/routes/settings/api"

function model(
  id: string,
  family: string,
  options: {
    vendor?: string
    endpoint?: string
    picker?: boolean
    type?: string
    tools?: boolean
    streaming?: boolean
  } = {},
): Model {
  return {
    id,
    name: id,
    object: "model",
    version: "1",
    vendor:
      options.vendor ?? (id.startsWith("claude") ? "anthropic" : "openai"),
    model_picker_enabled: options.picker ?? true,
    preview: false,
    supported_endpoints: [options.endpoint ?? "/responses"],
    capabilities: {
      family,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: options.type ?? "chat",
      limits: {},
      supports: {
        tool_calls: options.tools ?? true,
        streaming: options.streaming ?? true,
      },
    },
  }
}

const haikuA = model("claude-haiku-4.6-a", "claude-haiku", {
  endpoint: "/v1/messages",
})
const haikuB = model("claude-haiku-4.6-b", "claude-haiku", {
  endpoint: "/v1/messages",
})
const sonnet = model("claude-sonnet-4.7", "claude-sonnet", {
  endpoint: "/v1/messages",
})
const smallGpt = model("gpt-5.6-mini", "gpt-5.6-mini")
const fullGpt = model("gpt-5.6", "gpt-5.6")
const embedding = model("text-embedding-3-small", "embeddings", {
  type: "embeddings",
  tools: false,
  streaming: false,
})

function catalog(models: Array<Model>): ModelsResponse {
  return { object: "list", data: models }
}

function buildApp() {
  const app = new Hono()
  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => [],
      allowUnauthenticatedPaths: ["/", "/usage-viewer"],
    }),
  )
  app.route("/settings/api", settingsApiRoutes)
  return app
}

async function json(res: Response): Promise<ModelsListResponse> {
  return (await res.json()) as ModelsListResponse
}

const resolveTestKey = () =>
  ({ ok: true, key: "test-key", source: "app" }) as const
const originalFetch = globalThis.fetch
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const saved = {
  models: state.models,
  copilotToken: state.copilotToken,
  copilotApiUrl: state.copilotApiUrl,
}
let configDir: string

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-auto-models-"))
  process.env.CLAUDE_CONFIG_DIR = configDir
  writeConfig({})
  setModels(catalog([haikuA, sonnet, smallGpt, fullGpt, embedding]))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.copilotToken = saved.copilotToken
  state.copilotApiUrl = saved.copilotApiUrl
  if (saved.models) setModels(saved.models)
  else state.models = undefined
  writeConfig({})
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  fs.rmSync(configDir, { recursive: true, force: true })
})

describe("GET and refresh Claude Code model settings", () => {
  test("returns only eligible choices and server-computed tier state", async () => {
    const response = await buildApp().request("/settings/api/models")

    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.claude_code_auto.options.map((option) => option.id)).toEqual([
      haikuA.id,
      sonnet.id,
      smallGpt.id,
      fullGpt.id,
    ])
    expect(
      body.claude_code_auto.classifier_options.map((option) => option.id),
    ).toEqual([smallGpt.id, fullGpt.id])
    expect(body.claude_code_auto.fast).toMatchObject({
      effective: haikuA.id,
      source: "automatic",
      status: "ready",
      reason: "haiku",
    })
    expect(body.claude_code_auto.capable).toMatchObject({
      effective: sonnet.id,
      source: "automatic",
      status: "ready",
      reason: "sonnet",
    })
    expect(body.claude_code_auto.classifier).toMatchObject({
      effective: smallGpt.id,
      source: "automatic",
      status: "ready",
      reason: "small-gpt",
    })
  })

  test("refresh recomputes an automatic selection from the fresh catalog", async () => {
    state.copilotToken = "test-token"
    state.copilotApiUrl = "https://models.test" as typeof state.copilotApiUrl
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json(catalog([haikuB, sonnet, smallGpt, fullGpt])),
      )) as unknown as typeof fetch

    const response = await buildApp().request("/settings/api/models/refresh", {
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect((await json(response)).claude_code_auto.fast.effective).toBe(
      haikuB.id,
    )
  })

  test("failed refresh keeps the stale catalog and effective selection", async () => {
    state.copilotToken = "test-token"
    state.copilotApiUrl = "https://models.test" as typeof state.copilotApiUrl
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("upstream failed", { status: 503 }),
      )) as unknown as typeof fetch

    const app = buildApp()
    const failed = await app.request("/settings/api/models/refresh", {
      method: "POST",
    })
    expect(failed.status).toBe(503)

    const current = await app.request("/settings/api/models")
    expect((await json(current)).claude_code_auto.fast.effective).toBe(
      haikuA.id,
    )
  })

  test.skipIf(process.platform === "win32")(
    "a symlinked Claude settings file does not break read-only model state",
    async () => {
      const target = path.join(configDir, "real-settings.json")
      fs.writeFileSync(target, JSON.stringify({ theme: "dark" }))
      fs.symlinkSync(target, getClaudeCodeSettingsPath())

      const response = await buildApp().request("/settings/api/models")

      expect(response.status).toBe(200)
      expect((await json(response)).claude_code_auto.applied).toBe(false)
      expect(isProxyBaseUrlConfigured()).toBe(false)
    },
  )
})

describe("PATCH Claude Code model settings", () => {
  test("persists eligible overrides and reconciles an enabled integration", async () => {
    writeConfig({
      auth: { apiKeys: ["test-key"] },
      apps: { claudeCode: { enabled: true } },
    })
    applyProxyBaseUrl(getClaudeCodeSettingsPath(), () => ({
      ok: true,
      key: "test-key",
      source: "app",
    }))

    const response = await buildApp().request(
      "/settings/api/models/claude-code-auto",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fast: smallGpt.id,
          capable: fullGpt.id,
          classifier: fullGpt.id,
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(getConfig().apps?.claudeCode).toEqual({ enabled: true })
    expect(getConfig().anthropicMessages).toEqual({
      haikuModel: smallGpt.id,
      sonnetModel: fullGpt.id,
      autoPermissionModel: fullGpt.id,
    })
    const settings = readClaudeCodeSettings()
    expect(settings.env).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: smallGpt.id,
      ANTHROPIC_DEFAULT_SONNET_MODEL: fullGpt.id,
      CLAUDE_CODE_AUTO_MODE_MODEL: fullGpt.id,
    })
  })

  test.skipIf(process.platform === "win32")(
    "keeps route mappings when enabled Claude settings cannot be updated",
    async () => {
      writeConfig({ apps: { claudeCode: { enabled: true } } })
      const target = path.join(configDir, "real-settings.json")
      fs.writeFileSync(target, JSON.stringify({ theme: "dark" }))
      fs.symlinkSync(target, getClaudeCodeSettingsPath())

      const response = await buildApp().request(
        "/settings/api/models/claude-code-auto",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ classifier: fullGpt.id }),
        },
      )

      expect(response.status).toBe(200)
      expect(getConfig().apps?.claudeCode).toEqual({ enabled: true })
      expect(getConfig().anthropicMessages).toEqual({
        autoPermissionModel: fullGpt.id,
      })
    },
  )

  test("keeps route mappings when Claude routing is foreign", async () => {
    writeConfig({ apps: { claudeCode: { enabled: true } } })
    writeClaudeCodeSettings(getClaudeCodeSettingsPath(), {
      env: { ANTHROPIC_BASE_URL: "https://other.example" },
    })

    const response = await buildApp().request(
      "/settings/api/models/claude-code-auto",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ classifier: fullGpt.id }),
      },
    )

    expect(response.status).toBe(200)
    expect(getConfig().apps?.claudeCode).toEqual({ enabled: true })
    expect(getConfig().anthropicMessages).toEqual({
      autoPermissionModel: fullGpt.id,
    })
  })
})

describe("PATCH model selection persistence", () => {
  test("a partial null clears only that tier back to Automatic", async () => {
    writeConfig({
      apps: {
        claudeCode: {
          fastModel: smallGpt.id,
          capableModel: fullGpt.id,
        },
      },
    })

    const response = await buildApp().request(
      "/settings/api/models/claude-code-auto",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fast: null }),
      },
    )

    expect(response.status).toBe(200)
    expect(getConfig().apps?.claudeCode).toEqual({})
    expect(getConfig().anthropicMessages).toEqual({
      sonnetModel: fullGpt.id,
    })
    const auto = (await json(response)).claude_code_auto
    expect(auto.fast).toMatchObject({
      configured: null,
      effective: haikuA.id,
      source: "automatic",
    })
    expect(auto.capable).toMatchObject({
      configured: fullGpt.id,
      effective: fullGpt.id,
      source: "maximal-override",
    })
  })

  test.each([
    [{ fast: "missing-model", capable: null }, 400],
    [{ fast: embedding.id, capable: null }, 400],
    [{ classifier: sonnet.id }, 400],
    [{ classifier: embedding.id }, 400],
    [{ fast: "", capable: null }, 400],
    [{}, 400],
    [{ fast: null, capable: null, extra: true }, 400],
  ])(
    "rejects invalid update %# without changing config",
    async (body, status) => {
      writeConfig({ apps: { claudeCode: { enabled: false } } })

      const response = await buildApp().request(
        "/settings/api/models/claude-code-auto",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      )

      expect(response.status).toBe(status)
      expect(getConfig().apps?.claudeCode).toEqual({ enabled: false })
    },
  )

  test("updates one tier while preserving an unavailable override on the other", async () => {
    writeConfig({
      apps: {
        claudeCode: { fastModel: "gpt-retired", capableModel: sonnet.id },
      },
    })

    const response = await buildApp().request(
      "/settings/api/models/claude-code-auto",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capable: fullGpt.id }),
      },
    )

    expect(response.status).toBe(200)
    expect(getConfig().apps?.claudeCode).toEqual({})
    expect(getConfig().anthropicMessages).toEqual({
      haikuModel: "gpt-retired",
      sonnetModel: fullGpt.id,
    })
  })

  test("an explicit Settings choice reclaims a directly edited tier", async () => {
    writeConfig({
      auth: { apiKeys: ["test-key"] },
      apps: { claudeCode: { enabled: true, fastModel: smallGpt.id } },
    })
    applyProxyBaseUrl(getClaudeCodeSettingsPath(), () => ({
      ok: true,
      key: "test-key",
      source: "app",
    }))
    const settings = readClaudeCodeSettings()
    writeClaudeCodeSettings(getClaudeCodeSettingsPath(), {
      ...settings,
      env: {
        ...(settings.env as Record<string, unknown>),
        ANTHROPIC_DEFAULT_HAIKU_MODEL: fullGpt.id,
      },
    })

    const response = await buildApp().request(
      "/settings/api/models/claude-code-auto",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fast: haikuA.id }),
      },
    )

    expect(response.status).toBe(200)
    expect(
      (readClaudeCodeSettings().env as Record<string, unknown>)
        .ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ).toBe(haikuA.id)
    expect((await json(response)).claude_code_auto.fast).toMatchObject({
      configured: haikuA.id,
      effective: haikuA.id,
      source: "maximal-override",
    })
  })

  test("keeps an unavailable persisted override visible", async () => {
    writeConfig({ apps: { claudeCode: { fastModel: "gpt-retired" } } })

    const response = await buildApp().request("/settings/api/models")

    expect((await json(response)).claude_code_auto.fast).toEqual({
      configured: "gpt-retired",
      effective: null,
      source: "maximal-override",
      status: "unavailable",
      reason: "override-unavailable",
    })
  })
})

describe("explicit Automatic claims", () => {
  test("Automatic stays owned after superseding a pre-existing external value", async () => {
    writeClaudeCodeSettings(getClaudeCodeSettingsPath(), {
      env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: fullGpt.id },
    })
    writeConfig({
      auth: { apiKeys: ["test-key"] },
      apps: { claudeCode: { enabled: true } },
    })
    applyProxyBaseUrl(getClaudeCodeSettingsPath(), resolveTestKey)
    const app = buildApp()
    await app.request("/settings/api/models/claude-code-auto", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fast: smallGpt.id }),
    })

    const automatic = await app.request(
      "/settings/api/models/claude-code-auto",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fast: null }),
      },
    )

    expect((await json(automatic)).claude_code_auto.fast).toMatchObject({
      configured: null,
      effective: haikuA.id,
      source: "automatic",
    })
    expect(
      (readClaudeCodeSettings().env as Record<string, unknown>)
        .ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ).toBe(haikuA.id)
    applyProxyBaseUrl(getClaudeCodeSettingsPath(), resolveTestKey)
    expect(
      (readClaudeCodeSettings().env as Record<string, unknown>)
        .ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ).toBe(haikuA.id)
  })

  test("Automatic stays owned after superseding a later direct edit", async () => {
    writeConfig({
      auth: { apiKeys: ["test-key"] },
      apps: {
        claudeCode: { enabled: true, fastModel: smallGpt.id },
      },
    })
    applyProxyBaseUrl(getClaudeCodeSettingsPath(), resolveTestKey)
    const settings = readClaudeCodeSettings()
    writeClaudeCodeSettings(getClaudeCodeSettingsPath(), {
      ...settings,
      env: {
        ...(settings.env as Record<string, unknown>),
        ANTHROPIC_DEFAULT_HAIKU_MODEL: fullGpt.id,
      },
    })

    const automatic = await buildApp().request(
      "/settings/api/models/claude-code-auto",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fast: null }),
      },
    )

    expect((await json(automatic)).claude_code_auto.fast).toMatchObject({
      configured: null,
      effective: haikuA.id,
      source: "automatic",
    })
    applyProxyBaseUrl(getClaudeCodeSettingsPath(), resolveTestKey)
    expect(
      (readClaudeCodeSettings().env as Record<string, unknown>)
        .ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ).toBe(haikuA.id)
  })
})
