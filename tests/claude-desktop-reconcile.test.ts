/**
 * Lifecycle reconciliation for Claude Desktop routing. Driven through the
 * injectable `intended` + `home` params (no `mock.module`), asserting the
 * on-disk profile through the real config writer.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { claudeDesktopApp } from "~/apps/claude-desktop"
import {
  applyConfigLibraryProfile,
  gatewayProfile,
  getClaude3pDir,
  isConfigLibraryApplied,
  readJsonObject,
} from "~/apps/claude-desktop/config"
import {
  claudeDesktopRoutingIntended,
  enableClaudeDesktopRouting,
  reconcileClaudeDesktopOnBoot,
  refreshClaudeDesktopApiKey,
} from "~/apps/claude-desktop/reconcile"
import { getConfig, writeConfig } from "~/lib/config/config"
import { setListeningPort } from "~/lib/start/proxy-port"

let home: string

function appliedProfile(): Record<string, unknown> | null {
  const lib = path.join(getClaude3pDir(home), "configLibrary")
  const meta = readJsonObject(path.join(lib, "_meta.json"))
  return readJsonObject(path.join(lib, `${String(meta?.appliedId)}.json`))
}

function keyEntry(key: string) {
  return {
    id: "k1",
    label: "claude-desktop",
    key,
    enabled: true,
    created_at: "2026-10-21T00:00:00.000Z",
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cd-reconcile-"))
  writeConfig({ auth: { apiKeyEntries: [keyEntry("mxl_first")] } })
})

afterEach(() => {
  setListeningPort(undefined)
  fs.rmSync(home, { recursive: true, force: true })
})

afterAll(() => {
  writeConfig({})
})

describe("reconcileClaudeDesktopOnBoot", () => {
  test("re-points our profile at the port this boot listens on", () => {
    setListeningPort(5555)
    applyConfigLibraryProfile(home, gatewayProfile(home))
    setListeningPort(6666)

    reconcileClaudeDesktopOnBoot(true, home)

    expect(appliedProfile()?.inferenceGatewayBaseUrl).toBe(
      "http://127.0.0.1:6666",
    )
    expect(isConfigLibraryApplied(home)).toBe(true)
  })

  test("is a no-op when routing is not intended", () => {
    reconcileClaudeDesktopOnBoot(false, home)
    expect(fs.existsSync(getClaude3pDir(home))).toBe(false)
  })

  test("leaves someone else's gateway alone", () => {
    const lib = path.join(getClaude3pDir(home), "configLibrary")
    fs.mkdirSync(lib, { recursive: true })
    const corp = {
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "https://corp",
    }
    fs.writeFileSync(path.join(lib, "corp.json"), JSON.stringify(corp))
    fs.writeFileSync(
      path.join(lib, "_meta.json"),
      JSON.stringify({
        appliedId: "corp",
        entries: [{ id: "corp", name: "Work" }],
      }),
    )

    reconcileClaudeDesktopOnBoot(true, home)

    expect(appliedProfile()).toEqual(corp)
  })
})

describe("refreshClaudeDesktopApiKey", () => {
  test("rewrites our profile with the rotated key", () => {
    applyConfigLibraryProfile(home, gatewayProfile(home))
    writeConfig({ auth: { apiKeyEntries: [keyEntry("mxl_rotated")] } })

    refreshClaudeDesktopApiKey(true, home)

    expect(appliedProfile()?.inferenceGatewayApiKey).toBe("mxl_rotated")
  })

  test("does nothing when routing is off", () => {
    refreshClaudeDesktopApiKey(false, home)
    expect(fs.existsSync(getClaude3pDir(home))).toBe(false)
  })
})

describe("keys", () => {
  test("re-applying never writes an empty key", () => {
    writeConfig({})
    reconcileClaudeDesktopOnBoot(true, home)
    const key = appliedProfile()?.inferenceGatewayApiKey
    expect(typeof key).toBe("string")
    expect(key).not.toBe("")
  })

  test("a refused enable doesn't mint a key", () => {
    writeConfig({})
    const lib = path.join(getClaude3pDir(home), "configLibrary")
    fs.mkdirSync(lib, { recursive: true })
    fs.writeFileSync(
      path.join(lib, "corp.json"),
      JSON.stringify({ inferenceProvider: "gateway" }),
    )
    fs.writeFileSync(
      path.join(lib, "_meta.json"),
      JSON.stringify({
        appliedId: "corp",
        entries: [{ id: "corp", name: "Work" }],
      }),
    )

    expect(enableClaudeDesktopRouting(home).conflict).toBe(
      "foreign-gateway-profile",
    )
    expect(getConfig().auth?.apiKeyEntries ?? []).toEqual([])
  })
})

describe("uninstall", () => {
  test("clears the routing intent so the next boot doesn't re-apply", async () => {
    writeConfig({ apps: { claudeDesktop: { enabled: true } } })
    await claudeDesktopApp.uninstall()
    expect(claudeDesktopRoutingIntended()).toBe(false)
  })
})
