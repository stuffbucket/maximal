/**
 * Tests for the `configure-claude-code` subcommand — the shared reverter
 * the Tauri shell calls after a sidecar crash.
 *
 * `runConfigureClaudeCode` takes an injectable `filePath`, so we drive it at
 * a tmp settings file directly — no `mock.module`, no `CLAUDE_CONFIG_DIR`
 * env reliance (a sibling file's `mock.module` of claude-code-settings would
 * otherwise defeat env-based path resolution across CI's file ordering;
 * CLAUDE.md → prefer injectable options).
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  configureClaudeCode,
  runConfigureClaudeCode,
} from "~/apps/claude-code/cli"
import {
  isProxyBaseUrlConfigured,
  PROXY_BASE_URL,
  readClaudeCodeSettings,
} from "~/apps/claude-code/config"

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cc-configure-"))
const SETTINGS = path.join(TMP_DIR, "settings.json")

beforeEach(() => {
  fs.rmSync(SETTINGS, { force: true })
})

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe("configure-claude-code subcommand", () => {
  test("exposes the documented metadata and --revert flag", async () => {
    const meta = await resolveMaybe(configureClaudeCode.meta)
    expect(meta?.name).toBe("configure-claude-code")
    expect(meta?.description).toContain("Claude Code")
    const args = await resolveMaybe(configureClaudeCode.args)
    expect(args?.revert).toBeDefined()
    expect(args?.revert.type).toBe("boolean")
  })

  test("apply writes the proxy base URL", () => {
    runConfigureClaudeCode({ revert: false, filePath: SETTINGS })
    expect(isProxyBaseUrlConfigured(SETTINGS)).toBe(true)
  })

  test("revert removes the proxy base URL we wrote", () => {
    runConfigureClaudeCode({ revert: false, filePath: SETTINGS })
    expect(isProxyBaseUrlConfigured(SETTINGS)).toBe(true)
    runConfigureClaudeCode({ revert: true, filePath: SETTINGS })
    expect(isProxyBaseUrlConfigured(SETTINGS)).toBe(false)
  })

  test("revert leaves a foreign base URL intact", () => {
    fs.writeFileSync(
      SETTINGS,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.example" } }),
    )
    runConfigureClaudeCode({ revert: true, filePath: SETTINGS })
    const env = (readClaudeCodeSettings(SETTINGS).env ?? {}) as Record<
      string,
      unknown
    >
    expect(env.ANTHROPIC_BASE_URL).toBe("https://other.example")
  })

  test("apply does not clobber a foreign base URL", () => {
    fs.writeFileSync(
      SETTINGS,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.example" } }),
    )
    runConfigureClaudeCode({ revert: false, filePath: SETTINGS })
    expect(isProxyBaseUrlConfigured(SETTINGS)).toBe(false)
    const env = (readClaudeCodeSettings(SETTINGS).env ?? {}) as Record<
      string,
      unknown
    >
    expect(env.ANTHROPIC_BASE_URL).toBe("https://other.example")
    // PROXY_BASE_URL is the value we'd have written; confirm we didn't.
    expect(env.ANTHROPIC_BASE_URL).not.toBe(PROXY_BASE_URL)
  })
})

async function resolveMaybe<T>(
  value: T | (() => T) | (() => Promise<T>) | undefined,
): Promise<T | undefined> {
  if (typeof value === "function") {
    const r = (value as () => T | Promise<T>)()
    return await Promise.resolve(r)
  }
  return await Promise.resolve(value)
}
