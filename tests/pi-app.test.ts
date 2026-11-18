import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createPiApp } from "~/apps/pi"
import { getConfig, writeConfig } from "~/lib/config/config"
import { parseJsonText } from "~/lib/platform/json-text"
import { setModels, state } from "~/lib/runtime-state/state"
import { setListeningPort } from "~/lib/start/proxy-port"

import { piModelFixture } from "./helpers/pi-model-fixture"

const originalConfig = getConfig()
const originalModels = state.models

describe("Pi app lifecycle", () => {
  let directory: string
  let filePath: string
  let app: ReturnType<typeof createPiApp>
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-app-"))
    filePath = path.join(directory, "agent", "models.json")
    writeConfig({
      ...originalConfig,
      apps: { ...originalConfig.apps, pi: { enabled: false } },
      auth: { apiKeyEntries: [] },
    })
    setModels({ object: "list", data: [piModelFixture()] })
    app = createPiApp({
      filePath,
      journalPath: path.join(directory, "journal.json"),
      profileId: "a".repeat(64),
      detectInstallations: () => [{ path: "/test/pi", version: "1.5.2" }],
    })
  })
  afterEach(() => {
    app.onShutdown?.()
    writeConfig(originalConfig)
    if (originalModels) setModels(originalModels)
    else state.models = undefined
    setListeningPort(undefined)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  function read(): unknown {
    return parseJsonText(fs.readFileSync(filePath, "utf8"))
  }

  test("discovery does not enable, create settings, or provision credentials", async () => {
    expect(await app.detect()).toBe(true)
    expect(await app.getDetails()).toMatchObject({
      kind: "config",
      enabled: false,
      status: "ready",
      config_directory: path.dirname(filePath),
    })
    expect(fs.existsSync(filePath)).toBe(false)
    expect(getConfig().auth?.apiKeyEntries).toEqual([])
  })

  test("fresh enable provisions auth and models without changing Pi's default, and disable reverses it", async () => {
    setListeningPort(43123)
    expect(await app.enable()).toMatchObject({ success: true })
    expect(getConfig().apps?.pi).toMatchObject({
      enabled: true,
      configDirectory: path.dirname(filePath),
    })
    expect(getConfig().auth?.apiKeyEntries?.length).toBe(1)
    expect(read()).toMatchObject({
      providers: {
        maximal: {
          baseUrl: "http://127.0.0.1:43123/v1",

          models: [{ id: "test-chat", cost: { input: 2, output: 10 } }],
        },
      },
    })
    expect(
      fs.existsSync(path.join(path.dirname(filePath), "settings.json")),
    ).toBe(false)
    expect(app.isEnabled()).toBe(true)
    expect(await app.disable()).toMatchObject({ success: true })
    expect(getConfig().apps?.pi?.enabled).toBe(false)
    expect(fs.existsSync(filePath)).toBe(false)
  })

  test("catalog events update managed data once; shutdown detaches and boot resubscribes", async () => {
    await app.enable()
    app.onBoot?.()
    app.onBoot?.()
    setModels({ object: "list", data: [piModelFixture("new-chat")] })
    expect(read()).toMatchObject({
      providers: { maximal: { models: [{ id: "new-chat" }] } },
    })
    const stamp = fs.statSync(filePath).mtimeMs
    setModels({ object: "list", data: [piModelFixture("new-chat")] })
    expect(fs.statSync(filePath).mtimeMs).toBe(stamp)
    app.onShutdown?.()
    setModels({ object: "list", data: [piModelFixture("next-chat")] })
    expect(read()).toMatchObject({
      providers: { maximal: { models: [{ id: "new-chat" }] } },
    })
    app.onBoot?.()
    expect(read()).toMatchObject({
      providers: { maximal: { models: [{ id: "next-chat" }] } },
    })
  })

  test("external edits and deletion stop automatic writes and remain safe on disable", async () => {
    await app.enable()
    const edited = fs
      .readFileSync(filePath, "utf8")
      .replace("test-chat", "my-model")
    fs.writeFileSync(filePath, edited)
    setModels({ object: "list", data: [piModelFixture("new-chat")] })
    expect(fs.readFileSync(filePath, "utf8")).toBe(edited)
    expect(await app.disable()).toEqual({
      success: false,
      conflict: "cleanup-required",
    })
    expect(getConfig().apps?.pi?.enabled).toBe(false)
    fs.unlinkSync(filePath)
    app.onBoot?.()
    setModels({ object: "list", data: [piModelFixture("third-chat")] })
    expect(fs.existsSync(filePath)).toBe(false)
  })

  test("adoption preserves original provider and user overrides until disable", async () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const original =
      '{"providers":{"maximal":{"baseUrl":"http://old/v1","apiKey":"old","modelOverrides":{"test-chat":{"maxTokens":42}}}}}'
    fs.writeFileSync(filePath, original)
    expect(await app.enable()).toEqual({
      success: false,
      conflict: "existing-provider",
    })
    expect(getConfig().apps?.pi?.enabled).toBe(false)
    expect(getConfig().auth?.apiKeyEntries).toEqual([])
    expect(await app.enable({ adoptExisting: true })).toMatchObject({
      success: true,
    })
    expect(read()).toMatchObject({
      providers: {
        maximal: { modelOverrides: { "test-chat": { maxTokens: 42 } } },
      },
    })
    await app.disable()
    expect(fs.readFileSync(filePath, "utf8")).toBe(original)
  })

  test("API key rotation refreshes the helper without minting another key", async () => {
    await app.enable()
    const config = getConfig()
    const entries = config.auth?.apiKeyEntries ?? []
    writeConfig({
      ...config,
      auth: {
        ...config.auth,
        apiKeyEntries: entries.map((entry) => ({
          ...entry,
          key: "rotated_key_123",
        })),
      },
    })
    app.refreshCredentials()
    expect(fs.readFileSync(filePath, "utf8")).toContain("rotated_key_123")
    expect(getConfig().auth?.apiKeyEntries?.length).toBe(1)
  })

  test("empty catalogs do not create a broken provider or record enabled intent", async () => {
    setModels({ object: "list", data: [] })
    const error = await app.enable().catch((failure: unknown) => failure)
    expect(String(error)).toContain("catalog is not ready")
    expect(fs.existsSync(filePath)).toBe(false)
    expect(getConfig().apps?.pi?.enabled).toBe(false)
    expect(getConfig().auth?.apiKeyEntries).toEqual([])
  })

  test("enable and disable serialize even while catalog discovery is pending", async () => {
    const { promise: pending, resolve: release } =
      Promise.withResolvers<undefined>()
    app = createPiApp({
      filePath,
      journalPath: path.join(directory, "journal.json"),
      loadCatalog: async () => {
        await pending
        return [piModelFixture()]
      },
    })
    const enable = app.enable()
    const disable = app.disable()
    release(undefined)
    await Promise.all([enable, disable])
    expect(getConfig().apps?.pi?.enabled).toBe(false)
    expect(fs.existsSync(filePath)).toBe(false)
  })
})
