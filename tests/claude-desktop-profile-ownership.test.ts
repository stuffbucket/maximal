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
import { reconcileClaudeDesktopOnBoot } from "~/apps/claude-desktop/reconcile"
import { profileIdForDirectory } from "~/apps/profile-identity"
import { getConfig, writeConfig } from "~/lib/config/config"
import { setListeningPort } from "~/lib/start/proxy-port"

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-desktop-profile-"))
  setListeningPort(5151)
})

afterEach(() => {
  writeConfig({})
  setListeningPort(undefined)
  fs.rmSync(home, { recursive: true, force: true })
})

function statePath(): string {
  return path.join(getClaude3pDir(home), "maximal-routing.json")
}

function readJsonObject(filePath: string): Record<string, unknown> {
  // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse expects text in TypeScript
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
    string,
    unknown
  >
}

function markAsOtherProfile(): void {
  const state = readJsonObject(statePath())
  state.ownerProfileId = profileIdForDirectory(path.join(home, "other-maximal"))
  fs.writeFileSync(statePath(), JSON.stringify(state))
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

describe("Claude Desktop Maximal profile ownership", () => {
  test("current profile and endpoint are enabled", () => {
    applyConfigLibraryProfile(home)

    expect(isConfigLibraryApplied(home)).toBe(true)
    expect(configLibraryConflict(home)).toBeNull()
  })

  test("another profile is reported and normal apply performs no write", () => {
    applyConfigLibraryProfile(home)
    markAsOtherProfile()
    const before = snapshotTree()

    expect(isConfigLibraryApplied(home)).toBe(false)
    expect(configLibraryConflict(home)).toBe("other-maximal-config")
    expect(applyConfigLibraryProfile(home)).toMatchObject({
      wrote: false,
      conflict: "other-maximal-config",
    })
    expect(snapshotTree()).toEqual(before)
  })

  test("missing profile from another owner fails closed", () => {
    const { profileId } = applyConfigLibraryProfile(home)
    markAsOtherProfile()
    fs.rmSync(
      path.join(getClaude3pDir(home), "configLibrary", `${profileId}.json`),
    )
    const before = snapshotTree()

    expect(configLibraryConflict(home)).toBe("cleanup-required")
    expect(applyConfigLibraryProfile(home)).toMatchObject({
      wrote: false,
      conflict: "cleanup-required",
    })
    expect(
      applyConfigLibraryProfile(home, gatewayProfile(home), {
        overrideOtherMaximal: true,
      }),
    ).toMatchObject({ wrote: false, conflict: "cleanup-required" })
    expect(snapshotTree()).toEqual(before)
  })

  test("explicit override transfers another Maximal profile", () => {
    applyConfigLibraryProfile(home)
    markAsOtherProfile()

    expect(
      applyConfigLibraryProfile(home, gatewayProfile(home), {
        overrideOtherMaximal: true,
      }),
    ).toMatchObject({ wrote: true, conflict: null })
    expect(isConfigLibraryApplied(home)).toBe(true)
    expect(configLibraryConflict(home)).toBeNull()
  })

  test("override does not replace a foreign gateway profile", () => {
    const directory = getClaude3pDir(home)
    const library = path.join(directory, "configLibrary")
    fs.mkdirSync(library, { recursive: true })
    fs.writeFileSync(
      path.join(library, "corp.json"),
      JSON.stringify({
        inferenceProvider: "gateway",
        inferenceGatewayBaseUrl: "https://llm.corp.example",
      }),
    )
    fs.writeFileSync(
      path.join(library, "_meta.json"),
      JSON.stringify({
        appliedId: "corp",
        entries: [{ id: "corp", name: "Work" }],
      }),
    )
    const before = snapshotTree()

    expect(
      applyConfigLibraryProfile(home, gatewayProfile(home), {
        overrideOtherMaximal: true,
      }),
    ).toMatchObject({ wrote: false, conflict: "foreign-gateway-profile" })
    expect(snapshotTree()).toEqual(before)
  })

  test("stale cleanup does not remove another profile's configuration", () => {
    applyConfigLibraryProfile(home)
    markAsOtherProfile()
    const before = snapshotTree()

    expect(revertConfigLibraryProfile(home)).toMatchObject({ reverted: false })
    expect(snapshotTree()).toEqual(before)
  })

  test("unsafe state profile id cannot escape the config library", () => {
    applyConfigLibraryProfile(home)
    const directory = getClaude3pDir(home)
    const library = path.join(directory, "configLibrary")
    const victimPath = path.join(directory, "victim.json")
    const victim = JSON.stringify({ keep: true })
    fs.writeFileSync(victimPath, victim)

    const unsafeId = "../victim"
    const state = readJsonObject(statePath())
    state.profileId = unsafeId
    state.fingerprint = createHash("sha256").update(victim).digest("hex")
    fs.writeFileSync(statePath(), JSON.stringify(state))
    fs.writeFileSync(
      path.join(library, "_meta.json"),
      JSON.stringify({
        appliedId: unsafeId,
        entries: [{ id: unsafeId, name: "maximal" }],
      }),
    )
    const before = snapshotTree()

    expect(configLibraryConflict(home)).toBe("cleanup-required")
    expect(applyConfigLibraryProfile(home)).toMatchObject({
      wrote: false,
      conflict: "cleanup-required",
    })
    expect(revertConfigLibraryProfile(home)).toMatchObject({ reverted: false })
    expect(snapshotTree()).toEqual(before)
    expect(fs.readFileSync(victimPath, "utf8")).toBe(victim)
  })

  test("boot reconciliation clears stale intent without flapping the owner", () => {
    applyConfigLibraryProfile(home)
    markAsOtherProfile()
    const before = snapshotTree()
    writeConfig({ apps: { claudeDesktop: { enabled: true } } })

    reconcileClaudeDesktopOnBoot(true, home)

    expect(getConfig().apps?.claudeDesktop?.enabled).toBe(false)
    expect(snapshotTree()).toEqual(before)
  })
})
