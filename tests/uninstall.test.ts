/**
 * Tests focus on the parts of uninstall that don't require root or
 * platform-specific calls — the Claude Desktop config reversion path
 * (the writer itself is covered by claude-desktop-3p-config.test.ts) plus
 * the binary-removal candidate list. The launchd / scheduled-task path is
 * exercised by the platform install scripts; mocking spawnSync per-OS
 * here would be more brittle than the production code.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test"
import consola from "consola"
import * as childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ClientApp } from "~/apps/index"

import * as realRegistryModule from "~/apps/registry"

// Capture the REAL registry exports by value at load time, before any test
// installs a `mock.module` over it. Bun's `mock.module` mutates the existing
// module record in place, so a reference captured *after* a mock is applied
// would already point at the fake — a spread copy taken now is immune. Each
// describe's afterAll restores from this so the registry mock can't leak
// forward into sibling test files.
const realRegistry = { ...realRegistryModule }

let workDir: string

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-uninstall-"))
})

afterEach(() => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe("uninstall — Claude Desktop revert integration", () => {
  it("revertConfigLibraryProfile removes our profile, preserving user prefs", async () => {
    const {
      applyConfigLibraryProfile,
      revertConfigLibraryProfile,
      isConfigLibraryApplied,
      getClaude3pDir,
    } = await import("~/apps/claude-desktop/config")

    const home = workDir
    const dir = getClaude3pDir(home)
    // Pre-seed a user-owned top-level config with unrelated prefs.
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "claude_desktop_config.json"),
      JSON.stringify({
        coworkUserFilesPath: "/Users/x/Claude",
        preferences: { theme: "dark" },
      }),
    )

    applyConfigLibraryProfile(home)
    expect(isConfigLibraryApplied(home)).toBe(true)

    const result = revertConfigLibraryProfile(home)
    expect(result.reverted).toBe(true)
    expect(isConfigLibraryApplied(home)).toBe(false)

    // User prefs survive the revert; only our deploymentMode is cleared.
    const cfgFile = path.join(dir, "claude_desktop_config.json")
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
    const after = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as Record<
      string,
      unknown
    >
    expect(after.deploymentMode).toBeUndefined()
    expect(after.coworkUserFilesPath).toBe("/Users/x/Claude")
    expect((after.preferences as { theme: string }).theme).toBe("dark")
  })
})

describe("uninstall — Claude Code settings revert integration", () => {
  it("reverts only the ANTHROPIC_BASE_URL we wrote, preserving other env", async () => {
    const { applyProxyBaseUrl, revertProxyBaseUrl, isProxyBaseUrlConfigured } =
      await import("~/apps/claude-code/config")
    const settings = path.join(workDir, "settings.json")
    // Seed a sibling env var we must NOT touch.
    fs.writeFileSync(
      settings,
      JSON.stringify({ env: { ANTHROPIC_API_KEY: "user-key" } }),
    )

    applyProxyBaseUrl(settings, () => ({
      ok: true,
      key: "test-api-key",
      source: "default",
    }))
    expect(isProxyBaseUrlConfigured(settings)).toBe(true)

    const reverted = revertProxyBaseUrl(settings)
    expect(reverted.wrote).toBe(true)
    expect(isProxyBaseUrlConfigured(settings)).toBe(false)
    // The user's own key survived.
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    const after = JSON.parse(fs.readFileSync(settings, "utf8")) as {
      env?: {
        ANTHROPIC_API_KEY?: string
        CLAUDE_CODE_AUTO_MODE_SERVER?: string
      }
    }
    expect(after.env?.ANTHROPIC_API_KEY).toBe("user-key")
    expect(after.env?.CLAUDE_CODE_AUTO_MODE_SERVER).toBeUndefined()
  })

  it("revert is a no-op when nothing was configured", async () => {
    const { revertProxyBaseUrl } = await import("~/apps/claude-code/config")
    const settings = path.join(workDir, "settings.json")
    expect(revertProxyBaseUrl(settings).wrote).toBe(false)
  })

  it("does not revert a foreign ANTHROPIC_BASE_URL", async () => {
    const { revertProxyBaseUrl } = await import("~/apps/claude-code/config")
    const settings = path.join(workDir, "settings.json")
    fs.writeFileSync(
      settings,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.example" } }),
    )
    revertProxyBaseUrl(settings)
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    const after = JSON.parse(fs.readFileSync(settings, "utf8")) as {
      env?: { ANTHROPIC_BASE_URL?: string }
    }
    expect(after.env?.ANTHROPIC_BASE_URL).toBe("https://other.example")
  })
})

describe("uninstall — install-target selection (--keep-app)", () => {
  const home = path.join(os.tmpdir(), "maximal-install-target-home")
  const symlinkPath = path.join(home, ".local", "bin", "maximal")
  const servicePath = path.join(
    home,
    "Library",
    "Application Support",
    "Maximal",
    "bin",
    "maximal",
  )
  const appBundlePath = path.join(home, "Applications", "Maximal.app")

  it("targets only app-owned macOS locations", async () => {
    const { installTargets } = await import("~/uninstall")
    const paths = installTargets({
      homeDir: home,
      platform: "darwin",
      appBundlePath,
    }).map((target) => target.path)
    expect(paths).toEqual([symlinkPath, servicePath, appBundlePath])
    expect(paths).not.toContain("/opt/homebrew/bin/maximal")
    expect(paths).not.toContain("/usr/local/bin/maximal")
  })

  it("--keep-app preserves only the running bundle", async () => {
    const { installTargets } = await import("~/uninstall")
    const paths = installTargets({
      homeDir: home,
      platform: "darwin",
      appBundlePath,
      keepApp: true,
    }).map((target) => target.path)
    expect(paths).toEqual([symlinkPath, servicePath])
  })

  it("leaves Linux package-manager binaries to their installer", async () => {
    const { installTargets } = await import("~/uninstall")
    expect(installTargets({ homeDir: home, platform: "linux" })).toEqual([])
  })

  it("leaves Windows package files to their installer", async () => {
    const { installTargets } = await import("~/uninstall")
    expect(
      installTargets({
        platform: "win32",
        homeDir: String.raw`C:\Users\fixture`,
      }),
    ).toEqual([])
  })
})

describe("uninstall — historical app CLI ownership", () => {
  it("recognizes only symlinks into Maximal.app", async () => {
    if (process.platform === "win32") return
    const { isAppOwnedCliSymlink } = await import("~/uninstall")
    const owned = path.join(workDir, "owned")
    const lowercaseOwned = path.join(workDir, "lowercase-owned")
    const suffixOnly = path.join(workDir, "suffix-only")
    const foreign = path.join(workDir, "foreign")
    const regular = path.join(workDir, "regular")
    fs.symlinkSync("/Applications/Maximal.app/Contents/MacOS/maximal", owned)
    fs.symlinkSync(
      "/Applications/maximal.app/Contents/MacOS/maximal",
      lowercaseOwned,
    )
    fs.symlinkSync(
      path.join(workDir, "Maximal.app", "Contents", "MacOS", "maximal"),
      suffixOnly,
    )
    fs.symlinkSync("/opt/homebrew/bin/maximal", foreign)
    fs.writeFileSync(regular, "user owned\n")

    expect(isAppOwnedCliSymlink(owned)).toBe(true)
    expect(isAppOwnedCliSymlink(lowercaseOwned)).toBe(true)
    expect(isAppOwnedCliSymlink(suffixOnly)).toBe(false)
    expect(isAppOwnedCliSymlink(foreign)).toBe(false)
    expect(isAppOwnedCliSymlink(regular)).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────
// Registry-driven precondition gate + revert sweep.
//
// These exercise the SAFETY-CRITICAL precondition logic in uninstall.ts
// without ever running its destructive steps (stopProxy / removeBinary
// shell out and rmSync REAL paths). We mock the app registry so
// `getAllApps()` returns in-memory fakes, and we only ever drive
// `runUninstall` down its REFUSAL path — it throws at the gate, before
// any destructive step. The registry mock is captured and restored in
// afterAll so it can't leak into sibling test files (Bun's `mock.module`
// persists forward across a run).
// ────────────────────────────────────────────────────────────────────

interface FakeAppOptions {
  id: string
  name: string
  enabled: boolean
  disable?: ReturnType<typeof mock>
  uninstall?: ReturnType<typeof mock>
}

function makeFakeApp(opts: FakeAppOptions): ClientApp {
  const disable = opts.disable ?? mock(() => Promise.resolve({ success: true }))
  const uninstall =
    opts.uninstall ?? mock(() => Promise.resolve({ reverted: [] }))
  return {
    id: opts.id as ClientApp["id"],
    name: opts.name,
    kind: "config",
    isEnabled: () => opts.enabled,
    disable,
    uninstall,
    // Only the members above are exercised by enabledApps /
    // revertAppIntegrations / the runUninstall gate. The rest satisfy the
    // ClientApp contract but are never called by these paths.
    detect: () => Promise.resolve(true),
    getDetails: () => Promise.reject(new Error("not used")),
    enable: () => Promise.resolve({ success: true }),
  }
}

describe("uninstall — enabledApps (registry-driven precondition)", () => {
  // Each test installs its own registry mock; afterAll restores the real one
  // (captured by value at module load — see `realRegistry`).
  afterAll(async () => {
    await mock.module("~/apps/registry", () => realRegistry)
  })

  it("returns only apps whose isEnabled() is true", async () => {
    const enabledApp = makeFakeApp({
      id: "claude-code",
      name: "Claude Code",
      enabled: true,
    })
    const disabledApp = makeFakeApp({
      id: "claude-desktop",
      name: "Claude Desktop",
      enabled: false,
    })
    await mock.module("~/apps/registry", () => ({
      getAllApps: () => [enabledApp, disabledApp],
    }))
    const { enabledApps } = await import("~/uninstall")
    const result = enabledApps()
    expect(result.map((a) => a.name)).toEqual(["Claude Code"])
  })

  it("returns empty when no app is enabled", async () => {
    await mock.module("~/apps/registry", () => ({
      getAllApps: () => [
        makeFakeApp({ id: "claude-code", name: "Claude Code", enabled: false }),
        makeFakeApp({
          id: "claude-desktop",
          name: "Claude Desktop",
          enabled: false,
        }),
      ],
    }))
    const { enabledApps } = await import("~/uninstall")
    expect(enabledApps()).toEqual([])
  })

  it("filters a mix down to exactly the enabled subset", async () => {
    await mock.module("~/apps/registry", () => ({
      getAllApps: () => [
        makeFakeApp({ id: "claude-code", name: "Claude Code", enabled: true }),
        makeFakeApp({
          id: "claude-desktop",
          name: "Claude Desktop",
          enabled: false,
        }),
        makeFakeApp({ id: "copilot-cli", name: "Copilot CLI", enabled: true }),
      ],
    }))
    const { enabledApps } = await import("~/uninstall")
    expect(enabledApps().map((a) => a.name)).toEqual([
      "Claude Code",
      "Copilot CLI",
    ])
  })
})

describe("uninstall — runUninstall precondition gate (refusal path only)", () => {
  afterAll(async () => {
    await mock.module("~/apps/registry", () => realRegistry)
  })

  it("throws (refuses) when ≥1 app is enabled and force=false, naming the apps", async () => {
    // disable() must NEVER be called on the refusal path — if it were, we'd
    // have run past the gate. Wire it to throw so any accidental call is loud.
    const disableSpy = mock(() => {
      throw new Error("disable() must not run on the refusal path")
    })
    await mock.module("~/apps/registry", () => ({
      getAllApps: () => [
        makeFakeApp({
          id: "claude-code",
          name: "Claude Code",
          enabled: true,
          disable: disableSpy,
        }),
        makeFakeApp({
          id: "copilot-cli",
          name: "Copilot CLI",
          enabled: true,
          disable: disableSpy,
        }),
      ],
    }))
    const { runUninstall } = await import("~/uninstall")

    // It rejects at the gate, before any destructive step. Capture the error
    // and assert on its message directly (rather than `.rejects`, which the
    // lint rule doesn't treat as thenable).
    let caught: unknown
    try {
      await runUninstall({
        purge: false,
        force: false,
        unattended: true,
        keepApp: false,
        homeDir: workDir,
        platform: "linux",
        appBundlePath: path.join(workDir, "Applications", "Maximal.app"),
        dataDir: path.join(workDir, "data"),
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toContain("Refusing to uninstall while apps are enabled")
    // The message names every enabled app.
    expect(message).toContain("Claude Code")
    expect(message).toContain("Copilot CLI")
    // Proof we never crossed the gate: the disable sweep (step 4) never ran.
    expect(disableSpy).not.toHaveBeenCalled()
  })

  // Case 3 (gate PASSES) — driven END-TO-END through runUninstall, with every
  // destructive step neutralized so the real gate predicate executes (mirroring
  // it in the test can't catch a `> 0`→`>= 0` or `&&`→`||` mutation). We spy the
  // syscalls the post-gate steps bottom out on:
  //   • spawnSync (launchctl/schtasks) → no-op success
  //   • fs.lstatSync → throw ENOENT so removeBinary finds nothing to remove
  //   • fs.existsSync → false so removeStartupIntegration / purge find nothing
  //   • fs.rmSync → throw (belt-and-braces: must never be reached given the above)
  // With force=true (or no apps enabled) the gate must NOT throw and must reach
  // the step-4 disable→sweep. afterEach restores all spies.
  describe("gate PASSES end-to-end (destructive steps mocked)", () => {
    const restore: Array<() => void> = []

    function neutralizeDestructiveSteps() {
      const spawnSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
        status: 0,
        stdout: "",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      })
      const lstatSpy = spyOn(fs, "lstatSync").mockImplementation(() => {
        const err = new Error("ENOENT (test)") as NodeJS.ErrnoException
        err.code = "ENOENT"
        throw err
      })
      const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false)
      const rmSpy = spyOn(fs, "rmSync").mockImplementation(() => {
        throw new Error("fs.rmSync must not run in the gate-pass test")
      })
      restore.push(
        () => spawnSpy.mockRestore(),
        () => lstatSpy.mockRestore(),
        () => existsSpy.mockRestore(),
        () => rmSpy.mockRestore(),
      )
      return { existsSpy, lstatSpy, spawnSpy }
    }

    afterEach(() => {
      while (restore.length > 0) restore.pop()?.()
    })

    it("force=true with apps enabled does NOT throw and runs the disable→sweep", async () => {
      const { existsSpy, lstatSpy, spawnSpy } = neutralizeDestructiveSteps()
      const disable = mock(() => Promise.resolve({ success: true }))
      const uninstall = mock(() => Promise.resolve({ reverted: [] }))
      await mock.module("~/apps/registry", () => ({
        getAllApps: () => [
          makeFakeApp({
            id: "claude-code",
            name: "Claude Code",
            enabled: true,
            disable,
            uninstall,
          }),
        ],
      }))
      const { runUninstall } = await import("~/uninstall")

      // Must resolve (not throw): force=true short-circuits the refusal even
      // though an app is enabled. Then step 4 disables the enabled app and
      // sweeps uninstall() across the registry.
      await runUninstall({
        purge: false,
        force: true,
        unattended: true,
        keepApp: false,
        homeDir: workDir,
        platform: "darwin",
        appBundlePath: path.join(workDir, "Applications", "Maximal.app"),
        dataDir: path.join(workDir, "data"),
        spawn: spawnSpy as unknown as typeof childProcess.spawnSync,
      })
      expect(existsSpy).toHaveBeenCalledWith(
        path.join(
          workDir,
          "Library",
          "LaunchAgents",
          "co.stuffbucket.maximal.plist",
        ),
      )
      expect(lstatSpy).toHaveBeenCalledWith(
        path.join(workDir, ".local", "bin", "maximal"),
      )
      expect(lstatSpy).toHaveBeenCalledWith(
        path.join(workDir, "Applications", "Maximal.app"),
      )
      expect(disable).toHaveBeenCalledTimes(1)
      expect(uninstall).toHaveBeenCalledTimes(1)
    })

    it("no apps enabled does NOT throw (force=false), sweeps uninstall only", async () => {
      neutralizeDestructiveSteps()
      const disable = mock(() => Promise.resolve({ success: true }))
      const uninstall = mock(() => Promise.resolve({ reverted: [] }))
      await mock.module("~/apps/registry", () => ({
        getAllApps: () => [
          makeFakeApp({
            id: "claude-code",
            name: "Claude Code",
            enabled: false,
            disable,
            uninstall,
          }),
        ],
      }))
      const { runUninstall } = await import("~/uninstall")

      // Empty enabledApps() → gate body skipped regardless of force. No app was
      // enabled, so the step-4 disable pass touches nothing, but the uninstall
      // sweep still runs ownership-guarded across the registry.
      await runUninstall({
        purge: false,
        force: false,
        unattended: true,
        keepApp: false,
        homeDir: workDir,
        platform: "linux",
        appBundlePath: path.join(workDir, "Applications", "Maximal.app"),
        dataDir: path.join(workDir, "data"),
      })
      expect(disable).not.toHaveBeenCalled()
      expect(uninstall).toHaveBeenCalledTimes(1)
    })
  })
})

describe("uninstall — revertAppIntegrations (registry sweep)", () => {
  afterAll(async () => {
    await mock.module("~/apps/registry", () => realRegistry)
  })

  it("disables every still-enabled app and uninstalls every registered app, surfacing reverted lines", async () => {
    const disableA = mock(() => Promise.resolve({ success: true }))
    const uninstallA = mock(() =>
      Promise.resolve({ reverted: ["reverted A line"] }),
    )
    const uninstallB = mock(() =>
      Promise.resolve({ reverted: ["reverted B line"] }),
    )

    const appA = makeFakeApp({
      id: "claude-code",
      name: "Claude Code",
      enabled: true,
      disable: disableA,
      uninstall: uninstallA,
    })
    const appB = makeFakeApp({
      id: "claude-desktop",
      name: "Claude Desktop",
      enabled: false,
      uninstall: uninstallB,
    })

    await mock.module("~/apps/registry", () => ({
      getAllApps: () => [appA, appB],
    }))
    const { revertAppIntegrations } = await import("~/uninstall")

    // stillEnabled is just appA; the sweep still uninstalls BOTH apps.
    await revertAppIntegrations([appA])

    // (a) every app in stillEnabled was disabled
    expect(disableA).toHaveBeenCalledTimes(1)
    // (b) every app from getAllApps() was uninstalled
    expect(uninstallA).toHaveBeenCalledTimes(1)
    expect(uninstallB).toHaveBeenCalledTimes(1)
  })

  it("surfaces partial-cleanup conflicts from disable and uninstall", async () => {
    const warn = spyOn(consola, "warn")
    const disable = mock(() =>
      Promise.resolve({
        success: false,
        conflict: "cleanup-required" as const,
      }),
    )
    const uninstall = mock(() =>
      Promise.resolve({
        reverted: [],
        conflict: "cleanup-required" as const,
      }),
    )
    const app = makeFakeApp({
      id: "claude-code",
      name: "Codex",
      enabled: true,
      disable,
      uninstall,
    })

    try {
      await mock.module("~/apps/registry", () => ({
        getAllApps: () => [app],
      }))
      const { revertAppIntegrations } = await import("~/uninstall")

      await revertAppIntegrations([app])

      expect(warn).toHaveBeenCalledWith(
        "  Codex requires manual cleanup",
        "cleanup-required",
      )
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it("continues the loop when a disable() throws (other apps still process)", async () => {
    const badDisable = mock(() => Promise.reject(new Error("boom disable")))
    const goodDisable = mock(() => Promise.resolve({ success: true }))
    const uninstallA = mock(() => Promise.resolve({ reverted: [] }))
    const uninstallB = mock(() => Promise.resolve({ reverted: [] }))

    const appA = makeFakeApp({
      id: "claude-code",
      name: "Claude Code",
      enabled: true,
      disable: badDisable,
      uninstall: uninstallA,
    })
    const appB = makeFakeApp({
      id: "claude-desktop",
      name: "Claude Desktop",
      enabled: true,
      disable: goodDisable,
      uninstall: uninstallB,
    })

    await mock.module("~/apps/registry", () => ({
      getAllApps: () => [appA, appB],
    }))
    const { revertAppIntegrations } = await import("~/uninstall")

    // The first app's disable() rejects; the call must not abort the loop.
    await revertAppIntegrations([appA, appB])

    expect(badDisable).toHaveBeenCalledTimes(1)
    expect(goodDisable).toHaveBeenCalledTimes(1) // loop continued past the throw
    // The uninstall sweep still ran for both apps afterwards.
    expect(uninstallA).toHaveBeenCalledTimes(1)
    expect(uninstallB).toHaveBeenCalledTimes(1)
  })

  it("continues the uninstall sweep when one uninstall() throws", async () => {
    const badUninstall = mock(() => Promise.reject(new Error("boom uninstall")))
    const goodUninstall = mock(() =>
      Promise.resolve({ reverted: ["B reverted"] }),
    )

    const appA = makeFakeApp({
      id: "claude-code",
      name: "Claude Code",
      enabled: false,
      uninstall: badUninstall,
    })
    const appB = makeFakeApp({
      id: "claude-desktop",
      name: "Claude Desktop",
      enabled: false,
      uninstall: goodUninstall,
    })

    await mock.module("~/apps/registry", () => ({
      getAllApps: () => [appA, appB],
    }))
    const { revertAppIntegrations } = await import("~/uninstall")

    await revertAppIntegrations([])

    expect(badUninstall).toHaveBeenCalledTimes(1)
    expect(goodUninstall).toHaveBeenCalledTimes(1) // sweep continued past the throw
  })
})
