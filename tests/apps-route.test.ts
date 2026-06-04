/**
 * /settings/api/apps — route-level coverage.
 *
 * Mocking strategy (Bun's `mock.module` persists forward across files in
 * the run, so every override here is a *delegating wrapper* that only
 * changes default arguments — sibling tests that pass explicit args are
 * unaffected):
 *
 *   - `~/lib/config`: in-memory getConfig/writeConfig, reset per test
 *     and cleared in afterAll so later files see an empty config.
 *   - `~/lib/claude-cli-detect`: `detectClaudeInstalls()` with no args
 *     returns a controllable fixture (the route always calls it with no
 *     args); shim ops default `homeDir` to a tmp dir. Explicit-arg calls
 *     (the detect/shim unit tests) delegate to the real implementation.
 *   - `~/lib/claude-desktop-config`: file-path defaults point at a tmp
 *     file instead of the user's real Claude Desktop config.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ClaudeInstall } from "~/lib/claude-cli-detect"
import type { AppConfig } from "~/lib/config"

const ROUTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "apps-route-home-"))
const ROUTE_DESKTOP = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "apps-route-desktop-")),
  "claude_desktop_config.json",
)

let fakeConfig: AppConfig = {}
let installsFixture: Array<ClaudeInstall> = []

const actualConfig = await import("~/lib/config")
void mock.module("~/lib/config", () => ({
  ...actualConfig,
  getConfig: () => fakeConfig,
  writeConfig: (next: AppConfig) => {
    fakeConfig = next
    return next
  },
}))

const actualDetect = await import("~/lib/claude-cli-detect")
// Capture real impls into consts BEFORE mocking: `mock.module` updates
// the captured namespace's live bindings, so calling
// `actualDetect.installClaudeShim` inside the wrapper would re-enter the
// wrapper (infinite recursion). Consts pin the original functions.
const realDetect = actualDetect.detectClaudeInstalls
const realInstallShim = actualDetect.installClaudeShim
const realRemoveShim = actualDetect.removeClaudeShim
const realIsShimInstalled = actualDetect.isShimInstalled
const realReadShimTarget = actualDetect.readShimTarget
void mock.module("~/lib/claude-cli-detect", () => ({
  ...actualDetect,
  detectClaudeInstalls: (options?: Record<string, unknown>) =>
    options && Object.keys(options).length > 0 ?
      realDetect(options)
    : installsFixture,
  installClaudeShim: (
    target: string,
    opts: { apiKey?: string; homeDir?: string; maximalBinPath?: string } = {},
  ) =>
    realInstallShim(target, {
      ...opts,
      homeDir: opts.homeDir ?? ROUTE_HOME,
    }),
  removeClaudeShim: (homeDir: string = ROUTE_HOME) => realRemoveShim(homeDir),
  isShimInstalled: (homeDir: string = ROUTE_HOME) =>
    realIsShimInstalled(homeDir),
  readShimTarget: (homeDir: string = ROUTE_HOME) => realReadShimTarget(homeDir),
}))

const actualDesktop = await import("~/lib/claude-desktop-config")
const realApply = actualDesktop.applyProxyConfig
const realRevert = actualDesktop.revertProxyConfig
const realReadDesktop = actualDesktop.readClaudeDesktopConfig
// Wrappers forward ALL args (only defaulting the first to ROUTE_DESKTOP)
// so this mock stays behaviorally identical to the real module. Bun's
// `mock.module` persists forward across files in a run, so a wrapper
// that dropped later args (e.g. applyProxyConfig's `values`) would
// corrupt sibling tests that pass them.
void mock.module("~/lib/claude-desktop-config", () => ({
  ...actualDesktop,
  getClaudeDesktopConfigPath: () => ROUTE_DESKTOP,
  readClaudeDesktopConfig: (
    filePath: string = ROUTE_DESKTOP,
    ...rest: Array<unknown>
  ) =>
    (realReadDesktop as (...a: Array<unknown>) => unknown)(filePath, ...rest),
  applyProxyConfig: (
    filePath: string = ROUTE_DESKTOP,
    ...rest: Array<unknown>
  ) => (realApply as (...a: Array<unknown>) => unknown)(filePath, ...rest),
  revertProxyConfig: (
    filePath: string = ROUTE_DESKTOP,
    ...rest: Array<unknown>
  ) => (realRevert as (...a: Array<unknown>) => unknown)(filePath, ...rest),
}))

const { appsRoutes } = await import("~/routes/settings/apps")
const { getConfig } = await import("~/lib/config")

function buildApp() {
  const app = new Hono()
  app.route("/apps", appsRoutes)
  return app
}

function fakeInstall(p: string): ClaudeInstall {
  return { path: p, version: "1.2.3", source: "homebrew" }
}

beforeEach(() => {
  fakeConfig = {}
  installsFixture = []
  fs.rmSync(ROUTE_HOME, { recursive: true, force: true })
  fs.rmSync(path.dirname(ROUTE_DESKTOP), { recursive: true, force: true })
  fs.mkdirSync(path.dirname(ROUTE_DESKTOP), { recursive: true })
})

afterAll(() => {
  fakeConfig = {}
  fs.rmSync(ROUTE_HOME, { recursive: true, force: true })
  fs.rmSync(path.dirname(ROUTE_DESKTOP), { recursive: true, force: true })
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
    expect(body.apps[0].kind).toBe("shimmable")
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
  test("enable installs the shim and persists selectedPath", async () => {
    installsFixture = [fakeInstall("/opt/homebrew/bin/claude")]
    const res = await buildApp().request("/apps/claude-code/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      enabled: boolean
      installs: Array<{ active: boolean }>
    }
    expect(body.enabled).toBe(true)
    expect(body.installs[0].active).toBe(true)
    expect(getConfig().apps?.claudeCode).toEqual({
      enabled: true,
      selectedPath: "/opt/homebrew/bin/claude",
    })
    // Shim really written into the tmp home.
    expect(actualDetect.isShimInstalled(ROUTE_HOME)).toBe(true)
    expect(actualDetect.readShimTarget(ROUTE_HOME)).toBe(
      "/opt/homebrew/bin/claude",
    )
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

  test("disable removes the shim and persists enabled=false", async () => {
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
    expect(actualDetect.isShimInstalled(ROUTE_HOME)).toBe(false)
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

describe("POST /apps/claude-code/select", () => {
  test("rejects a path that is not a detected install", async () => {
    installsFixture = [fakeInstall("/opt/homebrew/bin/claude")]
    const res = await buildApp().request("/apps/claude-code/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/nope/claude" }),
    })
    expect(res.status).toBe(400)
  })

  test("sets selectedPath and rewrites an installed shim", async () => {
    installsFixture = [
      fakeInstall("/opt/homebrew/bin/claude"),
      fakeInstall("/usr/local/bin/claude"),
    ]
    const app = buildApp()
    await app.request("/apps/claude-code/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, path: "/opt/homebrew/bin/claude" }),
    })
    const res = await app.request("/apps/claude-code/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/usr/local/bin/claude" }),
    })
    expect(res.status).toBe(200)
    expect(getConfig().apps?.claudeCode?.selectedPath).toBe(
      "/usr/local/bin/claude",
    )
    expect(actualDetect.readShimTarget(ROUTE_HOME)).toBe(
      "/usr/local/bin/claude",
    )
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
    expect(
      actualDesktop.alreadyConfigured(
        actualDesktop.readClaudeDesktopConfig(ROUTE_DESKTOP),
      ),
    ).toBe(true)
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
    expect(
      actualDesktop.alreadyConfigured(
        actualDesktop.readClaudeDesktopConfig(ROUTE_DESKTOP),
      ),
    ).toBe(false)
  })
})
