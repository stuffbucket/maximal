/**
 * Tests for the `configure-claude-code` subcommand — the shared reverter
 * the Tauri shell calls after a sidecar crash.
 *
 * `runConfigureClaudeCode` writes to the real settings path, which honors
 * `CLAUDE_CONFIG_DIR`. We point that at a tmp dir to exercise the actual
 * apply/revert behavior without `mock.module`, then assert through the real
 * reader.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  configureClaudeCode,
  runConfigureClaudeCode,
} from "~/configure-claude-code"
import {
  isProxyBaseUrlConfigured,
  PROXY_BASE_URL,
  readClaudeCodeSettings,
} from "~/lib/claude-code-settings"

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cc-configure-"))
const SETTINGS = path.join(TMP_DIR, "settings.json")
const PRIOR_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP_DIR
  fs.rmSync(SETTINGS, { force: true })
})

afterEach(() => {
  if (PRIOR_CONFIG_DIR === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = PRIOR_CONFIG_DIR
  }
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
    runConfigureClaudeCode({ revert: false })
    expect(isProxyBaseUrlConfigured(SETTINGS)).toBe(true)
  })

  test("revert removes the proxy base URL we wrote", () => {
    runConfigureClaudeCode({ revert: false })
    expect(isProxyBaseUrlConfigured(SETTINGS)).toBe(true)
    runConfigureClaudeCode({ revert: true })
    expect(isProxyBaseUrlConfigured(SETTINGS)).toBe(false)
  })

  test("revert leaves a foreign base URL intact", () => {
    fs.writeFileSync(
      SETTINGS,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.example" } }),
    )
    runConfigureClaudeCode({ revert: true })
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
    runConfigureClaudeCode({ revert: false })
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
