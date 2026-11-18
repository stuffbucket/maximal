import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { piApp } from "~/apps/pi"
import { getConfig, writeConfig } from "~/lib/config/config"
import { PATHS } from "~/lib/platform/paths"
import { setModels, state } from "~/lib/runtime-state/state"
import { appsRoutes } from "~/routes/settings/apps"

import { piModelFixture } from "./helpers/pi-model-fixture"

const originalConfig = getConfig()
const originalModels = state.models
const originalPath = process.env.PATH
const originalPiDirectory = process.env.PI_CODING_AGENT_DIR
const journalPath = path.join(PATHS.APP_DIR, "pi-routing.json")

function toggle(body: unknown, id = "pi") {
  const server = new Hono().route("/apps", appsRoutes)
  return server.request(`/apps/${id}/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("Pi Settings routes with real isolated configuration", () => {
  let directory: string
  let filePath: string
  let journal: string | null
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-route-"))
    const bin = path.join(directory, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "pi"), "#!/bin/sh\nexit 77\n", {
      mode: 0o755,
    })
    fs.writeFileSync(
      path.join(bin, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        version: "1.5.2",
        bin: { pi: "pi" },
      }),
    )
    process.env.PATH = bin
    process.env.PI_CODING_AGENT_DIR = path.join(directory, "agent")
    filePath = path.join(directory, "agent", "models.json")
    journal =
      fs.existsSync(journalPath) ? fs.readFileSync(journalPath, "utf8") : null
    writeConfig({
      ...originalConfig,
      apps: { ...originalConfig.apps, pi: { enabled: false } },
    })
    setModels({ object: "list", data: [piModelFixture()] })
  })
  afterEach(() => {
    piApp.onShutdown?.()
    writeConfig(originalConfig)
    if (originalModels) setModels(originalModels)
    else state.models = undefined
    process.env.PATH = originalPath
    if (originalPiDirectory === undefined)
      delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalPiDirectory
    if (journal === null) fs.rmSync(journalPath, { force: true })
    else fs.writeFileSync(journalPath, journal)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  test("fresh enable and disable flow through the registry and persist intent", async () => {
    const enabled = await toggle({ enabled: true })
    expect(enabled.status).toBe(200)
    expect(await enabled.json()).toMatchObject({
      id: "pi",
      kind: "config",
      enabled: true,
      conflict: null,
    })
    expect(fs.readFileSync(filePath, "utf8")).toContain("test-chat")
    expect(getConfig().apps?.pi?.enabled).toBe(true)
    expect((await toggle({ enabled: false })).status).toBe(200)
    expect(fs.existsSync(filePath)).toBe(false)
    expect(getConfig().apps?.pi?.enabled).toBe(false)
  })
  test("a new custom directory needs its own adoption consent", async () => {
    const custom = path.join(directory, "custom")
    fs.mkdirSync(custom)
    const customFile = path.join(custom, "models.json")
    const original = '{"providers":{"maximal":{"apiKey":"original"}}}'
    fs.writeFileSync(customFile, original)
    const refused = await toggle({ enabled: true, configDirectory: custom })
    expect(await refused.json()).toMatchObject({
      enabled: false,
      conflict: "existing-provider",
      config_directory: custom,
    })
    expect(fs.readFileSync(customFile, "utf8")).toBe(original)
    expect(fs.existsSync(filePath)).toBe(false)
    const accepted = await toggle({
      enabled: true,
      configDirectory: custom,
      adoptExisting: true,
    })
    expect(await accepted.json()).toMatchObject({
      enabled: true,
      config_directory: custom,
    })
    await toggle({ enabled: false })
    expect(fs.readFileSync(customFile, "utf8")).toBe(original)
  })
  test("unknown and coming-soon apps cannot be mutated, and invalid options do not create files", async () => {
    expect((await toggle({ enabled: true }, "unknown")).status).toBe(404)
    expect((await toggle({ enabled: true }, "chatgpt")).status).toBe(409)
    expect((await toggle({ enabled: true, adoptExisting: "yes" })).status).toBe(
      400,
    )
    expect(
      (await toggle({ enabled: true, configDirectory: "relative" })).status,
    ).toBe(400)
    expect(fs.existsSync(filePath)).toBe(false)
  })
})
