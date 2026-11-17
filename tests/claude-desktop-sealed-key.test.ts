/**
 * Claude Desktop seals the gateway key it reads from a config-library
 * profile, replacing Maximal's plaintext key with `__sealed__:v1:<base64>`.
 * The routing marker's evidence (a fingerprint of the other managed fields
 * and an HMAC of the plaintext key under this profile's own secret) keeps
 * Maximal's own profile recognized afterwards, without decoding anything.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  applyConfigLibraryProfile,
  configLibraryConflict,
  getClaude3pDir,
  isConfigLibraryApplied,
  revertConfigLibraryProfile,
} from "~/apps/claude-desktop/config"
import { isClaudeSealedKey } from "~/apps/claude-desktop/marker-evidence"
import {
  disableClaudeDesktopRouting,
  enableClaudeDesktopRouting,
  reconcileClaudeDesktopOnBoot,
} from "~/apps/claude-desktop/reconcile"
import { profileIdForDirectory } from "~/apps/profile-identity"
import { generateApiKey } from "~/lib/auth/api-key-helper"
import { getConfig, writeConfig } from "~/lib/config/config"
import { PATHS } from "~/lib/platform/paths"
import { setListeningPort } from "~/lib/start/proxy-port"

let home: string
let key: string

function useKey(next: string): void {
  key = next
  writeConfig({
    ...getConfig(),
    auth: {
      apiKeyEntries: [
        {
          id: "k1",
          label: "claude-desktop",
          key: next,
          enabled: true,
          created_at: "2026-11-17T00:00:00.000Z",
        },
      ],
    },
  })
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cd-sealed-"))
  setListeningPort(5151)
  writeConfig({})
  useKey(generateApiKey())
})

afterEach(() => {
  writeConfig({})
  setListeningPort(undefined)
  fs.rmSync(home, { recursive: true, force: true })
})

const libDir = (): string => path.join(getClaude3pDir(home), "configLibrary")
const metaPath = (): string => path.join(libDir(), "_meta.json")
const topPath = (): string =>
  path.join(getClaude3pDir(home), "claude_desktop_config.json")
const statePath = (): string =>
  path.join(getClaude3pDir(home), "maximal-routing.json")
const profilePath = (id: string): string => path.join(libDir(), `${id}.json`)
const secretPath = (): string =>
  path.join(PATHS.APP_DIR, "secrets", "claude-desktop-marker")

function readJson(file: string): Record<string, unknown> {
  // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse expects text in TypeScript
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
}

/** A value in Claude's sealed form: the tag and a 196-character payload. */
function sealedValue(): string {
  return `__sealed__:v1:${randomBytes(147).toString("base64")}`
}

/** What Claude does when it reads the profile: seal the key, rewrite the
 *  file in its own formatting. `edit` changes anything else first. */
function claudeSeals(
  id: string,
  edit: (profile: Record<string, unknown>) => void = () => {},
  sealed: unknown = sealedValue(),
): void {
  const profile = readJson(profilePath(id))
  profile.inferenceGatewayApiKey = sealed
  edit(profile)
  fs.writeFileSync(profilePath(id), JSON.stringify(profile, null, 2))
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

function enableWithTop(top: Record<string, unknown>): string {
  fs.mkdirSync(getClaude3pDir(home), { recursive: true })
  fs.writeFileSync(topPath(), JSON.stringify(top))
  return enableClaudeDesktopRouting(home).profileId
}

describe("Claude seals the key of Maximal's own profile", () => {
  test("it stays applied and owned, and repeated reads and boots write nothing", () => {
    const id = enableWithTop({ unrelated: 1 })
    claudeSeals(id)
    const before = snapshotTree()

    for (let read = 0; read < 3; read++) {
      expect(isConfigLibraryApplied(home)).toBe(true)
      expect(configLibraryConflict(home)).toBeNull()
    }
    expect(applyConfigLibraryProfile(home)).toMatchObject({
      wrote: false,
      conflict: null,
      profileId: id,
    })
    reconcileClaudeDesktopOnBoot(true, home)
    reconcileClaudeDesktopOnBoot(true, home)

    expect(snapshotTree()).toEqual(before)
    expect(getConfig().apps?.claudeDesktop?.enabled).toBe(true)
  })

  test("a rotated Maximal key rewrites the same entry and refreshes the marker", () => {
    const id = enableWithTop({ unrelated: 1 })
    const markerBefore = readJson(statePath())
    claudeSeals(id)

    useKey(generateApiKey())
    expect(isConfigLibraryApplied(home)).toBe(false)
    expect(configLibraryConflict(home)).toBeNull()

    reconcileClaudeDesktopOnBoot(true, home)

    expect(readJson(metaPath()).entries).toEqual([{ id, name: "maximal" }])
    expect(readJson(profilePath(id)).inferenceGatewayApiKey).toBe(key)
    const markerAfter = readJson(statePath())
    expect(markerAfter.keyFingerprint).not.toBe(markerBefore.keyFingerprint)
    expect(markerAfter.prior).toEqual(markerBefore.prior)
    expect(isConfigLibraryApplied(home)).toBe(true)

    claudeSeals(id)
    expect(isConfigLibraryApplied(home)).toBe(true)
  })

  test("a new Maximal port rewrites the same entry", () => {
    const id = enableWithTop({})
    claudeSeals(id)
    setListeningPort(6262)

    expect(isConfigLibraryApplied(home)).toBe(false)
    expect(applyConfigLibraryProfile(home)).toMatchObject({
      wrote: true,
      conflict: null,
      profileId: id,
    })
    expect(readJson(profilePath(id)).inferenceGatewayBaseUrl).toBe(
      "http://127.0.0.1:6262",
    )
  })

  test("disable removes it and restores exactly", () => {
    const id = enableWithTop({ unrelated: 1 })
    claudeSeals(id)

    disableClaudeDesktopRouting(home)

    expect(fs.existsSync(profilePath(id))).toBe(false)
    expect(readJson(metaPath())).toEqual({ appliedId: "", entries: [] })
    expect(readJson(topPath())).toEqual({ unrelated: 1 })
    expect(fs.existsSync(statePath())).toBe(false)
  })

  test("losing this profile's marker secret costs one rewrite, never ownership", () => {
    const id = enableWithTop({})
    claudeSeals(id)
    fs.rmSync(secretPath())

    expect(isConfigLibraryApplied(home)).toBe(false)
    expect(configLibraryConflict(home)).toBeNull()
    expect(applyConfigLibraryProfile(home)).toMatchObject({
      wrote: true,
      profileId: id,
    })
    claudeSeals(id)
    expect(isConfigLibraryApplied(home)).toBe(true)
  })
})

describe("the marker holds no secret", () => {
  test("neither the key nor an unkeyed hash of it, and the secret stays private", () => {
    enableWithTop({})
    const marker = fs.readFileSync(statePath(), "utf8")
    const parsed = readJson(statePath())

    expect(marker).not.toContain(key)
    expect(marker).not.toContain(key.slice(4))
    expect(parsed.keyFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.keyFingerprint).not.toBe(
      createHash("sha256").update(key).digest("hex"),
    )
    expect(Object.keys(parsed).sort()).toEqual([
      "fingerprint",
      "keyFingerprint",
      "managedFingerprint",
      "ownerProfileId",
      "prior",
      "profileId",
      "version",
    ])
    expect(fs.statSync(secretPath()).mode & 0o777).toBe(0o600)
    expect(marker).not.toContain(fs.readFileSync(secretPath(), "utf8").trim())
  })
})

/** Values a person or another tool might leave that aren't Claude's
 *  sealed form, including near misses. */
const NOT_SEALED: Array<[string, unknown]> = [
  ["a plaintext key of their own", "sk-litellm-local-1234"],
  ["another tag version", `__sealed__:v2:${"A".repeat(196)}`],
  ["an upper-case tag", `__SEALED__:v1:${"A".repeat(196)}`],
  ["a short payload", `__sealed__:v1:${"A".repeat(60)}`],
  ["a payload of no whole groups", `__sealed__:v1:${"A".repeat(197)}`],
  ["URL-safe characters", `__sealed__:v1:${"A".repeat(192)}-_AA`],
  ["three padding characters", `__sealed__:v1:${"A".repeat(193)}===`],
  ["leading whitespace", ` __sealed__:v1:${"A".repeat(196)}`],
  ["a trailing newline", `__sealed__:v1:${"A".repeat(196)}\n`],
  ["an empty payload", "__sealed__:v1:"],
  ["a non-string", 42],
]

describe("only Claude's exact sealed form counts", () => {
  test("a sealed value is recognized", () => {
    expect(isClaudeSealedKey(sealedValue())).toBe(true)
  })

  test.each(NOT_SEALED)("%s is not sealed", (_name, value) => {
    expect(isClaudeSealedKey(value)).toBe(false)
  })

  test.each(NOT_SEALED)(
    "%s in Maximal's entry stays theirs, and Take over keeps it",
    (_name, value) => {
      const id = enableWithTop({ unrelated: 1 })
      claudeSeals(id, () => {}, value)
      const theirs = fs.readFileSync(profilePath(id), "utf8")

      expect(configLibraryConflict(home)).toBe("foreign-gateway-profile")
      expect(isConfigLibraryApplied(home)).toBe(false)
      const takeOver = enableClaudeDesktopRouting(home, {
        overrideForeignGateway: true,
      })
      expect(takeOver.profileId).not.toBe(id)
      expect(fs.readFileSync(profilePath(id), "utf8")).toBe(theirs)

      disableClaudeDesktopRouting(home)
      expect(readJson(metaPath()).appliedId).toBe(id)
      expect(fs.readFileSync(profilePath(id), "utf8")).toBe(theirs)
      expect(readJson(topPath())).toEqual({ unrelated: 1 })
    },
  )
})

describe("a sealed key never excuses any other change", () => {
  const edits: Array<[string, (profile: Record<string, unknown>) => void]> = [
    [
      "a gateway of their own",
      (profile) => {
        profile.inferenceGatewayBaseUrl = "http://127.0.0.1:4000"
      },
    ],
    [
      "another workspace folder",
      (profile) => {
        profile.allowedWorkspaceFolders = ["/mine"]
      },
    ],
    [
      "a field Claude's editor adds",
      (profile) => {
        profile.inferenceCredentialKind = "static"
      },
    ],
    [
      "a missing field",
      (profile) => {
        delete profile.disableAutoUpdates
      },
    ],
  ]

  test.each(edits)("%s is the person's", (_name, edit) => {
    const id = enableWithTop({})
    claudeSeals(id, edit)
    const before = snapshotTree()

    expect(configLibraryConflict(home)).toBe("foreign-gateway-profile")
    expect(applyConfigLibraryProfile(home).wrote).toBe(false)
    reconcileClaudeDesktopOnBoot(true, home)
    expect(snapshotTree()).toEqual(before)
  })

  test("a renamed entry is the person's", () => {
    const id = enableWithTop({})
    claudeSeals(id)
    fs.writeFileSync(
      metaPath(),
      JSON.stringify({ appliedId: id, entries: [{ id, name: "Mine" }] }),
    )

    expect(configLibraryConflict(home)).toBe("foreign-gateway-profile")
  })
})

describe("markers without the evidence stay conservative", () => {
  test.each([
    [
      "a marker from before the evidence",
      ["managedFingerprint", "keyFingerprint"],
    ],
    ["a marker without key evidence", ["keyFingerprint"]],
    [
      "an ownerless older marker",
      ["managedFingerprint", "keyFingerprint", "version", "ownerProfileId"],
    ],
  ] as Array<[string, Array<string>]>)(
    "%s with a sealed key: no ownership from the key's shape",
    (_name, drop) => {
      const id = enableWithTop({})
      const marker = Object.fromEntries(
        Object.entries(readJson(statePath())).filter(
          ([field]) => !drop.includes(field),
        ),
      )
      fs.writeFileSync(statePath(), JSON.stringify(marker))
      claudeSeals(id)
      const before = snapshotTree()

      expect(isConfigLibraryApplied(home)).toBe(false)
      expect(configLibraryConflict(home)).not.toBeNull()
      expect(applyConfigLibraryProfile(home).wrote).toBe(false)
      expect(snapshotTree()).toEqual(before)
    },
  )
})

function sealedForOtherProfile(): string {
  const id = enableWithTop({ unrelated: 1 })
  claudeSeals(id)
  const marker = readJson(statePath())
  marker.ownerProfileId = profileIdForDirectory(path.join(home, "other"))
  fs.writeFileSync(statePath(), JSON.stringify(marker))
  return id
}

describe("another profile's sealed profile stays theirs", () => {
  test("only the explicit transfer may take it, and it is repaired in place", () => {
    const id = sealedForOtherProfile()
    writeConfig({ ...getConfig(), apps: { claudeDesktop: { enabled: true } } })
    const before = snapshotTree()

    expect(configLibraryConflict(home)).toBe("other-maximal-config")
    expect(isConfigLibraryApplied(home)).toBe(false)
    expect(applyConfigLibraryProfile(home).wrote).toBe(false)
    expect(
      enableClaudeDesktopRouting(home, { overrideForeignGateway: true }).wrote,
    ).toBe(false)
    expect(revertConfigLibraryProfile(home).reverted).toBe(false)
    reconcileClaudeDesktopOnBoot(true, home)
    expect(getConfig().apps?.claudeDesktop?.enabled).toBe(false)
    expect(snapshotTree()).toEqual(before)

    expect(
      enableClaudeDesktopRouting(home, { overrideOtherMaximal: true }),
    ).toMatchObject({ wrote: true, conflict: null, profileId: id })
    expect(readJson(profilePath(id)).inferenceGatewayApiKey).toBe(key)
    expect(readJson(metaPath()).entries).toEqual([{ id, name: "maximal" }])
  })
})
