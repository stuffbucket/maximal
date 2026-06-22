/**
 * Tests focus on the parts of uninstall that don't require root or
 * platform-specific calls — the Claude Desktop config reversion path
 * (the writer itself is covered by claude-desktop-3p-config.test.ts) plus
 * the binary-removal candidate list. The launchd / scheduled-task path is
 * exercised by the install scripts in B2/B3a; mocking spawnSync per-OS
 * here would be more brittle than the production code.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

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
    } = await import("~/lib/claude-desktop-3p-config")

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
      await import("~/lib/claude-code-settings")
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
    const { revertProxyBaseUrl } = await import("~/lib/claude-code-settings")
    const settings = path.join(workDir, "settings.json")
    expect(revertProxyBaseUrl(settings).wrote).toBe(false)
  })

  it("does not revert a foreign ANTHROPIC_BASE_URL", async () => {
    const { revertProxyBaseUrl } = await import("~/lib/claude-code-settings")
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
