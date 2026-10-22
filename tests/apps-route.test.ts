/**
 * /settings/api/apps — route-level coverage.
 *
 * Config comes from the REAL `~/lib/config/config`, which the global preload
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
const ROUTE_CODEX_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), "apps-route-codex-home-"),
)
const ROUTE_CODEX_BIN = fs.mkdtempSync(
  path.join(os.tmpdir(), "apps-route-codex-bin-"),
)
const ROUTE_CODEX_CONFIG = path.join(ROUTE_CODEX_HOME, "config.toml")

// Redirect the REAL claude-code settings path into our tmp dir via the env var
// that getClaudeCodeSettingsPath() honors. Saved + restored in afterAll so we
// don't leak the override to sibling files.
const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
const savedCodexHome = process.env.CODEX_HOME
const savedPath = process.env.PATH
process.env.CLAUDE_CONFIG_DIR = ROUTE_CC_DIR
process.env.CODEX_HOME = ROUTE_CODEX_HOME
process.env.PATH = ROUTE_CODEX_BIN

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
const realConflict = actualDesktop.configLibraryConflict
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
  configLibraryConflict: (home: string = ROUTE_3P_HOME) => realConflict(home),
  getClaude3pDir: (home: string = ROUTE_3P_HOME, ...rest: Array<unknown>) =>
    (realGetDir as (...a: Array<unknown>) => unknown)(home, ...rest),
}))

const { appsRoutes } = await import("~/routes/settings/apps")
const { getConfig, writeConfig } = await import("~/lib/config/config")
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
  fs.rmSync(ROUTE_CODEX_HOME, { recursive: true, force: true })
  fs.mkdirSync(ROUTE_CODEX_HOME, { recursive: true })
  fs.rmSync(ROUTE_CODEX_BIN, { recursive: true, force: true })
  fs.mkdirSync(ROUTE_CODEX_BIN, { recursive: true })
  fs.writeFileSync(path.join(ROUTE_CODEX_BIN, "codex"), "artifact only", {
    mode: 0o700,
  })
}

beforeEach(() => {
  writeConfig({ auth: { apiKeys: ["test-api-key"] } })
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
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedCodexHome
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  await mock.module("~/apps/claude-code/detect", () => actualDetect)
  await mock.module("~/apps/claude-desktop/config", () => actualDesktop)
  fs.rmSync(ROUTE_3P_HOME, { recursive: true, force: true })
  fs.rmSync(ROUTE_CC_DIR, { recursive: true, force: true })
  fs.rmSync(ROUTE_CODEX_HOME, { recursive: true, force: true })
  fs.rmSync(ROUTE_CODEX_BIN, { recursive: true, force: true })
})

describe("GET /apps", () => {
  test("returns four apps in alphabetical order with the right kinds", async () => {
    const res = await buildApp().request("/apps")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      apps: Array<{ id: string; name: string; kind: string; status: string }>
    }
    expect(body.apps.map((a) => a.id)).toEqual([
      "claude-code",
      "claude-desktop",
      "codex",
      "copilot-cli",
    ])
    expect(body.apps[0].kind).toBe("config")
    expect(body.apps[1].kind).toBe("config")
    expect(body.apps[2].kind).toBe("config")
    expect(body.apps[3].kind).toBe("coming-soon")
    expect(body.apps[3].status).toBe("coming-soon")
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

  test("isolates malformed Codex config as a typed app conflict", async () => {
    fs.writeFileSync(ROUTE_CODEX_CONFIG, 'model_provider = "unterminated\n')

    const response = await buildApp().request("/apps")
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      apps: Array<{ id: string; enabled: boolean; conflict: string | null }>
    }
    expect(body.apps.find(({ id }) => id === "codex")).toMatchObject({
      enabled: false,
      conflict: "cleanup-required",
    })
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

describe("POST /apps/codex/toggle", () => {
  test("enable and disable round-trip owned Codex routing", async () => {
    const app = buildApp()
    const enabled = await app.request("/apps/codex/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })

    expect(enabled.status).toBe(200)
    expect((await enabled.json()) as { enabled: boolean }).toMatchObject({
      enabled: true,
    })
    expect(getConfig().apps?.codex?.enabled).toBe(true)
    expect(fs.readFileSync(ROUTE_CODEX_CONFIG, "utf8")).toContain(
      'model_provider = "maximal-app"',
    )

    const disabled = await app.request("/apps/codex/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })
    expect(disabled.status).toBe(200)
    expect((await disabled.json()) as { enabled: boolean }).toMatchObject({
      enabled: false,
    })
    expect(getConfig().apps?.codex?.enabled).toBe(false)
    expect(fs.existsSync(ROUTE_CODEX_CONFIG)).toBe(false)
  })

  test("surfaces cleanup-required when edited provider content is retained", async () => {
    const app = buildApp()
    await app.request("/apps/codex/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    fs.writeFileSync(
      ROUTE_CODEX_CONFIG,
      fs
        .readFileSync(ROUTE_CODEX_CONFIG, "utf8")
        .replace('name = "Maximal"', 'name = "Customized Maximal"'),
    )

    const response = await app.request("/apps/codex/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })

    expect(response.status).toBe(200)
    expect((await response.json()) as { conflict: string }).toMatchObject({
      conflict: "cleanup-required",
    })
    expect(fs.readFileSync(ROUTE_CODEX_CONFIG, "utf8")).toContain(
      'name = "Customized Maximal"',
    )
  })

  test("returns typed cleanup state when config cannot be edited safely", async () => {
    fs.writeFileSync(ROUTE_CODEX_CONFIG, 'model_provider = "unterminated\n')

    for (const enabled of [true, false]) {
      const response = await buildApp().request("/apps/codex/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      })

      expect(response.status).toBe(200)
      expect(
        (await response.json()) as { enabled: boolean; conflict: string },
      ).toMatchObject({ enabled: false, conflict: "cleanup-required" })
    }
  })

  test("rejects an invalid toggle body", async () => {
    const response = await buildApp().request("/apps/codex/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    })

    expect(response.status).toBe(400)
    expect(fs.existsSync(ROUTE_CODEX_CONFIG)).toBe(false)
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

  test("enable authenticates Desktop with a real key, not a placeholder", async () => {
    await buildApp().request("/apps/claude-desktop/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    const lib = path.join(
      actualDesktop.getClaude3pDir(ROUTE_3P_HOME),
      "configLibrary",
    )
    const meta = actualDesktop.readJsonObject(path.join(lib, "_meta.json"))
    const profile = actualDesktop.readJsonObject(
      path.join(lib, `${String(meta?.appliedId)}.json`),
    )
    // beforeEach configures the default endpoint key, which Desktop shares
    // until a claude-desktop-labelled key exists — as Claude Code does.
    expect(profile?.inferenceGatewayApiKey).toBe("test-api-key")
  })

  test("enable leaves a foreign gateway profile alone and reports why", async () => {
    const lib = path.join(
      actualDesktop.getClaude3pDir(ROUTE_3P_HOME),
      "configLibrary",
    )
    fs.mkdirSync(lib, { recursive: true })
    fs.writeFileSync(
      path.join(lib, "corp.json"),
      JSON.stringify({
        inferenceProvider: "gateway",
        inferenceGatewayBaseUrl: "https://llm.corp.example",
      }),
    )
    fs.writeFileSync(
      path.join(lib, "_meta.json"),
      JSON.stringify({
        appliedId: "corp",
        entries: [{ id: "corp", name: "Work" }],
      }),
    )

    const res = await buildApp().request("/apps/claude-desktop/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      enabled: boolean
      conflict: string | null
    }
    expect(body.enabled).toBe(false)
    expect(body.conflict).toBe("foreign-gateway-profile")
    // The refused enable isn't recorded as the user's intent.
    expect(getConfig().apps?.claudeDesktop?.enabled).not.toBe(true)
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
