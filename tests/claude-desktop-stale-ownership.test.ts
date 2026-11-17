/**
 * Recovery from stale Claude Desktop ownership markers.
 *
 * Claude Desktop rewrites its config-library profiles in its own formatting
 * (two-space JSON, no trailing newline), and can write an earlier profile's
 * values back over the applied one. Either broke the byte fingerprint in
 * `maximal-routing.json`, so the marker's own Maximal profile read as a
 * gateway "set up by you or another tool" (`foreign-gateway-profile`) and
 * nothing could recover it. These tests pin the recovery: Maximal artifacts
 * are recognized and reach the explicit transfer, while user edits stay
 * foreign and untouched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  applyConfigLibraryProfile,
  configLibraryConflict,
  gatewayProfile,
  getClaude3pDir,
  isConfigLibraryApplied,
  revertConfigLibraryProfile,
} from "~/apps/claude-desktop/config"
import {
  enableClaudeDesktopRouting,
  reconcileClaudeDesktopOnBoot,
} from "~/apps/claude-desktop/reconcile"
import {
  currentProfileId,
  profileIdForDirectory,
} from "~/apps/profile-identity"
import { getConfig, writeConfig } from "~/lib/config/config"
import { setListeningPort } from "~/lib/start/proxy-port"

let home: string

const CURRENT_KEY = "mxl_current_key"
const OVERRIDE = { overrideOtherMaximal: true }

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cd-stale-owner-"))
  setListeningPort(5151)
  writeConfig({
    auth: {
      apiKeyEntries: [
        {
          id: "k1",
          label: "claude-desktop",
          key: CURRENT_KEY,
          enabled: true,
          created_at: "2026-11-17T00:00:00.000Z",
        },
      ],
    },
  })
})

afterEach(() => {
  writeConfig({})
  setListeningPort(undefined)
  fs.rmSync(home, { recursive: true, force: true })
})

function libDir(): string {
  return path.join(getClaude3pDir(home), "configLibrary")
}

function statePath(): string {
  return path.join(getClaude3pDir(home), "maximal-routing.json")
}

function profilePath(id: string): string {
  return path.join(libDir(), `${id}.json`)
}

function readJson(file: string): Record<string, unknown> {
  // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse expects text in TypeScript
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
}

/** How Maximal writes: two-space JSON with a trailing newline. */
function maximalWrite(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** How Claude Desktop rewrites a library profile: no trailing newline. */
function desktopWrite(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

function desktopReformat(file: string): void {
  desktopWrite(file, readJson(file))
}

/** The profile another Maximal copy (port, key) wrote. */
function copyProfile(port: number, key: string): Record<string, unknown> {
  return {
    ...gatewayProfile(home, `http://127.0.0.1:${port}`),
    inferenceGatewayApiKey: key,
  }
}

function snapshotTree(): Record<string, string> {
  const root = getClaude3pDir(home)
  const snapshot: Record<string, string> = {}
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else
        snapshot[path.relative(root, fullPath)] = fs.readFileSync(
          fullPath,
          "utf8",
        )
    }
  }
  walk(root)
  return snapshot
}

/**
 * The state found on the reporting machine: an older (pre-ownership) Maximal
 * copy on port 6002 applied entry "stale" and left a version-1 marker with no
 * owner. An earlier copy on port 6001 had left entry "earlier". Claude
 * Desktop then wrote the earlier entry's values back over "stale" in its own
 * formatting, so the marker's fingerprint no longer matched anything.
 */
function seedDesktopWriteBack(): void {
  fs.mkdirSync(libDir(), { recursive: true })
  const earlier = copyProfile(6001, "mxl_earlier_copy")
  desktopWrite(profilePath("earlier"), earlier)
  maximalWrite(profilePath("stale"), copyProfile(6002, "mxl_stale_copy"))
  const fingerprint = createHash("sha256")
    .update(fs.readFileSync(profilePath("stale")))
    .digest("hex")
  maximalWrite(path.join(libDir(), "_meta.json"), {
    appliedId: "stale",
    entries: [
      { id: "earlier", name: "maximal" },
      { id: "stale", name: "maximal" },
    ],
  })
  maximalWrite(path.join(getClaude3pDir(home), "claude_desktop_config.json"), {
    deploymentMode: "3p",
    preferences: { coworkWebSearchEnabled: true },
  })
  maximalWrite(statePath(), {
    profileId: "stale",
    fingerprint,
    prior: { appliedId: "", hadPreferences: true },
  })
  desktopWrite(profilePath("stale"), earlier)
}

function setMarkerOwner(directory: string): void {
  const state = readJson(statePath())
  state.version = 2
  state.ownerProfileId = profileIdForDirectory(directory)
  maximalWrite(statePath(), state)
}

describe("Desktop wrote an earlier Maximal profile back over the marker's", () => {
  test("reports another Maximal copy, not a gateway set up by the user", () => {
    seedDesktopWriteBack()

    expect(configLibraryConflict(home)).toBe("other-maximal-config")
    expect(isConfigLibraryApplied(home)).toBe(false)
  })

  test("normal apply, revert and boot leave it untouched", () => {
    seedDesktopWriteBack()
    const before = snapshotTree()

    expect(applyConfigLibraryProfile(home)).toMatchObject({
      wrote: false,
      conflict: "other-maximal-config",
    })
    expect(revertConfigLibraryProfile(home)).toMatchObject({ reverted: false })
    reconcileClaudeDesktopOnBoot(true, home)

    expect(snapshotTree()).toEqual(before)
  })

  test("explicit transfer repairs the profile in place and retries are no-ops", () => {
    seedDesktopWriteBack()
    const earlierBefore = fs.readFileSync(profilePath("earlier"), "utf8")

    const transfer = enableClaudeDesktopRouting(home, OVERRIDE)

    expect(transfer).toMatchObject({
      wrote: true,
      conflict: null,
      profileId: "stale",
    })
    expect(readJson(path.join(libDir(), "_meta.json"))).toEqual({
      appliedId: "stale",
      entries: [
        { id: "earlier", name: "maximal" },
        { id: "stale", name: "maximal" },
      ],
    })
    expect(readJson(profilePath("stale"))).toEqual({ ...gatewayProfile(home) })
    expect(readJson(statePath())).toMatchObject({
      version: 2,
      ownerProfileId: currentProfileId(),
      profileId: "stale",
      prior: { appliedId: "", hadPreferences: true },
    })
    expect(fs.readFileSync(profilePath("earlier"), "utf8")).toBe(earlierBefore)
    expect(getConfig().apps?.claudeDesktop?.enabled).toBe(true)
    expect(isConfigLibraryApplied(home)).toBe(true)
    expect(configLibraryConflict(home)).toBeNull()

    const settled = snapshotTree()
    expect(enableClaudeDesktopRouting(home, OVERRIDE)).toMatchObject({
      wrote: false,
      conflict: null,
      profileId: "stale",
    })
    expect(applyConfigLibraryProfile(home)).toMatchObject({
      wrote: false,
      conflict: null,
    })
    reconcileClaudeDesktopOnBoot(true, home)
    expect(snapshotTree()).toEqual(settled)
  })

  test("after the transfer, revert removes only this copy's profile", () => {
    seedDesktopWriteBack()
    enableClaudeDesktopRouting(home, OVERRIDE)

    expect(revertConfigLibraryProfile(home)).toMatchObject({
      reverted: true,
      kept: [],
    })
    expect(fs.existsSync(profilePath("stale"))).toBe(false)
    expect(fs.existsSync(profilePath("earlier"))).toBe(true)
    expect(fs.existsSync(statePath())).toBe(false)
    expect(readJson(path.join(libDir(), "_meta.json"))).toEqual({
      appliedId: "",
      entries: [{ id: "earlier", name: "maximal" }],
    })
  })

  test("a dead owner's marker is transferable too, and boot does not flap it", () => {
    seedDesktopWriteBack()
    setMarkerOwner(path.join(home, "deleted-worktree-profile"))
    writeConfig({ ...getConfig(), apps: { claudeDesktop: { enabled: true } } })
    const before = snapshotTree()

    expect(configLibraryConflict(home)).toBe("other-maximal-config")
    reconcileClaudeDesktopOnBoot(true, home)
    expect(getConfig().apps?.claudeDesktop?.enabled).toBe(false)
    expect(snapshotTree()).toEqual(before)

    expect(enableClaudeDesktopRouting(home, OVERRIDE)).toMatchObject({
      wrote: true,
      conflict: null,
      profileId: "stale",
    })
    expect(configLibraryConflict(home)).toBeNull()
  })
})

describe("Desktop reformatted a profile without changing it", () => {
  test("this copy's own profile stays applied and is not rewritten", () => {
    const { profileId } = applyConfigLibraryProfile(home)
    desktopReformat(profilePath(profileId))
    const before = snapshotTree()

    expect(isConfigLibraryApplied(home)).toBe(true)
    expect(configLibraryConflict(home)).toBeNull()
    expect(applyConfigLibraryProfile(home)).toMatchObject({
      wrote: false,
      conflict: null,
      profileId,
    })
    expect(snapshotTree()).toEqual(before)

    expect(revertConfigLibraryProfile(home)).toMatchObject({
      reverted: true,
      kept: [],
    })
    expect(fs.existsSync(profilePath(profileId))).toBe(false)
  })

  test("a reordered rewrite still matches the marker", () => {
    const { profileId } = applyConfigLibraryProfile(home)
    const profile = readJson(profilePath(profileId))
    desktopWrite(
      profilePath(profileId),
      Object.fromEntries(Object.entries(profile).reverse()),
    )

    expect(isConfigLibraryApplied(home)).toBe(true)
    expect(applyConfigLibraryProfile(home).wrote).toBe(false)
  })

  test("a live other profile's marker still needs the explicit transfer", () => {
    const { profileId } = applyConfigLibraryProfile(home)
    setMarkerOwner(path.join(home, "other-maximal"))
    desktopReformat(profilePath(profileId))
    const before = snapshotTree()

    expect(configLibraryConflict(home)).toBe("other-maximal-config")
    expect(applyConfigLibraryProfile(home)).toMatchObject({
      wrote: false,
      conflict: "other-maximal-config",
    })
    expect(revertConfigLibraryProfile(home)).toMatchObject({ reverted: false })
    expect(snapshotTree()).toEqual(before)

    expect(
      applyConfigLibraryProfile(home, gatewayProfile(home), OVERRIDE),
    ).toMatchObject({ wrote: true, conflict: null, profileId })
    expect(isConfigLibraryApplied(home)).toBe(true)
  })
})

describe("user edits to the marker's profile stay protected", () => {
  const edits: Array<[string, (profile: Record<string, unknown>) => void]> = [
    [
      "a gateway and key no Maximal copy wrote",
      (profile) => {
        profile.inferenceGatewayBaseUrl = "http://127.0.0.1:4000"
        profile.inferenceGatewayApiKey = "sk-my-own-gateway"
      },
    ],
    [
      "another workspace folder",
      (profile) => {
        profile.allowedWorkspaceFolders = ["/Users/me/work"]
      },
    ],
    [
      "an extra setting",
      (profile) => {
        profile.disableAutoUpdates = true
        profile.customHeader = "x"
      },
    ],
    [
      "a remote gateway",
      (profile) => {
        profile.inferenceGatewayBaseUrl = "https://llm.corp.example"
      },
    ],
  ]

  for (const [name, edit] of edits) {
    test(`${name} is refused, even with the transfer`, () => {
      seedDesktopWriteBack()
      const profile = readJson(profilePath("stale"))
      edit(profile)
      desktopWrite(profilePath("stale"), profile)
      const before = snapshotTree()

      expect(configLibraryConflict(home)).toBe("foreign-gateway-profile")
      expect(
        applyConfigLibraryProfile(home, gatewayProfile(home), OVERRIDE),
      ).toMatchObject({ wrote: false, conflict: "foreign-gateway-profile" })
      expect(revertConfigLibraryProfile(home)).toMatchObject({
        reverted: false,
      })
      expect(snapshotTree()).toEqual(before)
    })
  }

  test("a renamed entry is the user's", () => {
    seedDesktopWriteBack()
    const metaPath = path.join(libDir(), "_meta.json")
    const meta = readJson(metaPath)
    meta.entries = [
      { id: "earlier", name: "maximal" },
      { id: "stale", name: "My gateway" },
    ]
    maximalWrite(metaPath, meta)
    const before = snapshotTree()

    expect(configLibraryConflict(home)).toBe("foreign-gateway-profile")
    expect(
      applyConfigLibraryProfile(home, gatewayProfile(home), OVERRIDE),
    ).toMatchObject({ wrote: false, conflict: "foreign-gateway-profile" })
    expect(snapshotTree()).toEqual(before)
  })

  test("a user edit to this copy's own profile is kept on revert", () => {
    const { profileId } = applyConfigLibraryProfile(home)
    const profile = readJson(profilePath(profileId))
    profile.inferenceGatewayApiKey = "sk-my-own-gateway"
    desktopWrite(profilePath(profileId), profile)

    expect(configLibraryConflict(home)).toBe("foreign-gateway-profile")
    expect(revertConfigLibraryProfile(home).kept).toEqual([
      profilePath(profileId),
    ])
    expect(readJson(profilePath(profileId))).toEqual(profile)
  })
})
