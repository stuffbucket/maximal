/**
 * Coverage for the GitHub token storage shape — both the v1 JSON path and
 * the legacy bare-string auto-upgrade. Uses explicit file paths so the
 * test doesn't depend on `paths.ts`'s import-time env capture.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  accountKey,
  addAndActivate,
  emptyRegistry,
  getActiveRecord,
  type GitHubTokenRecord,
  inferTokenType,
  listAccounts,
  makeAccountRecord,
  migrateLegacyRecord,
  readGitHubTokenRecord,
  readRegistry,
  removeAccount,
  setActive,
  writeGitHubTokenRecord,
  writeRegistry,
} from "~/lib/auth/github-token-store"

/** Local builder for a v1 single-record token file. Production code never
 *  constructs these outside `readGitHubTokenRecord`'s upgrade path, so this
 *  helper lives with the tests that need a record to write/read back. */
const makeRecord = (
  accessToken: string,
  refreshToken: string | null = null,
): GitHubTokenRecord => ({
  schemaVersion: 1,
  tokenType: inferTokenType(accessToken),
  accessToken,
  refreshToken,
  obtainedAt: new Date().toISOString(),
})

let tokenDir: string
let tokenPath: string
let registryPath: string

beforeEach(() => {
  tokenDir = mkdtempSync(path.join(os.tmpdir(), "maximal-gh-token-"))
  tokenPath = path.join(tokenDir, "github_token")
  registryPath = path.join(tokenDir, "accounts.json")
})

afterEach(async () => {
  await fs.rm(tokenDir, { recursive: true, force: true }).catch(() => {})
})

describe("inferTokenType", () => {
  it("detects ghu_, gho_, and unknown prefixes", () => {
    expect(inferTokenType("ghu_abc123")).toBe("ghu_")
    expect(inferTokenType("gho_abc123")).toBe("gho_")
    expect(inferTokenType("ghs_abc123")).toBe("unknown")
    expect(inferTokenType("")).toBe("unknown")
  })
})

describe("readGitHubTokenRecord — v1 JSON", () => {
  it("returns null when the file is absent", async () => {
    expect(await readGitHubTokenRecord(tokenPath)).toBeNull()
  })

  it("parses a v1 JSON record", async () => {
    await writeGitHubTokenRecord(tokenPath, {
      schemaVersion: 1,
      tokenType: "ghu_",
      accessToken: "ghu_test_token",
      refreshToken: null,
      obtainedAt: "2026-05-08T00:00:00Z",
    })
    const r = await readGitHubTokenRecord(tokenPath)
    expect(r?.accessToken).toBe("ghu_test_token")
    expect(r?.tokenType).toBe("ghu_")
    expect(r?.obtainedAt).toBe("2026-05-08T00:00:00Z")
  })

  it("falls back to bare-string treatment when JSON is malformed", async () => {
    await fs.writeFile(tokenPath, "{ not valid json", "utf8")
    const r = await readGitHubTokenRecord(tokenPath)
    expect(r?.accessToken).toBe("{ not valid json")
    expect(r?.tokenType).toBe("unknown")
  })
})

describe("readGitHubTokenRecord — legacy bare-string", () => {
  it("auto-upgrades a bare ghu_ token to v1 JSON on read", async () => {
    await fs.writeFile(tokenPath, "ghu_legacy_token", "utf8")
    const r = await readGitHubTokenRecord(tokenPath)
    expect(r?.accessToken).toBe("ghu_legacy_token")
    expect(r?.tokenType).toBe("ghu_")
    const after = await fs.readFile(tokenPath, "utf8")
    expect(after.trim().startsWith("{")).toBe(true)
    const parsed = JSON.parse(after) as {
      schemaVersion: number
      accessToken: string
    }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.accessToken).toBe("ghu_legacy_token")
  })

  it("auto-detects gho_ prefix on bare upgrade", async () => {
    await fs.writeFile(tokenPath, "gho_opencode_style", "utf8")
    const r = await readGitHubTokenRecord(tokenPath)
    expect(r?.tokenType).toBe("gho_")
  })

  it("returns null for empty file", async () => {
    await fs.writeFile(tokenPath, "", "utf8")
    expect(await readGitHubTokenRecord(tokenPath)).toBeNull()
  })
})

describe("writeGitHubTokenRecord", () => {
  it("writes mode 0o600 on POSIX", async () => {
    await writeGitHubTokenRecord(tokenPath, makeRecord("ghu_test"))
    if (process.platform !== "win32") {
      const stat = await fs.stat(tokenPath)
      expect(stat.mode & 0o777).toBe(0o600)
    }
  })
})

const rec = (login: string, host = "github.com", token = "ghu_t") =>
  makeAccountRecord({ login, host, token, addedVia: "device-code" })

describe("registry — pure ops", () => {
  it("addAndActivate inserts by login@host and sets it active", () => {
    const reg = addAndActivate(emptyRegistry(), rec("alice"))
    expect(reg.activeKey).toBe("alice@github.com")
    expect(getActiveRecord(reg)?.login).toBe("alice")
    expect(Object.keys(reg.accounts)).toEqual(["alice@github.com"])
  })

  it("addAndActivate replaces the same identity (latest wins), no dup", () => {
    let reg = addAndActivate(
      emptyRegistry(),
      rec("alice", "github.com", "ghu_old"),
    )
    reg = addAndActivate(reg, rec("alice", "github.com", "ghu_new"))
    expect(Object.keys(reg.accounts)).toHaveLength(1)
    expect(getActiveRecord(reg)?.token).toBe("ghu_new")
  })

  it("distinct hosts are distinct accounts", () => {
    let reg = addAndActivate(emptyRegistry(), rec("alice", "github.com"))
    reg = addAndActivate(reg, rec("alice", "ghe.corp.com"))
    expect(Object.keys(reg.accounts)).toHaveLength(2)
    expect(reg.activeKey).toBe(accountKey("alice", "ghe.corp.com"))
  })

  it("setActive no-ops on an absent key (no dangling pointer)", () => {
    const reg = addAndActivate(emptyRegistry(), rec("alice"))
    expect(setActive(reg, "ghost@github.com").activeKey).toBe(
      "alice@github.com",
    )
    expect(setActive(reg, "alice@github.com").activeKey).toBe(
      "alice@github.com",
    )
  })

  it("removeAccount clears activeKey when removing the active one", () => {
    let reg = addAndActivate(emptyRegistry(), rec("alice"))
    reg = addAndActivate(reg, rec("bob"))
    // bob is active; remove bob → active falls back to null
    reg = removeAccount(reg, "bob@github.com")
    expect(reg.activeKey).toBeNull()
    expect(Object.keys(reg.accounts)).toEqual(["alice@github.com"])
  })

  it("removeAccount keeps activeKey when removing a non-active account", () => {
    let reg = addAndActivate(emptyRegistry(), rec("alice"))
    reg = addAndActivate(reg, rec("bob")) // bob active
    reg = removeAccount(reg, "alice@github.com")
    expect(reg.activeKey).toBe("bob@github.com")
  })

  it("listAccounts flags the active account", () => {
    let reg = addAndActivate(emptyRegistry(), rec("alice"))
    reg = addAndActivate(reg, rec("bob")) // bob active
    const list = listAccounts(reg)
    expect(list.find((a) => a.login === "bob")?.active).toBe(true)
    expect(list.find((a) => a.login === "alice")?.active).toBe(false)
  })
})

describe("registry — persistence", () => {
  it("write then read round-trips", async () => {
    const reg = addAndActivate(
      emptyRegistry(),
      makeAccountRecord({
        login: "alice",
        host: "github.com",
        token: "ghu_t",
        addedVia: "gh-cli",
      }),
    )
    await writeRegistry(registryPath, reg)
    const back = await readRegistry(registryPath)
    expect(back).toEqual(reg)
  })

  it("write is mode 0o600 on POSIX (atomic temp+rename preserves it)", async () => {
    await writeRegistry(registryPath, emptyRegistry())
    if (process.platform !== "win32") {
      const stat = await fs.stat(registryPath)
      expect(stat.mode & 0o777).toBe(0o600)
    }
  })

  it("missing or corrupt file degrades to an empty registry", async () => {
    expect(await readRegistry(registryPath)).toEqual(emptyRegistry())
    await fs.writeFile(registryPath, "{ not json")
    expect(await readRegistry(registryPath)).toEqual(emptyRegistry())
  })
})

describe("migrateLegacyRecord", () => {
  it("lifts a legacy v1 record into a login-keyed registry", async () => {
    await writeGitHubTokenRecord(tokenPath, makeRecord("ghu_legacy"))
    const migrated = await migrateLegacyRecord({
      legacyPath: tokenPath,
      registryPath,
      host: "github.com",
      resolveLogin: () => Promise.resolve("alice"),
    })
    expect(migrated?.activeKey).toBe("alice@github.com")
    // Assert via the persisted registry (also proves it was written to disk).
    const onDisk = await readRegistry(registryPath)
    expect(onDisk.activeKey).toBe("alice@github.com")
    expect(getActiveRecord(onDisk)?.token).toBe("ghu_legacy")
    expect(getActiveRecord(onDisk)?.addedVia).toBe("migration")
  })

  it("falls back to unknown@host when the login lookup fails (offline)", async () => {
    await writeGitHubTokenRecord(tokenPath, makeRecord("ghu_legacy"))
    const migrated = await migrateLegacyRecord({
      legacyPath: tokenPath,
      registryPath,
      host: "github.com",
      resolveLogin: () => Promise.resolve(null),
    })
    expect(migrated?.activeKey).toBe("unknown@github.com")
  })

  it("is a no-op when the registry already has accounts", async () => {
    await writeRegistry(
      registryPath,
      addAndActivate(
        emptyRegistry(),
        makeAccountRecord({
          login: "bob",
          host: "github.com",
          token: "ghu_b",
          addedVia: "device-code",
        }),
      ),
    )
    await writeGitHubTokenRecord(tokenPath, makeRecord("ghu_legacy"))
    const migrated = await migrateLegacyRecord({
      legacyPath: tokenPath,
      registryPath,
      host: "github.com",
      resolveLogin: () => Promise.resolve("alice"),
    })
    expect(migrated).toBeNull()
    // existing registry untouched
    expect(getActiveRecord(await readRegistry(registryPath))?.login).toBe("bob")
  })

  it("is a no-op when there is no legacy token", async () => {
    const migrated = await migrateLegacyRecord({
      legacyPath: tokenPath,
      registryPath,
      host: "github.com",
      resolveLogin: () => Promise.resolve("alice"),
    })
    expect(migrated).toBeNull()
  })

  it("preserves the legacy obtainedAt rather than re-stamping", async () => {
    const legacy = makeRecord("ghu_legacy")
    legacy.obtainedAt = "2020-01-01T00:00:00.000Z"
    await writeGitHubTokenRecord(tokenPath, legacy)
    await migrateLegacyRecord({
      legacyPath: tokenPath,
      registryPath,
      host: "github.com",
      resolveLogin: () => Promise.resolve("alice"),
    })
    const active = getActiveRecord(await readRegistry(registryPath))
    expect(active?.obtainedAt).toBe("2020-01-01T00:00:00.000Z")
  })
})
