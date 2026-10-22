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

/** Seed Desktop's library as if the user (or another tool) had applied
 *  their own profile `id`, with the given top-level config. */
function seedUserProfile(
  id: string,
  profile: Record<string, unknown>,
  top: Record<string, unknown> = { deploymentMode: "3p" },
): void {
  fs.mkdirSync(libDir(), { recursive: true })
  fs.writeFileSync(path.join(libDir(), `${id}.json`), JSON.stringify(profile))
  fs.writeFileSync(
    path.join(libDir(), "_meta.json"),
    JSON.stringify({ appliedId: id, entries: [{ id, name: "Work" }] }),
  )
  fs.writeFileSync(
    path.join(getClaude3pDir(home), "claude_desktop_config.json"),
    JSON.stringify(top),
  )
}

/** Every file under the 3P dir, path → contents, to prove a no-op. */
function snapshotTree(): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out[full] = fs.readFileSync(full, "utf8")
    }
  }
  walk(getClaude3pDir(home))
  return out
}

const CORP_GATEWAY = {
  inferenceProvider: "gateway",
  inferenceGatewayBaseUrl: "https://llm.corp.example",
  inferenceGatewayApiKey: "corp-key",
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
    // The entry name is how we recognise our own profile later.
    expect(meta.entries).toEqual([{ id: result.profileId, name: "maximal" }])

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

describe("applyConfigLibraryProfile — someone else's profile is applied", () => {
  it("refuses to replace a foreign gateway profile and changes nothing", () => {
    seedUserProfile("corp", CORP_GATEWAY)
    const before = snapshotTree()

    const result = applyConfigLibraryProfile(home)

    expect(result.wrote).toBe(false)
    expect(result.conflict).toBe("foreign-gateway-profile")
    expect(snapshotTree()).toEqual(before)
  })

  it("never overwrites the applied profile's file, even a non-gateway one", () => {
    seedUserProfile("plain", { allowedWorkspaceFolders: ["/work"] }, {})
    const result = applyConfigLibraryProfile(home)

    expect(result.wrote).toBe(true)
    expect(result.profileId).not.toBe("plain")
    expect(readJson(path.join(libDir(), "plain.json"))).toEqual({
      allowedWorkspaceFolders: ["/work"],
    })
    const meta = readJson(path.join(libDir(), "_meta.json"))
    expect(meta.entries).toEqual([
      { id: "plain", name: "Work" },
      { id: result.profileId, name: "maximal" },
    ])
  })
})

/** Seed the state an older maximal left: entry "Default", placeholder key. */
function seedLegacy(): void {
  seedUserProfile("legacy", {
    ...gatewayProfile(home),
    inferenceGatewayApiKey: "anything",
  })
  fs.writeFileSync(
    path.join(libDir(), "_meta.json"),
    JSON.stringify({
      appliedId: "legacy",
      entries: [{ id: "legacy", name: "Default" }],
    }),
  )
}

describe("applyConfigLibraryProfile — profile from an older maximal", () => {
  it("adopts it in place and can still clean it up after the profile changes", () => {
    seedLegacy()
    const result = applyConfigLibraryProfile(home, {
      ...gatewayProfile(home),
      inferenceGatewayApiKey: "mxl_newer_key",
    })

    expect(result.conflict).toBeNull()
    expect(result.profileId).toBe("legacy")
    expect(readJson(path.join(libDir(), "_meta.json")).entries).toEqual([
      { id: "legacy", name: "maximal" },
    ])

    revertConfigLibraryProfile(home)
    expect(fs.existsSync(path.join(libDir(), "legacy.json"))).toBe(false)
    expect(readJson(path.join(libDir(), "_meta.json")).appliedId).toBe("")
  })

  it("treats a user's own 'Default' gateway as foreign", () => {
    seedUserProfile("mine", CORP_GATEWAY)
    fs.writeFileSync(
      path.join(libDir(), "_meta.json"),
      JSON.stringify({
        appliedId: "mine",
        entries: [{ id: "mine", name: "Default" }],
      }),
    )
    expect(applyConfigLibraryProfile(home).conflict).toBe(
      "foreign-gateway-profile",
    )
  })
})

describe("ownership is never inferred loosely", () => {
  it("doesn't overwrite a user's own profile that happens to be named maximal", () => {
    seedUserProfile("mine", CORP_GATEWAY)
    fs.writeFileSync(
      path.join(libDir(), "_meta.json"),
      JSON.stringify({
        appliedId: "mine",
        entries: [{ id: "mine", name: "maximal" }],
      }),
    )
    const before = snapshotTree()

    expect(applyConfigLibraryProfile(home).conflict).toBe(
      "foreign-gateway-profile",
    )
    revertConfigLibraryProfile(home)
    expect(snapshotTree()).toEqual(before)
  })

  it("never overwrites a profile it kept because the user edited it", () => {
    const { profileId } = applyConfigLibraryProfile(home)
    const ours = path.join(libDir(), `${profileId}.json`)
    const edited = { ...readJson(ours), allowedWorkspaceFolders: ["/mine"] }
    fs.writeFileSync(ours, JSON.stringify(edited))
    revertConfigLibraryProfile(home)

    const again = applyConfigLibraryProfile(home)

    expect(again.profileId).not.toBe(profileId)
    expect(readJson(ours)).toEqual(edited)
  })

  it("treats a localhost 'Default' gateway on another port as the user's", () => {
    seedUserProfile("litellm", {
      ...gatewayProfile(home, "http://127.0.0.1:4000"),
      inferenceGatewayApiKey: "anything",
    })
    fs.writeFileSync(
      path.join(libDir(), "_meta.json"),
      JSON.stringify({
        appliedId: "litellm",
        entries: [{ id: "litellm", name: "Default" }],
      }),
    )
    const before = snapshotTree()

    expect(applyConfigLibraryProfile(home).conflict).toBe(
      "foreign-gateway-profile",
    )
    revertConfigLibraryProfile(home)
    expect(snapshotTree()).toEqual(before)
  })

  it("refuses to write when _meta.json is unreadable, keeping it as is", () => {
    fs.mkdirSync(libDir(), { recursive: true })
    const metaPath = path.join(libDir(), "_meta.json")
    fs.writeFileSync(metaPath, "{ not json")

    expect(() => applyConfigLibraryProfile(home)).toThrow(/_meta\.json/)
    expect(fs.readFileSync(metaPath, "utf8")).toBe("{ not json")
  })

  it("refuses to switch away from an applied profile it can't read", () => {
    seedUserProfile("broken", {})
    fs.writeFileSync(path.join(libDir(), "broken.json"), "{ not json")
    expect(applyConfigLibraryProfile(home).conflict).toBe(
      "foreign-gateway-profile",
    )
  })

  it("keeps _meta.json fields it doesn't know about", () => {
    fs.mkdirSync(libDir(), { recursive: true })
    fs.writeFileSync(
      path.join(libDir(), "_meta.json"),
      JSON.stringify({ appliedId: "", entries: [], futureField: 7 }),
    )
    applyConfigLibraryProfile(home)
    expect(readJson(path.join(libDir(), "_meta.json")).futureField).toBe(7)
  })

  it("survives a malformed state file without half-reverting", () => {
    applyConfigLibraryProfile(home)
    fs.writeFileSync(
      path.join(getClaude3pDir(home), "maximal-routing.json"),
      "{}",
    )
    expect(() => revertConfigLibraryProfile(home)).not.toThrow()
    expect(readJson(path.join(libDir(), "_meta.json")).appliedId).toBe("")
  })

  it("never touches a path outside the library through an entry id", () => {
    fs.mkdirSync(libDir(), { recursive: true })
    const outside = path.join(getClaude3pDir(home), "outside.json")
    fs.writeFileSync(
      outside,
      JSON.stringify({
        ...gatewayProfile(home),
        inferenceGatewayApiKey: "anything",
      }),
    )
    fs.writeFileSync(
      path.join(libDir(), "_meta.json"),
      JSON.stringify({
        appliedId: "../outside",
        entries: [{ id: "../outside", name: "maximal" }],
      }),
    )

    revertConfigLibraryProfile(home)
    applyConfigLibraryProfile(home)

    expect(fs.existsSync(outside)).toBe(true)
    expect(readJson(outside).inferenceGatewayApiKey).toBe("anything")
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

  it("leaves a foreign gateway profile alone when we never wired Desktop", () => {
    seedUserProfile("corp", CORP_GATEWAY)
    const before = snapshotTree()

    const result = revertConfigLibraryProfile(home)

    expect(result.reverted).toBe(false)
    expect(snapshotTree()).toEqual(before)
  })

  it("restores the user's prior selection and deploymentMode", () => {
    seedUserProfile(
      "plain",
      { allowedWorkspaceFolders: ["/work"] },
      { deploymentMode: "1p", preferences: { coworkWebSearchEnabled: false } },
    )
    const { profileId } = applyConfigLibraryProfile(home)

    revertConfigLibraryProfile(home)

    const meta = readJson(path.join(libDir(), "_meta.json"))
    expect(meta.appliedId).toBe("plain")
    expect(meta.entries).toEqual([{ id: "plain", name: "Work" }])
    expect(fs.existsSync(path.join(libDir(), `${profileId}.json`))).toBe(false)
    expect(readJson(path.join(libDir(), "plain.json"))).toEqual({
      allowedWorkspaceFolders: ["/work"],
    })
    expect(topConfig().deploymentMode).toBe("1p")
    expect(
      (topConfig().preferences as Record<string, unknown>)
        .coworkWebSearchEnabled,
    ).toBe(false)
  })

  it("removes keys it added when they were absent before", () => {
    applyConfigLibraryProfile(home)
    revertConfigLibraryProfile(home)
    const top = topConfig()
    expect("deploymentMode" in top).toBe(false)
    expect(
      "coworkWebSearchEnabled"
        in ((top.preferences as Record<string, unknown> | undefined) ?? {}),
    ).toBe(false)
  })

  it("keeps our profile if the user edited it, but still switches back", () => {
    const { profileId } = applyConfigLibraryProfile(home)
    const ours = path.join(libDir(), `${profileId}.json`)
    fs.writeFileSync(
      ours,
      JSON.stringify({ ...readJson(ours), allowedWorkspaceFolders: ["/mine"] }),
    )

    const result = revertConfigLibraryProfile(home)

    expect(result.reverted).toBe(true)
    expect(result.kept).toEqual([ours])
    expect(fs.existsSync(ours)).toBe(true)
    expect(readJson(path.join(libDir(), "_meta.json")).appliedId).toBe("")
  })

  it("doesn't undo a switch the user made to another profile after enabling", () => {
    const { profileId } = applyConfigLibraryProfile(home)
    const metaPath = path.join(libDir(), "_meta.json")
    const meta = readJson(metaPath) as {
      appliedId: string
      entries: Array<{ id: string; name: string }>
    }
    fs.writeFileSync(
      path.join(libDir(), "corp.json"),
      JSON.stringify(CORP_GATEWAY),
    )
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        appliedId: "corp",
        entries: [...meta.entries, { id: "corp", name: "Work" }],
      }),
    )

    revertConfigLibraryProfile(home)

    const after = readJson(metaPath)
    expect(after.appliedId).toBe("corp")
    expect(after.entries).toEqual([{ id: "corp", name: "Work" }])
    expect(fs.existsSync(path.join(libDir(), `${profileId}.json`))).toBe(false)
    expect(topConfig().deploymentMode).toBe("3p")
  })

  it("cleans up a profile written by an older maximal (entry named Default)", () => {
    seedUserProfile("legacy", {
      ...gatewayProfile(home),
      inferenceGatewayApiKey: "anything",
    })
    const metaPath = path.join(libDir(), "_meta.json")
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        appliedId: "legacy",
        entries: [{ id: "legacy", name: "Default" }],
      }),
    )

    const result = revertConfigLibraryProfile(home)

    expect(result.reverted).toBe(true)
    expect(fs.existsSync(path.join(libDir(), "legacy.json"))).toBe(false)
    expect(readJson(metaPath)).toEqual({ appliedId: "", entries: [] })
    expect("deploymentMode" in topConfig()).toBe(false)
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
