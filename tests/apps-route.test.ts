/**
 * /settings/api/apps — route-level coverage.
 *
 * Config comes from the REAL `~/lib/config`, which the global preload
 * (tests/test-setup.ts) has already redirected to a throwaway
 * COPILOT_API_HOME temp dir — so getConfig/writeConfig round-trip through a
 * temp `config.json`, never the user's real config. We deliberately do NOT
 * `mock.module("~/lib/config", …)`: Bun shares module mocks across the whole
 * `bun test` process and never resets them between files, so an unrestored
 * fake getConfig/writeConfig leaked FORWARD and broke
 * tests/claude-code-cli-enable-persist.test.ts on CI.
 *
 * The remaining mocks below are delegating wrappers that only default the
 * first arg to a tmp path (behaviorally identical to the real module, and
 * Bun's forward-persisting `mock.module` therefore stays harmless):
 *   - `~/apps/claude-code/detect`: `detectClaudeInstalls()` with no args
 *     returns a controllable fixture (the route always calls it with no
 *     args). Explicit-arg calls delegate to the real implementation.
 *   - `~/apps/claude-code/config`: file-path defaults point at a tmp
 *     settings.json instead of the user's real ~/.claude/settings.json.
 *   - `~/apps/claude-desktop/config`: `home` defaults point at a tmp
 *     home dir instead of the user's real Claude-3p userData dir.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ClaudeInstall } from "~/apps/claude-code/detect"

const ROUTE_3P_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "apps-route-3p-"))
const ROUTE_CC_SETTINGS = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "apps-route-ccsettings-")),
  "settings.json",
)

let installsFixture: Array<ClaudeInstall> = []

const actualDetect = await import("~/apps/claude-code/detect")
const realDetect = actualDetect.detectClaudeInstalls
await mock.module("~/apps/claude-code/detect", () => ({
  ...actualDetect,
  detectClaudeInstalls: (options?: Record<string, unknown>) =>
    options && Object.keys(options).length > 0 ?
      realDetect(options)
    : installsFixture,
}))

const actualCcSettings = await import("~/apps/claude-code/config")
const realCcApply = actualCcSettings.applyProxyBaseUrl
const realCcRevert = actualCcSettings.revertProxyBaseUrl
const realCcConfigured = actualCcSettings.isProxyBaseUrlConfigured
const realCcRead = actualCcSettings.readClaudeCodeSettings
// Forward all args, defaulting only the first to the tmp settings path.
// We deliberately do NOT override getClaudeCodeSettingsPath — the route
// never calls it (it passes the path explicitly via these wrappers), and
// overriding it would bleed into the writer's own path-resolution tests.
await mock.module("~/apps/claude-code/config", () => ({
  ...actualCcSettings,
  applyProxyBaseUrl: (filePath: string = ROUTE_CC_SETTINGS) =>
    realCcApply(filePath),
  revertProxyBaseUrl: (filePath: string = ROUTE_CC_SETTINGS) =>
    realCcRevert(filePath),
  isProxyBaseUrlConfigured: (filePath: string = ROUTE_CC_SETTINGS) =>
    realCcConfigured(filePath),
  readClaudeCodeSettings: (filePath: string = ROUTE_CC_SETTINGS) =>
    realCcRead(filePath),
}))

const actualDesktop = await import("~/apps/claude-desktop/config")
const realApply = actualDesktop.applyConfigLibraryProfile
const realRevert = actualDesktop.revertConfigLibraryProfile
const realIsApplied = actualDesktop.isConfigLibraryApplied
const realGetDir = actualDesktop.getClaude3pDir
// Wrappers forward ALL args (only defaulting the first `home` to the tmp
// home) so this mock stays behaviorally identical to the real module.
// Bun's `mock.module` persists forward across files in a run, so a wrapper
// that dropped later args would corrupt sibling tests that pass them.
await mock.module("~/apps/claude-desktop/config", () => ({
  ...actualDesktop,
  applyConfigLibraryProfile: (
    home: string = ROUTE_3P_HOME,
    ...rest: Array<unknown>
  ) => (realApply as (...a: Array<unknown>) => unknown)(home, ...rest),
  revertConfigLibraryProfile: (
    home: string = ROUTE_3P_HOME,
    ...rest: Array<unknown>
  ) => (realRevert as (...a: Array<unknown>) => unknown)(home, ...rest),
  isConfigLibraryApplied: (
    home: string = ROUTE_3P_HOME,
    ...rest: Array<unknown>
  ) => (realIsApplied as (...a: Array<unknown>) => unknown)(home, ...rest),
  getClaude3pDir: (home: string = ROUTE_3P_HOME, ...rest: Array<unknown>) =>
    (realGetDir as (...a: Array<unknown>) => unknown)(home, ...rest),
}))

const { appsRoutes } = await import("~/routes/settings/apps")
const { getConfig, writeConfig } = await import("~/lib/config")
const { isProxyBaseUrlConfigured } = await import("~/apps/claude-code/config")

function buildApp() {
  const app = new Hono()
  app.route("/apps", appsRoutes)
  return app
}

function fakeInstall(p: string): ClaudeInstall {
  return { path: p, resolvedPath: p, version: "1.2.3", source: "homebrew" }
}

function cleanTmp() {
  fs.rmSync(ROUTE_3P_HOME, { recursive: true, force: true })
  fs.mkdirSync(ROUTE_3P_HOME, { recursive: true })
  fs.rmSync(path.dirname(ROUTE_CC_SETTINGS), { recursive: true, force: true })
  fs.mkdirSync(path.dirname(ROUTE_CC_SETTINGS), { recursive: true })
}

beforeEach(() => {
  writeConfig({})
  installsFixture = []
  cleanTmp()
})

afterAll(async () => {
  // Leave a clean slate so later files in the shared worker start empty, and
  // restore the mocked app modules so their tmp-path wrappers can't leak
  // forward (Bun keeps module mocks for the whole process; awaited so the
  // restore lands before the next file's static imports resolve).
  writeConfig({})
  await mock.module("~/apps/claude-code/detect", () => actualDetect)
  await mock.module("~/apps/claude-code/config", () => actualCcSettings)
  await mock.module("~/apps/claude-desktop/config", () => actualDesktop)
  fs.rmSync(ROUTE_3P_HOME, { recursive: true, force: true })
  fs.rmSync(path.dirname(ROUTE_CC_SETTINGS), { recursive: true, force: true })
})

describe("GET /apps", () => {
  test("returns three apps in alphabetical order with the right kinds", async () => {
    const res = await buildApp().request("/apps")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      apps: Array<{ id: string; name: string; kind: string; status: string }>
    }
    expect(body.apps.map((a) => a.id)).toEqual([
      "claude-code",
      "claude-desktop",
      "copilot-cli",
    ])
    expect(body.apps[0].kind).toBe("config")
    expect(body.apps[1].kind).toBe("config")
    expect(body.apps[2].kind).toBe("coming-soon")
    expect(body.apps[2].status).toBe("coming-soon")
  })

  test("claude-code offers an install command when no install is detected", async () => {
    installsFixture = []
    const res = await buildApp().request("/apps")
    const body = (await res.json()) as {
      apps: Array<{
        id: string
        status: string
        install: { method: string; command: string } | null
      }>
    }
    const cc = body.apps.find((a) => a.id === "claude-code")
    expect(cc?.status).toBe("not-installed")
    expect(cc?.install?.command).toBe(
      "curl -fsSL https://claude.ai/install.sh | sh",
    )
  })

  test("claude-code lists detected installs with no install hint", async () => {
    installsFixture = [fakeInstall("/opt/homebrew/bin/claude")]
    const res = await buildApp().request("/apps")
    const body = (await res.json()) as {
      apps: Array<{
        id: string
        status: string
        installs: Array<{ path: string; source: string }>
        install: unknown
      }>
    }
    const cc = body.apps.find((a) => a.id === "claude-code")
    expect(cc?.status).toBe("ready")
    expect(cc?.installs[0].path).toBe("/opt/homebrew/bin/claude")
    expect(cc?.install).toBeNull()
  })
})

describe("POST /apps/claude-code/toggle", () => {
  test("enable writes ANTHROPIC_BASE_URL and persists enabled=true", async () => {
    installsFixture = [fakeInstall("/opt/homebrew/bin/claude")]
    const res = await buildApp().request("/apps/claude-code/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { enabled: boolean; conflict: unknown }
    expect(body.enabled).toBe(true)
    expect(body.conflict).toBeNull()
    expect(getConfig().apps?.claudeCode).toEqual({ enabled: true })
    // The settings.json base URL was actually written.
    expect(isProxyBaseUrlConfigured(ROUTE_CC_SETTINGS)).toBe(true)
  })

  test("enable with no install returns 409", async () => {
    installsFixture = []
    const res = await buildApp().request("/apps/claude-code/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    expect(res.status).toBe(409)
  })

  test("enable surfaces a conflict when a foreign base URL is present", async () => {
    installsFixture = [fakeInstall("/opt/homebrew/bin/claude")]
    // Pre-seed a non-proxy ANTHROPIC_BASE_URL the user owns.
    fs.writeFileSync(
      ROUTE_CC_SETTINGS,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.example" } }),
    )
    const res = await buildApp().request("/apps/claude-code/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      enabled: boolean
      conflict: string | null
    }
    expect(body.conflict).toBe("foreign-base-url")
    // We did NOT overwrite the user's base URL.
    expect(isProxyBaseUrlConfigured(ROUTE_CC_SETTINGS)).toBe(false)
    expect(body.enabled).toBe(false)
  })

  test("disable reverts the base URL and persists enabled=false", async () => {
    installsFixture = [fakeInstall("/opt/homebrew/bin/claude")]
    const app = buildApp()
    await app.request("/apps/claude-code/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    const res = await app.request("/apps/claude-code/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { enabled: boolean }
    expect(body.enabled).toBe(false)
    expect(getConfig().apps?.claudeCode?.enabled).toBe(false)
    expect(isProxyBaseUrlConfigured(ROUTE_CC_SETTINGS)).toBe(false)
  })

  test("bad body returns 400", async () => {
    const res = await buildApp().request("/apps/claude-code/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    })
    expect(res.status).toBe(400)
  })
})

describe("POST /apps/claude-desktop/toggle", () => {
  test("enable applies proxy config and persists enabled=true", async () => {
    const res = await buildApp().request("/apps/claude-desktop/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; enabled: boolean }
    expect(body.id).toBe("claude-desktop")
    expect(body.enabled).toBe(true)
    expect(getConfig().apps?.claudeDesktop?.enabled).toBe(true)
    expect(actualDesktop.isConfigLibraryApplied(ROUTE_3P_HOME)).toBe(true)
  })

  test("disable reverts proxy config and persists enabled=false", async () => {
    const app = buildApp()
    await app.request("/apps/claude-desktop/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    const res = await app.request("/apps/claude-desktop/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(200)
    expect(getConfig().apps?.claudeDesktop?.enabled).toBe(false)
    expect(actualDesktop.isConfigLibraryApplied(ROUTE_3P_HOME)).toBe(false)
  })
})
