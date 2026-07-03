/**
 * Unit tests for the Claude Desktop third-party (Cowork 3P) config writer.
 *
 * Each test runs against a throwaway `home` dir, so the real
 * `~/Library/Application Support/Claude-3p` is never touched. Mirrors the
 * behaviour validated live on 2026-06-22 (the app boots into 3P, discovers
 * gateway models, no Anthropic sign-in).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  applyConfigLibraryProfile,
  CLAUDE_3P_PREF_DOMAIN,
  gatewayProfile,
  generateManagedProfile,
  getClaude3pDir,
  isConfigLibraryApplied,
  revertConfigLibraryProfile,
} from "~/apps/claude-desktop/config"

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cd-3p-"))
})

afterEach(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

function readJson(file: string): Record<string, unknown> {
  // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
}

function libDir(): string {
  return path.join(getClaude3pDir(home), "configLibrary")
}

function topConfig(): Record<string, unknown> {
  return readJson(path.join(getClaude3pDir(home), "claude_desktop_config.json"))
}

describe("getClaude3pDir — Windows (platform injected)", () => {
  let savedLocalAppData: string | undefined

  beforeEach(() => {
    savedLocalAppData = process.env.LOCALAPPDATA
  })

  afterEach(() => {
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = savedLocalAppData
  })

  it("targets %LOCALAPPDATA%/Claude-3p (the -3p suffix, in Local — not Roaming)", () => {
    process.env.LOCALAPPDATA = path.join(home, "AppData", "Local")
    const dir = getClaude3pDir(home, "win32")
    // Anthropic's docs locate the 3P configLibrary under Local AppData, not
    // Roaming. This diverges from the consumer `claude_desktop_config.json`
    // (which IS under Roaming %APPDATA%\Claude) — on Windows the two halves
    // live on different drives, unlike macOS.
    expect(dir).toBe(path.join(home, "AppData", "Local", "Claude-3p"))
    expect(path.basename(dir)).toBe("Claude-3p")
    // configLibrary is the subdir the applied inference profile lands in.
    const lib = path.join(dir, "configLibrary")
    expect(lib).toBe(
      path.join(home, "AppData", "Local", "Claude-3p", "configLibrary"),
    )
  })

  it("falls back to ~/AppData/Local/Claude-3p when %LOCALAPPDATA% is unset", () => {
    delete process.env.LOCALAPPDATA
    const dir = getClaude3pDir(home, "win32")
    expect(dir).toBe(path.join(home, "AppData", "Local", "Claude-3p"))
  })

  it("still resolves the macOS path when platform is darwin", () => {
    const dir = getClaude3pDir(home, "darwin")
    expect(dir).toBe(
      path.join(home, "Library", "Application Support", "Claude-3p"),
    )
  })
})

describe("gatewayProfile", () => {
  it("turns telemetry off but leaves update checks and Artifacts preview on", () => {
    const p = gatewayProfile(home)
    expect(p.disableEssentialTelemetry).toBe(true)
    expect(p.disableNonessentialTelemetry).toBe(true)
    // disableNonessentialServices governs the Artifacts preview iframe/favicon
    // fetch, not telemetry — must stay false or Artifacts previews break.
    expect(p.disableNonessentialServices).toBe(false)
    expect(p.disableAutoUpdates).toBe(false)
  })

  it("wires the gateway and hides the Claude.ai sign-in", () => {
    const p = gatewayProfile(home, "http://127.0.0.1:9999")
    expect(p.inferenceProvider).toBe("gateway")
    expect(p.inferenceGatewayBaseUrl).toBe("http://127.0.0.1:9999")
    expect(p.disableDeploymentModeChooser).toBe(true)
    expect(p.allowedWorkspaceFolders).toEqual([path.join(home, "Claude")])
  })

  it("enables MCP and desktop extensions", () => {
    const p = gatewayProfile(home)
    expect(p.isLocalDevMcpEnabled).toBe(true)
    expect(p.isDesktopExtensionEnabled).toBe(true)
    expect(p.isDesktopExtensionDirectoryEnabled).toBe(true)
    expect(p.isDesktopExtensionSignatureRequired).toBe(false)
    expect(p.isClaudeCodeForDesktopEnabled).toBe(true)
  })
})

describe("applyConfigLibraryProfile", () => {
  it("writes the profile, registers it in _meta, and sets deploymentMode", () => {
    const result = applyConfigLibraryProfile(home)
    expect(result.wrote).toBe(true)

    const meta = readJson(path.join(libDir(), "_meta.json"))
    expect(meta.appliedId).toBe(result.profileId)
    expect(meta.entries).toEqual([{ id: result.profileId, name: "Default" }])

    const profile = readJson(path.join(libDir(), `${result.profileId}.json`))
    expect(profile.inferenceProvider).toBe("gateway")

    expect(topConfig().deploymentMode).toBe("3p")
    expect(
      (topConfig().preferences as Record<string, unknown>)
        .coworkWebSearchEnabled,
    ).toBe(true)
  })

  it("ensures the workspace folder exists on disk", () => {
    const result = applyConfigLibraryProfile(home)
    expect(result.ensuredWorkspaceFolders).toContain(path.join(home, "Claude"))
    expect(fs.existsSync(path.join(home, "Claude"))).toBe(true)
  })

  it("is idempotent — second apply does not rewrite and reuses the id", () => {
    const first = applyConfigLibraryProfile(home)
    const second = applyConfigLibraryProfile(home)
    expect(second.wrote).toBe(false)
    expect(second.profileId).toBe(first.profileId)
  })

  it("preserves unrelated top-level preferences and entries", () => {
    const dir = getClaude3pDir(home)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "claude_desktop_config.json"),
      JSON.stringify({
        coworkUserFilesPath: "/keep/me",
        preferences: { theme: "dark" },
      }),
    )
    applyConfigLibraryProfile(home)
    const top = topConfig()
    expect(top.coworkUserFilesPath).toBe("/keep/me")
    expect((top.preferences as Record<string, unknown>).theme).toBe("dark")
  })
})

describe("isConfigLibraryApplied", () => {
  it("is false before apply, true after, false after revert", () => {
    expect(isConfigLibraryApplied(home)).toBe(false)
    applyConfigLibraryProfile(home)
    expect(isConfigLibraryApplied(home)).toBe(true)
    revertConfigLibraryProfile(home)
    expect(isConfigLibraryApplied(home)).toBe(false)
  })

  it("is false when a foreign profile is applied (drift)", () => {
    applyConfigLibraryProfile(home)
    const meta = readJson(path.join(libDir(), "_meta.json"))
    const profilePath = path.join(libDir(), `${meta.appliedId as string}.json`)
    const profile = readJson(profilePath)
    profile.inferenceGatewayBaseUrl = "http://example.com:1234"
    fs.writeFileSync(profilePath, JSON.stringify(profile))
    expect(isConfigLibraryApplied(home)).toBe(false)
  })
})

describe("revertConfigLibraryProfile", () => {
  it("removes the applied profile and clears deploymentMode", () => {
    const { profileId } = applyConfigLibraryProfile(home)
    const result = revertConfigLibraryProfile(home)
    expect(result.reverted).toBe(true)
    expect(fs.existsSync(path.join(libDir(), `${profileId}.json`))).toBe(false)
    expect(readJson(path.join(libDir(), "_meta.json")).appliedId).toBe("")
    expect(topConfig().deploymentMode).toBeUndefined()
  })

  it("reports reverted=false when nothing was applied", () => {
    const result = revertConfigLibraryProfile(home)
    expect(result.reverted).toBe(false)
  })
})

describe("generateManagedProfile", () => {
  it("emits a managed-preferences profile for the right domain with our keys", () => {
    const mc = generateManagedProfile(home)
    expect(mc.startsWith('<?xml version="1.0"')).toBe(true)
    expect(mc).toContain("com.apple.ManagedClient.preferences")
    expect(mc).toContain(CLAUDE_3P_PREF_DOMAIN)
    expect(mc).toContain("<key>inferenceProvider</key>")
    expect(mc).toContain("<string>gateway</string>")
    expect(mc).toContain("<key>disableEssentialTelemetry</key>")
  })

  it("uses provided UUIDs for idempotent re-installs", () => {
    const mc = generateManagedProfile(home, gatewayProfile(home), {
      profileUUID: "AAAA-PROFILE",
      payloadUUID: "BBBB-PAYLOAD",
    })
    expect(mc).toContain("<string>AAAA-PROFILE</string>")
    expect(mc).toContain("<string>BBBB-PAYLOAD</string>")
  })
})
