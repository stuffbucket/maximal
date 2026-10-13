import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { CodexInstallation } from "~/apps/codex/detect"

import { createCodexApp } from "~/apps/codex"
import { codexRoutingIntended } from "~/apps/codex/reconcile"
import { getAllApps } from "~/apps/registry"
import { getConfig, writeConfig } from "~/lib/config/config"

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-"))
const configPath = path.join(directory, "config.toml")
const savedCodexHome = process.env.CODEX_HOME

const installations: Array<CodexInstallation> = [
  { kind: "cli", path: "/opt/maximal-fixtures/codex", version: null },
  {
    kind: "desktop",
    path: "/Applications/Codex.app",
    version: null,
  },
]

const app = createCodexApp({
  detectInstallations: () => installations,
  execPath: "/opt/maximal/bin/maximal",
})

beforeEach(() => {
  process.env.CODEX_HOME = directory
  fs.rmSync(configPath, { force: true })
  writeConfig({})
})

afterAll(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedCodexHome
  fs.rmSync(directory, { recursive: true, force: true })
  writeConfig({})
})

describe("Codex app", () => {
  test("has exactly one registry entry", () => {
    expect(getAllApps().map(({ id }) => id)).toEqual([
      "claude-code",
      "claude-desktop",
      "codex",
      "copilot-cli",
    ])
  })

  test("represents CLI and Desktop as one app", async () => {
    expect(await app.detect()).toBe(true)

    const details = await app.getDetails()

    expect(details.id).toBe("codex")
    expect(details.name).toBe("Codex")
    expect(details.enabled).toBe(false)
    expect(details.status).toBe("ready")
    expect(details.installs).toEqual([
      {
        kind: "cli",
        path: "/opt/maximal-fixtures/codex",
        version: null,
        source: "unknown",
      },
      {
        kind: "desktop",
        path: "/Applications/Codex.app",
        version: null,
        source: "unknown",
      },
    ])
  })

  test("enable provisions a scoped key, applies routing, then persists intent", async () => {
    const result = await app.enable()

    expect(result).toEqual({ success: true, conflict: null })
    expect(codexRoutingIntended()).toBe(true)
    expect(getConfig().auth?.apiKeyEntries?.[0]?.label).toBe("codex")
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      'command = "/opt/maximal/bin/maximal"',
    )
    expect(app.isEnabled()).toBe(true)
  })

  test("reports malformed config as typed cleanup without changing intent", async () => {
    fs.writeFileSync(configPath, 'model_provider = "unterminated\n')

    expect(await app.getDetails()).toMatchObject({
      enabled: false,
      conflict: "cleanup-required",
    })
    expect(app.isEnabled()).toBe(false)
    expect(await app.enable()).toEqual({
      success: false,
      conflict: "cleanup-required",
    })
    expect(await app.disable()).toEqual({
      success: false,
      conflict: "cleanup-required",
    })
    expect(await app.uninstall()).toEqual({
      reverted: [],
      conflict: "cleanup-required",
    })

    expect(codexRoutingIntended()).toBe(false)
    expect(fs.readFileSync(configPath, "utf8")).toBe(
      'model_provider = "unterminated\n',
    )
  })

  test("disable reverts before clearing durable intent", async () => {
    await app.enable()

    const result = await app.disable()

    expect(result.success).toBe(true)
    expect(codexRoutingIntended()).toBe(false)
    expect(fs.existsSync(configPath)).toBe(false)
    expect(app.isEnabled()).toBe(false)
  })

  test("disable preserves edited provider content and reports incomplete cleanup", async () => {
    await app.enable()
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace('name = "Maximal"', 'name = "Customized Maximal"'),
    )

    const result = await app.disable()

    expect(result.success).toBe(false)
    expect(codexRoutingIntended()).toBe(false)
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      'name = "Customized Maximal"',
    )
  })

  test("uninstall reports cleanup required for edited owned content", async () => {
    await app.enable()
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace('name = "Maximal"', 'name = "Customized Maximal"'),
    )

    const result = await app.uninstall()

    expect(result).toEqual({
      reverted: [],
      conflict: "cleanup-required",
    })
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      'name = "Customized Maximal"',
    )
  })
})
