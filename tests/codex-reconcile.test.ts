import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  codexRoutingIntended,
  reconcileCodexOnBoot,
  refreshCodexApiKeyHelper,
  reconcileCodexOnShutdown,
  setCodexRoutingIntent,
} from "~/apps/codex/reconcile"
import { getConfig, writeConfig } from "~/lib/config/config"

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-reconcile-"))
const configPath = path.join(directory, "config.toml")
const firstExecPath = "/Applications/Maximal.app/Contents/MacOS/maximal"
const secondExecPath = "/opt/maximal/bin/maximal"

beforeEach(() => {
  fs.rmSync(configPath, { force: true })
  writeConfig({ apps: { claudeCode: { enabled: true } } })
})

afterAll(() => {
  fs.rmSync(directory, { recursive: true, force: true })
  writeConfig({})
})

describe("Codex routing intent", () => {
  test("persists Codex intent without replacing sibling app state", () => {
    expect(codexRoutingIntended()).toBe(false)

    setCodexRoutingIntent(true)

    expect(codexRoutingIntended()).toBe(true)
    expect(getConfig().apps?.claudeCode?.enabled).toBe(true)
  })
})

describe("Codex lifecycle reconciliation", () => {
  test("boot applies only when routing is intended", () => {
    reconcileCodexOnBoot(false, configPath, firstExecPath)
    expect(fs.existsSync(configPath)).toBe(false)

    reconcileCodexOnBoot(true, configPath, firstExecPath)
    const content = fs.readFileSync(configPath, "utf8")
    expect(content).toContain('model_provider = "maximal-app"')
    expect(content).toContain(`command = ${JSON.stringify(firstExecPath)}`)
  })

  test("boot refreshes an owned executable descriptor", () => {
    reconcileCodexOnBoot(true, configPath, firstExecPath)

    reconcileCodexOnBoot(true, configPath, secondExecPath)

    const content = fs.readFileSync(configPath, "utf8")
    expect(content).toContain(`command = ${JSON.stringify(secondExecPath)}`)
    expect(content).not.toContain(`command = ${JSON.stringify(firstExecPath)}`)
  })

  test("key-helper refresh updates only a changed executable descriptor", () => {
    reconcileCodexOnBoot(true, configPath, firstExecPath)

    refreshCodexApiKeyHelper(true, configPath, secondExecPath)

    const content = fs.readFileSync(configPath, "utf8")
    expect(content).toContain(`command = ${JSON.stringify(secondExecPath)}`)
    expect(content).not.toContain(`command = ${JSON.stringify(firstExecPath)}`)
  })

  test("shutdown reverts routing while durable intent remains enabled", () => {
    setCodexRoutingIntent(true)
    reconcileCodexOnBoot(true, configPath, firstExecPath)

    reconcileCodexOnShutdown(true, configPath)

    expect(fs.existsSync(configPath)).toBe(false)
    expect(codexRoutingIntended()).toBe(true)
  })

  test("shutdown is a no-op when routing is not intended", () => {
    reconcileCodexOnBoot(true, configPath, firstExecPath)
    const before = fs.readFileSync(configPath, "utf8")

    reconcileCodexOnShutdown(false, configPath)

    expect(fs.readFileSync(configPath, "utf8")).toBe(before)
  })

  test("shutdown preserves user-modified provider content", () => {
    reconcileCodexOnBoot(true, configPath, firstExecPath)
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace('name = "Maximal"', 'name = "Customized Maximal"'),
    )

    reconcileCodexOnShutdown(true, configPath)

    const content = fs.readFileSync(configPath, "utf8")
    expect(content).toContain('name = "Customized Maximal"')
    expect(content).not.toContain("maximal codex routing")
  })

  test("shutdown and later reconcile never overwrite selector drift", () => {
    fs.writeFileSync(configPath, 'model_provider = "openai"\n')
    reconcileCodexOnBoot(true, configPath, firstExecPath)
    const edited = fs
      .readFileSync(configPath, "utf8")
      .replace('model_provider = "maximal-app"', 'model_provider = "corporate"')
    fs.writeFileSync(configPath, edited)

    reconcileCodexOnShutdown(true, configPath)
    const afterShutdown = fs.readFileSync(configPath, "utf8")
    expect(afterShutdown).toBe(edited)

    reconcileCodexOnBoot(true, configPath, secondExecPath)
    expect(fs.readFileSync(configPath, "utf8")).toBe(edited)

    refreshCodexApiKeyHelper(true, configPath, secondExecPath)
    expect(fs.readFileSync(configPath, "utf8")).toBe(edited)
  })
})
