/**
 * Regression for #229: the CLI enable/disable path must persist the durable
 * routing-intent flag (`config.apps.claudeCode.enabled`), not just write
 * settings.json. Before the fix, `maximal app claude-code --enable` wrote the
 * base URL but left the flag unset, so boot/shutdown self-heal (which gates on
 * `claudeCodeRoutingIntended()`) never ran for CLI users.
 *
 * These drive `claudeCodeApp.enable()/disable()` directly — that's the exact
 * seam the CLI dispatch (`src/apps/cli.ts` → enableApp/disableApp) invokes, and
 * now the single owner of the flag. Isolation, no mock.module (avoids Bun's
 * forward-persisting hazard — see apps-cli.test.ts):
 *   - CLAUDE_CONFIG_DIR → a temp dir, so applyProxyBaseUrl writes a throwaway
 *     settings.json instead of the developer's real ~/.claude/settings.json.
 *   - config.json lives under COPILOT_API_HOME, already redirected to a temp
 *     dir by the global preload (tests/test-setup.ts); we reset it per test.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { claudeCodeApp } from "~/apps/claude-code"
import { isProxyBaseUrlConfigured } from "~/apps/claude-code/config"
import { claudeCodeRoutingIntended } from "~/apps/claude-code/reconcile"
import { resolveApiKey } from "~/lib/auth/api-key-helper"
import { getConfig, writeConfig } from "~/lib/config/config"

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cli-persist-"))
const SETTINGS = path.join(TMP_DIR, "settings.json")
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  // Route claude-code settings.json writes into the temp dir.
  process.env.CLAUDE_CONFIG_DIR = TMP_DIR
  fs.rmSync(SETTINGS, { force: true })
  // Clean config so the intent flag starts unset for each case.
  writeConfig({})
})

afterAll(() => {
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
  writeConfig({})
})

describe("claude-code CLI enable/disable persists routing intent (#229)", () => {
  test("enable() persists config.apps.claudeCode.enabled = true", async () => {
    expect(claudeCodeRoutingIntended()).toBe(false)

    const result = await claudeCodeApp.enable()

    expect(result.success).toBe(true)
    expect(result.conflict).toBeNull()
    // The durable intent flag is now set — boot/shutdown self-heal will run.
    expect(getConfig().apps?.claudeCode?.enabled).toBe(true)
    expect(claudeCodeRoutingIntended()).toBe(true)
    // settings.json was actually written too.
    expect(isProxyBaseUrlConfigured(SETTINGS)).toBe(true)
  })

  test("disable() persists config.apps.claudeCode.enabled = false", async () => {
    await claudeCodeApp.enable()
    expect(claudeCodeRoutingIntended()).toBe(true)

    await claudeCodeApp.disable()

    expect(getConfig().apps?.claudeCode?.enabled).toBe(false)
    expect(claudeCodeRoutingIntended()).toBe(false)
    expect(isProxyBaseUrlConfigured(SETTINGS)).toBe(false)
  })

  test("enable does not clobber sibling apps config", async () => {
    writeConfig({ apps: { claudeDesktop: { enabled: true } } })

    await claudeCodeApp.enable()

    const apps = getConfig().apps
    expect(apps?.claudeCode?.enabled).toBe(true)
    expect(apps?.claudeDesktop?.enabled).toBe(true)
  })

  test("enable() mints a default endpoint key so the apiKeyHelper resolves", async () => {
    // Fresh config: no key at all — `maximal api claude-code` would otherwise
    // exit key-less and break the client.
    expect(getConfig().auth?.apiKeyEntries ?? []).toHaveLength(0)
    expect(resolveApiKey("claude-code").ok).toBe(false)

    await claudeCodeApp.enable()

    const entries = getConfig().auth?.apiKeyEntries ?? []
    expect(entries).toHaveLength(1)
    expect(entries[0]?.label).toBe("Default")
    expect(entries[0]?.enabled).toBe(true)
    // The helper now resolves the freshly-minted default endpoint key.
    const resolved = resolveApiKey("claude-code")
    expect(resolved).toMatchObject({ ok: true, source: "default" })
  })

  test("enable() does not mint a second key when one already exists", async () => {
    writeConfig({
      auth: {
        apiKeyEntries: [
          {
            id: "x",
            label: "Mine",
            key: "mxl_existing",
            enabled: true,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    })

    await claudeCodeApp.enable()

    const entries = getConfig().auth?.apiKeyEntries ?? []
    expect(entries).toHaveLength(1)
    expect(entries[0]?.key).toBe("mxl_existing")
  })
})
