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

const TMP_ROOT = path.join(os.tmpdir(), `uninstall-test-${Date.now()}`)
let workDir: string

beforeEach(() => {
  workDir = path.join(TMP_ROOT, `case-${crypto.randomUUID()}`)
  fs.mkdirSync(workDir, { recursive: true })
})

afterEach(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
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
