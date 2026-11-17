/**
 * Explicit Take over from a Claude Desktop gateway Maximal didn't set up.
 *
 * `overrideForeignGateway` lifts only the "someone else's gateway is
 * applied" block: Maximal applies its own entry and snapshots the other
 * selection, never writing the other profile, so disabling switches back
 * exactly. Unreadable or unsafe files, malformed markers and another
 * Maximal profile's ownership are still refused.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  applyConfigLibraryProfile,
  configLibraryConflict,
  gatewayProfile,
  getClaude3pDir,
  isConfigLibraryApplied,
} from "~/apps/claude-desktop/config"
import {
  disableClaudeDesktopRouting,
  enableClaudeDesktopRouting,
  reconcileClaudeDesktopOnBoot,
} from "~/apps/claude-desktop/reconcile"
import { profileIdForDirectory } from "~/apps/profile-identity"
import { getConfig, writeConfig } from "~/lib/config/config"
import { setListeningPort } from "~/lib/start/proxy-port"

let home: string

const TAKE_OVER = { overrideForeignGateway: true }
const CORP_GATEWAY = {
  inferenceProvider: "gateway",
  inferenceGatewayBaseUrl: "https://llm.corp.example",
  inferenceGatewayApiKey: "corp-key",
  allowedWorkspaceFolders: ["/work"],
}
const ORIGINAL_TOP = {
  deploymentMode: "3p",
  preferences: { coworkWebSearchEnabled: false, theme: "dark" },
  unrelated: { keep: true },
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cd-take-over-"))
  setListeningPort(5151)
  writeConfig({
    auth: {
      apiKeyEntries: [
        {
          id: "k1",
          label: "claude-desktop",
          key: "mxl_current_key",
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

function metaPath(): string {
  return path.join(libDir(), "_meta.json")
}

function topPath(): string {
  return path.join(getClaude3pDir(home), "claude_desktop_config.json")
}

function statePath(): string {
  return path.join(getClaude3pDir(home), "maximal-routing.json")
}

function readJson(file: string): Record<string, unknown> {
  // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse expects text in TypeScript
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
}

function seedCorp(): void {
  fs.mkdirSync(libDir(), { recursive: true })
  fs.writeFileSync(
    path.join(libDir(), "corp.json"),
    JSON.stringify(CORP_GATEWAY),
  )
  fs.writeFileSync(
    metaPath(),
    JSON.stringify({
      appliedId: "corp",
      entries: [{ id: "corp", name: "Work" }],
    }),
  )
  fs.writeFileSync(topPath(), JSON.stringify(ORIGINAL_TOP))
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

describe("Take over from another gateway", () => {
  test("switches to Maximal without writing the other profile, and disable restores exactly", () => {
    seedCorp()
    const corpBytes = fs.readFileSync(path.join(libDir(), "corp.json"), "utf8")

    expect(configLibraryConflict(home)).toBe("foreign-gateway-profile")
    expect(configLibraryConflict(home, undefined, TAKE_OVER)).toBeNull()

    const result = enableClaudeDesktopRouting(home, TAKE_OVER)

    expect(result).toMatchObject({ wrote: true, conflict: null })
    expect(result.profileId).not.toBe("corp")
    expect(fs.readFileSync(path.join(libDir(), "corp.json"), "utf8")).toBe(
      corpBytes,
    )
    expect(readJson(metaPath())).toEqual({
      appliedId: result.profileId,
      entries: [
        { id: "corp", name: "Work" },
        { id: result.profileId, name: "maximal" },
      ],
    })
    expect(readJson(topPath())).toEqual({
      ...ORIGINAL_TOP,
      preferences: { coworkWebSearchEnabled: true, theme: "dark" },
    })
    expect(readJson(statePath()).prior).toEqual({
      appliedId: "corp",
      deploymentMode: "3p",
      coworkWebSearchEnabled: false,
      hadPreferences: true,
    })
    expect(isConfigLibraryApplied(home)).toBe(true)
    expect(getConfig().apps?.claudeDesktop?.enabled).toBe(true)

    disableClaudeDesktopRouting(home)

    expect(readJson(metaPath())).toEqual({
      appliedId: "corp",
      entries: [{ id: "corp", name: "Work" }],
    })
    expect(readJson(topPath())).toEqual(ORIGINAL_TOP)
    expect(fs.readFileSync(path.join(libDir(), "corp.json"), "utf8")).toBe(
      corpBytes,
    )
    expect(fs.existsSync(statePath())).toBe(false)
    expect(getConfig().apps?.claudeDesktop?.enabled).toBe(false)
  })

  test("retrying, re-applying and boot after a Take over change nothing", () => {
    seedCorp()
    const { profileId } = enableClaudeDesktopRouting(home, TAKE_OVER)
    const settled = snapshotTree()

    expect(enableClaudeDesktopRouting(home, TAKE_OVER)).toMatchObject({
      wrote: false,
      conflict: null,
      profileId,
    })
    expect(applyConfigLibraryProfile(home)).toMatchObject({
      wrote: false,
      conflict: null,
    })
    reconcileClaudeDesktopOnBoot(true, home)
    expect(snapshotTree()).toEqual(settled)
  })

  test("never becomes a standing policy: boot leaves a later switch back alone", () => {
    seedCorp()
    enableClaudeDesktopRouting(home, TAKE_OVER)
    const meta = readJson(metaPath())
    fs.writeFileSync(metaPath(), JSON.stringify({ ...meta, appliedId: "corp" }))
    const before = snapshotTree()

    reconcileClaudeDesktopOnBoot(true, home)

    expect(snapshotTree()).toEqual(before)
    expect(configLibraryConflict(home)).toBe("foreign-gateway-profile")
  })

  test("keeps an edited Maximal profile intact and switches back to it", () => {
    const { profileId: edited } = applyConfigLibraryProfile(home)
    const editedPath = path.join(libDir(), `${edited}.json`)
    const profile = { ...readJson(editedPath), inferenceGatewayApiKey: "mine" }
    fs.writeFileSync(editedPath, JSON.stringify(profile, null, 2))
    expect(configLibraryConflict(home)).toBe("foreign-gateway-profile")

    const result = applyConfigLibraryProfile(
      home,
      gatewayProfile(home),
      TAKE_OVER,
    )

    expect(result).toMatchObject({ wrote: true, conflict: null })
    expect(result.profileId).not.toBe(edited)
    expect(readJson(editedPath)).toEqual(profile)
    expect(readJson(statePath()).prior).toMatchObject({ appliedId: edited })

    disableClaudeDesktopRouting(home)

    expect(readJson(metaPath()).appliedId).toBe(edited)
    expect(readJson(editedPath)).toEqual(profile)
  })
})

describe("Take over does not bypass validation or other profiles", () => {
  test("an applied profile Maximal can't read", () => {
    seedCorp()
    fs.writeFileSync(path.join(libDir(), "corp.json"), "{ not json")
    const before = snapshotTree()

    expect(
      applyConfigLibraryProfile(home, gatewayProfile(home), TAKE_OVER),
    ).toMatchObject({ wrote: false, conflict: "foreign-gateway-profile" })
    expect(snapshotTree()).toEqual(before)
  })

  test("an applied profile id Maximal can't safely address", () => {
    seedCorp()
    fs.writeFileSync(
      metaPath(),
      JSON.stringify({
        appliedId: "../corp",
        entries: [{ id: "../corp", name: "Work" }],
      }),
    )
    const before = snapshotTree()

    expect(
      applyConfigLibraryProfile(home, gatewayProfile(home), TAKE_OVER),
    ).toMatchObject({ wrote: false, conflict: "foreign-gateway-profile" })
    expect(snapshotTree()).toEqual(before)
  })

  test("an unreadable library index", () => {
    seedCorp()
    fs.writeFileSync(metaPath(), "{ not json")

    expect(() =>
      applyConfigLibraryProfile(home, gatewayProfile(home), TAKE_OVER),
    ).toThrow(/_meta\.json/)
    expect(fs.readFileSync(metaPath(), "utf8")).toBe("{ not json")
  })

  test("a malformed ownership marker", () => {
    seedCorp()
    fs.writeFileSync(statePath(), JSON.stringify({ version: 2 }))
    const before = snapshotTree()

    expect(
      applyConfigLibraryProfile(home, gatewayProfile(home), TAKE_OVER),
    ).toMatchObject({ wrote: false, conflict: "cleanup-required" })
    expect(snapshotTree()).toEqual(before)
  })

  test("another Maximal profile's routing needs its own transfer", () => {
    applyConfigLibraryProfile(home)
    const state = readJson(statePath())
    state.ownerProfileId = profileIdForDirectory(path.join(home, "other"))
    fs.writeFileSync(statePath(), JSON.stringify(state))
    const before = snapshotTree()

    expect(
      applyConfigLibraryProfile(home, gatewayProfile(home), TAKE_OVER),
    ).toMatchObject({ wrote: false, conflict: "other-maximal-config" })
    expect(snapshotTree()).toEqual(before)
  })

  test("another profile's marker whose profile was edited needs cleanup", () => {
    const { profileId } = applyConfigLibraryProfile(home)
    const state = readJson(statePath())
    state.ownerProfileId = profileIdForDirectory(path.join(home, "other"))
    fs.writeFileSync(statePath(), JSON.stringify(state))
    const profilePath = path.join(libDir(), `${profileId}.json`)
    fs.writeFileSync(
      profilePath,
      JSON.stringify({ ...readJson(profilePath), allowedWorkspaceFolders: [] }),
    )
    const before = snapshotTree()

    expect(
      applyConfigLibraryProfile(home, gatewayProfile(home), TAKE_OVER),
    ).toMatchObject({ wrote: false, conflict: "cleanup-required" })
    expect(snapshotTree()).toEqual(before)
  })
})
