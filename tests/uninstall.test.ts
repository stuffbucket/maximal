/**
 * Tests focus on the parts of uninstall that don't require root or
 * platform-specific calls — the Claude Desktop config reversion path
 * (the writer itself is covered by claude-desktop-3p-config.test.ts) plus
 * the binary-removal candidate list. The launchd / scheduled-task path is
 * exercised by the install scripts in B2/B3a; mocking spawnSync per-OS
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

    applyProxyBaseUrl(settings)
    expect(isProxyBaseUrlConfigured(settings)).toBe(true)

    const reverted = revertProxyBaseUrl(settings)
    expect(reverted.wrote).toBe(true)
    expect(isProxyBaseUrlConfigured(settings)).toBe(false)
    // The user's own key survived.
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    const after = JSON.parse(fs.readFileSync(settings, "utf8")) as {
      env?: { ANTHROPIC_API_KEY?: string }
    }
    expect(after.env?.ANTHROPIC_API_KEY).toBe("user-key")
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
  const home = os.homedir()
  const symlinkPath = path.join(home, ".local", "bin", "maximal")
  const appBundlePath = "/Applications/maximal.app"

  it("default removal targets the .app bundle and the PATH symlink", async () => {
    const { installTargets } = await import("~/uninstall")
    if (process.platform === "win32") return // .app path is macOS/Linux only
    const paths = installTargets().map((t) => t.path)
    expect(paths).toContain(symlinkPath)
    expect(paths).toContain(appBundlePath)
  })

  it("--keep-app leaves the .app bundle untouched but still removes the symlink", async () => {
    const { installTargets } = await import("~/uninstall")
    if (process.platform === "win32") return
    const paths = installTargets({ keepApp: true }).map((t) => t.path)
    // The running bundle survives…
    expect(paths).not.toContain(appBundlePath)
    expect(paths.some((p) => p.endsWith(".app"))).toBe(false)
    // …but the on-PATH CLI symlink (and the other PATH binaries) still go.
    expect(paths).toContain(symlinkPath)
    expect(paths).toContain("/opt/homebrew/bin/maximal")
  })
})

describe("uninstall — first-launch installer PATH block removal", () => {
  it("strips the # >>> maximal PATH >>> block, preserving other rc content", async () => {
    const { removeFirstLaunchPathBlock } = await import("~/uninstall")
    const zshrc = path.join(workDir, ".zshrc")
    fs.writeFileSync(
      zshrc,
      "# my stuff\nexport FOO=bar\n\n"
        + "# >>> maximal PATH >>>\n"
        + 'export PATH="$HOME/.local/bin:$PATH"\n'
        + "# <<< maximal PATH <<<\n",
    )

    const modified = removeFirstLaunchPathBlock(workDir)
    expect(modified).toContain(zshrc)

    const after = fs.readFileSync(zshrc, "utf8")
    expect(after).toContain("export FOO=bar") // user content preserved
    expect(after).not.toContain("maximal PATH") // our block gone
    expect(after).not.toContain(".local/bin")
  })

  it("no-ops (returns []) when the block isn't present", async () => {
    const { removeFirstLaunchPathBlock } = await import("~/uninstall")
    fs.writeFileSync(path.join(workDir, ".zshrc"), "export FOO=bar\n")
    expect(removeFirstLaunchPathBlock(workDir)).toEqual([])
  })

  it("touches only the # >>> maximal PATH >>> block, leaving other content", async () => {
    const { removeFirstLaunchPathBlock } = await import("~/uninstall")
    const zshrc = path.join(workDir, ".zshrc")
    // Installer block plus an unrelated user PATH line that must survive.
    fs.writeFileSync(
      zshrc,
      "# >>> maximal PATH >>>\n"
        + 'export PATH="$HOME/.local/bin:$PATH"\n'
        + "# <<< maximal PATH <<<\n"
        + 'export PATH="$HOME/mytools:$PATH"\n',
    )

    removeFirstLaunchPathBlock(workDir)
    const after = fs.readFileSync(zshrc, "utf8")
    expect(after).not.toContain("maximal PATH") // installer block removed
    expect(after).toContain("mytools") // unrelated user line untouched
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
  afterAll(() => {
    void mock.module("~/apps/registry", () => realRegistry)
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
    void mock.module("~/apps/registry", () => ({
      getAllApps: () => [enabledApp, disabledApp],
    }))
    const { enabledApps } = await import("~/uninstall")
    const result = enabledApps()
    expect(result.map((a) => a.name)).toEqual(["Claude Code"])
  })

  it("returns empty when no app is enabled", async () => {
    void mock.module("~/apps/registry", () => ({
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
    void mock.module("~/apps/registry", () => ({
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
  afterAll(() => {
    void mock.module("~/apps/registry", () => realRegistry)
  })

  it("throws (refuses) when ≥1 app is enabled and force=false, naming the apps", async () => {
    // disable() must NEVER be called on the refusal path — if it were, we'd
    // have run past the gate. Wire it to throw so any accidental call is loud.
    const disableSpy = mock(() => {
      throw new Error("disable() must not run on the refusal path")
    })
    void mock.module("~/apps/registry", () => ({
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

    function neutralizeDestructiveSteps(): void {
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
    }

    afterEach(() => {
      while (restore.length > 0) restore.pop()?.()
    })

    it("force=true with apps enabled does NOT throw and runs the disable→sweep", async () => {
      neutralizeDestructiveSteps()
      const disable = mock(() => Promise.resolve({ success: true }))
      const uninstall = mock(() => Promise.resolve({ reverted: [] }))
      void mock.module("~/apps/registry", () => ({
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
      })
      expect(disable).toHaveBeenCalledTimes(1)
      expect(uninstall).toHaveBeenCalledTimes(1)
    })

    it("no apps enabled does NOT throw (force=false), sweeps uninstall only", async () => {
      neutralizeDestructiveSteps()
      const disable = mock(() => Promise.resolve({ success: true }))
      const uninstall = mock(() => Promise.resolve({ reverted: [] }))
      void mock.module("~/apps/registry", () => ({
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
      })
      expect(disable).not.toHaveBeenCalled()
      expect(uninstall).toHaveBeenCalledTimes(1)
    })
  })
})

describe("uninstall — revertAppIntegrations (registry sweep)", () => {
  afterAll(() => {
    void mock.module("~/apps/registry", () => realRegistry)
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

    void mock.module("~/apps/registry", () => ({
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

    void mock.module("~/apps/registry", () => ({
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

    void mock.module("~/apps/registry", () => ({
      getAllApps: () => [appA, appB],
    }))
    const { revertAppIntegrations } = await import("~/uninstall")

    await revertAppIntegrations([])

    expect(badUninstall).toHaveBeenCalledTimes(1)
    expect(goodUninstall).toHaveBeenCalledTimes(1) // sweep continued past the throw
  })

  it("strips the first-launch installer PATH block via removeFirstLaunchPathBlock", async () => {
    // revertAppIntegrations calls removeFirstLaunchPathBlock(), which reads the
    // rc files under os.homedir(). Point HOME at a temp dir holding a seeded
    // installer block and assert it gets stripped — proof the call is invoked.
    const fakeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "maximal-revert-home-"),
    )
    const zshrc = path.join(fakeHome, ".zshrc")
    fs.writeFileSync(
      zshrc,
      "export KEEPME=1\n"
        + "# >>> maximal PATH >>>\n"
        + 'export PATH="$HOME/.local/bin:$PATH"\n'
        + "# <<< maximal PATH <<<\n",
    )
    // removeFirstLaunchPathBlock() reads rc files under os.homedir(); point it
    // at our temp home so the call is observable via the stripped block.
    const homedirSpy = spyOn(os, "homedir").mockReturnValue(fakeHome)
    try {
      void mock.module("~/apps/registry", () => ({
        getAllApps: () => [
          makeFakeApp({
            id: "claude-code",
            name: "Claude Code",
            enabled: false,
          }),
        ],
      }))
      const { revertAppIntegrations } = await import("~/uninstall")
      await revertAppIntegrations([])

      const after = fs.readFileSync(zshrc, "utf8")
      expect(after).not.toContain("maximal PATH") // installer block stripped
      expect(after).toContain("KEEPME=1") // unrelated content preserved
    } finally {
      homedirSpy.mockRestore()
      fs.rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})
