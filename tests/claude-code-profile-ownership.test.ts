import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  applyProxyBaseUrl,
  getBaseUrlOwnership,
  inspectClaudeCodeRouting,
  inspectClaudeCodeRoutingFile,
  isProxyBaseUrlConfigured,
  readClaudeCodeSettings,
  revertProxyBaseUrl,
  revertProxyBaseUrlForShutdown,
} from "~/apps/claude-code/config"
import {
  currentProfileId,
  profileIdForDirectory,
} from "~/apps/profile-identity"
import { setListeningPort } from "~/lib/start/proxy-port"

const TEST_KEY = "custom-user-key"
const TEST_HELPER = "echo 'custom-user-key'"
const TEST_MARKER = {
  label: "claude-code",
  strategy: "echo",
  fingerprint:
    "16ba58604080f664b043e3c4858ff452390db3db7d109225b13d482337657782",
  profileId: currentProfileId(),
}
const resolveTestKey = () =>
  ({ ok: true, key: TEST_KEY, source: "app" }) as const
const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

let configDir: string
let settingsPath: string

beforeEach(() => {
  configDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "maximal-claude-code-profile-"),
  )
  settingsPath = path.join(configDir, "settings.json")
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(() => {
  setListeningPort(undefined)
  if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir
  fs.rmSync(configDir, { recursive: true, force: true })
})

function read(): Record<string, unknown> {
  return readClaudeCodeSettings()
}

function apply(options: { overrideOtherMaximal?: boolean } = {}) {
  return applyProxyBaseUrl(undefined, resolveTestKey, options)
}

function envOf(settings: Record<string, unknown>): Record<string, unknown> {
  return settings.env as Record<string, unknown>
}

function moveRoutingToOtherProfile(port: number): void {
  const otherProfileId = profileIdForDirectory(
    path.join(configDir, "other-profile"),
  )
  const settings = read()
  const helperMarker = settings._maximalHelper as Record<string, unknown>
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      ...settings,
      _maximalHelper: {
        ...helperMarker,
        profileId: otherProfileId,
      },
      _maximalProfile: { version: 1, profileId: otherProfileId },
      env: {
        ...envOf(settings),
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      },
    }),
  )
}

describe("Claude Code Maximal profile ownership", () => {
  test("classifies the current profile and endpoint as enabled", () => {
    setListeningPort(5151)
    apply()

    expect(inspectClaudeCodeRouting(read())).toEqual({
      enabled: true,
      conflict: null,
    })
    expect((read()._maximalProfile as Record<string, unknown>).profileId).toBe(
      currentProfileId(),
    )
    expect(isProxyBaseUrlConfigured()).toBe(true)
  })

  test("reports another valid profile without writing", () => {
    setListeningPort(5151)
    apply()
    moveRoutingToOtherProfile(5252)
    const before = fs.readFileSync(settingsPath, "utf8")

    expect(inspectClaudeCodeRouting(read())).toEqual({
      enabled: false,
      conflict: "other-maximal-config",
    })
    expect(apply()).toMatchObject({
      wrote: false,
      skippedReason: "other-maximal-config",
    })
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before)
    expect(isProxyBaseUrlConfigured()).toBe(false)
  })

  test("moves another profile only after explicit override", () => {
    setListeningPort(5151)
    apply()
    moveRoutingToOtherProfile(5252)

    expect(apply({ overrideOtherMaximal: true })).toMatchObject({ wrote: true })
    expect(inspectClaudeCodeRouting(read())).toEqual({
      enabled: true,
      conflict: null,
    })
    expect(envOf(read()).ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:5151")
    expect((read()._maximalProfile as Record<string, unknown>).profileId).toBe(
      currentProfileId(),
    )
  })

  test("requires explicit override when another profile's URL is missing", () => {
    setListeningPort(5151)
    apply()
    moveRoutingToOtherProfile(5252)
    const settings = read()
    const env = envOf(settings)
    delete env.ANTHROPIC_BASE_URL
    fs.writeFileSync(settingsPath, JSON.stringify(settings))
    const before = fs.readFileSync(settingsPath, "utf8")

    expect(inspectClaudeCodeRouting(read())).toEqual({
      enabled: false,
      conflict: "other-maximal-config",
    })
    expect(apply()).toMatchObject({
      wrote: false,
      skippedReason: "other-maximal-config",
    })
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before)
    expect(apply({ overrideOtherMaximal: true })).toMatchObject({ wrote: true })
  })

  test("never overrides an incomplete prior snapshot", () => {
    setListeningPort(5151)
    apply()
    moveRoutingToOtherProfile(5252)
    const settings = { ...read(), _maximalPrior: {} }
    fs.writeFileSync(settingsPath, JSON.stringify(settings))
    const before = fs.readFileSync(settingsPath, "utf8")

    expect(inspectClaudeCodeRouting(read())).toEqual({
      enabled: false,
      conflict: "cleanup-required",
    })
    expect(apply({ overrideOtherMaximal: true })).toMatchObject({
      wrote: false,
      skippedReason: "cleanup-required",
    })
    expect(revertProxyBaseUrl()).toMatchObject({ wrote: false })
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before)
  })

  test("reports malformed settings without replacing them", () => {
    const original = "{ not valid json"
    fs.writeFileSync(settingsPath, original)

    expect(inspectClaudeCodeRoutingFile()).toEqual({
      enabled: false,
      conflict: "cleanup-required",
    })
    expect(isProxyBaseUrlConfigured()).toBe(false)
    expect(apply({ overrideOtherMaximal: true })).toMatchObject({
      wrote: false,
      skippedReason: "cleanup-required",
    })
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original)
  })

  test("override never replaces foreign settings", () => {
    const original = {
      apiKeyHelper: "corp-key-helper",
      env: { ANTHROPIC_BASE_URL: "https://llm.corp.example" },
    }
    fs.writeFileSync(settingsPath, JSON.stringify(original))

    expect(apply({ overrideOtherMaximal: true })).toMatchObject({
      wrote: false,
      skippedReason: "foreign-base-url",
    })
    expect(read()).toEqual(original)
  })

  test("stale shutdown does not remove another profile's config", () => {
    setListeningPort(5151)
    apply()
    moveRoutingToOtherProfile(5252)
    const before = fs.readFileSync(settingsPath, "utf8")

    expect(revertProxyBaseUrlForShutdown()).toMatchObject({ wrote: false })
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before)
    expect(inspectClaudeCodeRouting(read())).toEqual({
      enabled: false,
      conflict: "other-maximal-config",
    })
  })
})

describe("Claude Code endpoint ownership", () => {
  test("writes the port the proxy is listening on", () => {
    setListeningPort(5555)
    apply()
    expect(envOf(read()).ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:5555")
  })

  test("updates its own URL after the port changes", () => {
    setListeningPort(5555)
    apply()
    setListeningPort(6666)

    expect(apply().skippedReason).toBeUndefined()
    expect(envOf(read()).ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:6666")
  })

  test("revert removes a URL written under an earlier port", () => {
    setListeningPort(5555)
    apply()
    setListeningPort(6666)

    revertProxyBaseUrl()
    expect(fs.existsSync(settingsPath)).toBe(false)
  })

  test("a stale loopback URL requires current-profile ownership", () => {
    expect(
      getBaseUrlOwnership({
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8080" },
      }),
    ).toBe("foreign")
    expect(
      getBaseUrlOwnership({
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8080" },
        apiKeyHelper: TEST_HELPER,
        _maximalHelper: TEST_MARKER,
        _maximalProfile: { version: 1, profileId: currentProfileId() },
      }),
    ).toBe("ours")
  })
})
