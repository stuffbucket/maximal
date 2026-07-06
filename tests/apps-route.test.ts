/**
 * /settings/api/apps — route-level coverage.
 *
 * Config comes from the REAL `~/lib/config`, which the global preload
 * (tests/test-setup.ts) has already redirected to a throwaway
 * COPILOT_API_HOME temp dir — so getConfig/writeConfig round-trip through a
 * temp `config.json`, never the user's real config.
 *
 * Path isolation without leak-prone module mocks:
 *   - claude-code settings.json → we point `process.env.CLAUDE_CONFIG_DIR`
 *     at a tmp dir (saved+restored around the file). The REAL
 *     `applyProxyBaseUrl()` / `isProxyBaseUrlConfigured()` etc. resolve their
 *     default path via `getClaudeCodeSettingsPath()`, which honors that env
 *     var — so no `mock.module("~/apps/claude-code/config")` is needed. That
 *     mock used to default the path arg to a tmp file, and on CI it LEAKED
 *     forward (even with an awaited restore): a later file's arg-less
 *     `applyProxyBaseUrl()` got the leaked tmp path, breaking
 *     claude-code-cli-enable-persist.test.ts (#229).
 *
 * Two mocks remain because their targets have NO env/injection seam that the
 * route path reaches (the route calls them with no args). They spread the real
 * module and are restored in an awaited afterAll; their forward-leak is proven
 * harmless by the sequential-import repro (see the #229 investigation):
 *   - `~/apps/claude-code/detect`: `detectClaudeInstalls()` (no args) returns a
 *     controllable install fixture. No env seam feeds a fixture in.
 *   - `~/apps/claude-desktop/config`: `home` defaults to `os.homedir()` (no env
 *     override), so without the mock the route would touch the developer's REAL
 *     Claude-3p userData dir. The mock redirects it to a tmp home.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ClaudeInstall } from "~/apps/claude-code/detect"

const ROUTE_3P_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "apps-route-3p-"))
const ROUTE_CC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "apps-route-ccdir-"))
const ROUTE_CC_SETTINGS = path.join(ROUTE_CC_DIR, "settings.json")

// Redirect the REAL claude-code settings path into our tmp dir via the env var
// that getClaudeCodeSettingsPath() honors. Saved + restored in afterAll so we
// don't leak the override to sibling files.
const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = ROUTE_CC_DIR

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

const actualDesktop = await import("~/apps/claude-desktop/config")
const realApply = actualDesktop.applyConfigLibraryProfile
const realRevert = actualDesktop.revertConfigLibraryProfile
const realIsApplied = actualDesktop.isConfigLibraryApplied
const realGetDir = actualDesktop.getClaude3pDir
// Wrappers forward ALL args (only defaulting the first `home` to the tmp
// home) so this mock stays behaviorally identical to the real module.
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
  fs.rmSync(ROUTE_CC_DIR, { recursive: true, force: true })
  fs.mkdirSync(ROUTE_CC_DIR, { recursive: true })
}

beforeEach(() => {
  writeConfig({})
  installsFixture = []
  cleanTmp()
})

afterAll(async () => {
  // Leave a clean slate so later files in the shared worker start empty, and
  // restore the mocked app modules + the env override so nothing leaks forward.
  writeConfig({})
  if (savedClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir
  }
  await mock.module("~/apps/claude-code/detect", () => actualDetect)
  await mock.module("~/apps/claude-desktop/config", () => actualDesktop)
  fs.rmSync(ROUTE_3P_HOME, { recursive: true, force: true })
  fs.rmSync(ROUTE_CC_DIR, { recursive: true, force: true })
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
