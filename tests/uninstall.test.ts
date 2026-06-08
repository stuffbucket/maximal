/**
 * Tests focus on the parts of uninstall that don't require root or
 * platform-specific calls — the Claude Desktop config reversion path
 * (which is fully covered by claude-desktop-config.test.ts) plus the
 * binary-removal candidate list. The launchd / scheduled-task path is
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
  it("calling revertProxyConfig from uninstall removes only our keys", async () => {
    const { revertProxyConfig, applyProxyConfig, readClaudeDesktopConfig } =
      await import("~/lib/claude-desktop-config")

    const cfg = path.join(workDir, "claude_desktop_config.json")
    fs.writeFileSync(
      cfg,
      JSON.stringify({ mcpServers: { x: { command: "y" } }, theme: "dark" }),
    )
    applyProxyConfig(cfg)
    // Sanity: our keys are now present alongside the user's.
    expect(readClaudeDesktopConfig(cfg).inferenceProvider).toBe("gateway")

    const result = revertProxyConfig(cfg)
    expect(result.wrote).toBe(true)
    expect(result.remainingKeys.sort()).toEqual(["mcpServers", "theme"])

    const after = readClaudeDesktopConfig(cfg)
    expect(after.inferenceProvider).toBeUndefined()
    expect(after.mcpServers).toEqual({ x: { command: "y" } })
    expect(after.theme).toBe("dark")
  })
})

describe("uninstall — Claude Code shim removal integration", () => {
  it("removeClaudeShim deletes a shim the Apps panel installed", async () => {
    const {
      installClaudeShim,
      removeClaudeShim,
      isShimInstalled,
      getShimPath,
    } = await import("~/lib/claude-cli-detect")

    installClaudeShim("/opt/homebrew/bin/claude", { homeDir: workDir })
    expect(isShimInstalled(workDir)).toBe(true)

    expect(removeClaudeShim(workDir)).toBe(true)
    expect(fs.existsSync(getShimPath(workDir))).toBe(false)
    // Second call is a no-op, not an error — uninstall is idempotent.
    expect(removeClaudeShim(workDir)).toBe(false)
  })

  it("removeClaudeShim no-ops when there is no shim", async () => {
    const { removeClaudeShim } = await import("~/lib/claude-cli-detect")
    expect(removeClaudeShim(workDir)).toBe(false)
  })

  it("removeClaudeShim refuses to delete a non-marker file at the shim path", async () => {
    const { removeClaudeShim, getShimPath } =
      await import("~/lib/claude-cli-detect")
    const shimPath = getShimPath(workDir)
    fs.mkdirSync(path.dirname(shimPath), { recursive: true })
    fs.writeFileSync(shimPath, "#!/bin/sh\necho not ours\n")
    expect(() => removeClaudeShim(workDir)).toThrow()
    // The non-marker file is left untouched.
    expect(fs.existsSync(shimPath)).toBe(true)
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

  it("does not touch the Claude Code shim block (different marker)", async () => {
    const { removeFirstLaunchPathBlock } = await import("~/uninstall")
    const { addShimDirToPath } = await import("~/lib/claude-cli-detect")
    // Both blocks present in the same rc file.
    fs.writeFileSync(
      path.join(workDir, ".zshrc"),
      "# >>> maximal PATH >>>\n"
        + 'export PATH="$HOME/.local/bin:$PATH"\n'
        + "# <<< maximal PATH <<<\n",
    )
    addShimDirToPath(workDir)

    removeFirstLaunchPathBlock(workDir)
    const after = fs.readFileSync(path.join(workDir, ".zshrc"), "utf8")
    expect(after).not.toContain("maximal PATH") // installer block removed
    expect(after).toContain("maximal claude shim") // shim block untouched
  })
})
