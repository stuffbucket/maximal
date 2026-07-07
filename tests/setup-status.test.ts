import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { evaluateSetup, type SetupPaths } from "~/lib/config/setup-status"

interface Sandbox {
  dir: string
  paths: SetupPaths
}

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(path.join(tmpdir(), "maximal-setup-status-"))
  return {
    dir,
    paths: {
      appDir: dir,
      configPath: path.join(dir, "config.json"),
      dbPath: path.join(dir, "copilot-api.sqlite"),
      githubTokenPath: path.join(dir, "github_token"),
    },
  }
}

let sandbox: Sandbox

beforeEach(() => {
  sandbox = makeSandbox()
})

afterEach(() => {
  // chmodSync makes sure we can clean up directories we made non-writable.
  try {
    chmodSync(sandbox.dir, 0o700)
  } catch {
    // already removed or never created
  }
  rmSync(sandbox.dir, { recursive: true, force: true })
})

const validTokenRecord = JSON.stringify({
  schemaVersion: 1,
  tokenType: "ghu_",
  accessToken: "ghu_FAKE_TEST_TOKEN_FOR_UNIT_TESTS",
  refreshToken: null,
  obtainedAt: "2026-05-11T17:00:00.000Z",
})

function writeValidToken(p: SetupPaths): void {
  writeFileSync(p.githubTokenPath, validTokenRecord)
}

function writeValidConfig(p: SetupPaths): void {
  writeFileSync(p.configPath, JSON.stringify({}))
}

function writeNonEmptyDb(p: SetupPaths): void {
  // The real db is sqlite; for this check we only inspect file size, so
  // any non-empty buffer is sufficient.
  writeFileSync(p.dbPath, "SQLite format 3\0placeholder")
}

describe("evaluateSetup", () => {
  test("all checks pass → ready, nextStep null", async () => {
    writeValidConfig(sandbox.paths)
    writeNonEmptyDb(sandbox.paths)
    writeValidToken(sandbox.paths)

    const status = await evaluateSetup(sandbox.paths)

    expect(status.ready).toBe(true)
    expect(status.nextStep).toBeNull()
    expect(status.checks.appDir.ok).toBe(true)
    expect(status.checks.config.ok).toBe(true)
    expect(status.checks.db.ok).toBe(true)
    expect(status.checks.githubAuth.ok).toBe(true)
  })

  test("missing github_token → not ready, nextStep githubAuth", async () => {
    writeValidConfig(sandbox.paths)
    writeNonEmptyDb(sandbox.paths)
    // no token

    const status = await evaluateSetup(sandbox.paths)

    expect(status.ready).toBe(false)
    expect(status.nextStep).toBe("githubAuth")
    expect(status.checks.githubAuth.ok).toBe(false)
    expect(status.checks.githubAuth.reason).toContain("missing")
  })

  test("missing appDir → nextStep appDir (failures masked by order)", async () => {
    rmSync(sandbox.dir, { recursive: true, force: true })
    // also no config, db, token — but appDir should be reported first
    // because it's first in CHECK_ORDER.

    const status = await evaluateSetup(sandbox.paths)

    expect(status.ready).toBe(false)
    expect(status.nextStep).toBe("appDir")
    expect(status.checks.appDir.ok).toBe(false)
  })

  test("absent config.json is OK (proxy defaults take over)", async () => {
    writeNonEmptyDb(sandbox.paths)
    writeValidToken(sandbox.paths)

    const status = await evaluateSetup(sandbox.paths)

    expect(status.checks.config.ok).toBe(true)
    expect(status.ready).toBe(true)
  })

  test("invalid JSON in config.json → config fails", async () => {
    writeFileSync(sandbox.paths.configPath, "{ this is not json")
    writeNonEmptyDb(sandbox.paths)
    writeValidToken(sandbox.paths)

    const status = await evaluateSetup(sandbox.paths)

    expect(status.checks.config.ok).toBe(false)
    expect(status.checks.config.reason).toBe("invalid JSON")
    expect(status.nextStep).toBe("config")
  })

  test("schema-mismatching config.json → config fails with field hint", async () => {
    writeFileSync(
      sandbox.paths.configPath,
      JSON.stringify({ logRetentionDays: "not a number" }),
    )
    writeNonEmptyDb(sandbox.paths)
    writeValidToken(sandbox.paths)

    const status = await evaluateSetup(sandbox.paths)

    expect(status.checks.config.ok).toBe(false)
    expect(status.checks.config.reason).toContain("logRetentionDays")
    expect(status.nextStep).toBe("config")
  })

  test("empty github_token file → not ready", async () => {
    writeValidConfig(sandbox.paths)
    writeNonEmptyDb(sandbox.paths)
    writeFileSync(sandbox.paths.githubTokenPath, "")

    const status = await evaluateSetup(sandbox.paths)

    expect(status.checks.githubAuth.ok).toBe(false)
    expect(status.nextStep).toBe("githubAuth")
  })

  test("absent db file is OK (lazy-created on first write)", async () => {
    writeValidConfig(sandbox.paths)
    writeValidToken(sandbox.paths)
    // no db

    const status = await evaluateSetup(sandbox.paths)

    expect(status.checks.db.ok).toBe(true)
    expect(status.ready).toBe(true)
  })

  test("zero-byte db file → db fails", async () => {
    writeValidConfig(sandbox.paths)
    writeValidToken(sandbox.paths)
    writeFileSync(sandbox.paths.dbPath, "")

    const status = await evaluateSetup(sandbox.paths)

    expect(status.checks.db.ok).toBe(false)
    expect(status.checks.db.reason).toBe("empty file")
    expect(status.nextStep).toBe("db")
  })

  test("nested missing dir under appDir resolves to appDir-level failure", async () => {
    // Point at a subdir that doesn't exist
    const nested = path.join(sandbox.dir, "nonexistent-child")
    const altPaths: SetupPaths = {
      appDir: nested,
      configPath: path.join(nested, "config.json"),
      dbPath: path.join(nested, "copilot-api.sqlite"),
      githubTokenPath: path.join(nested, "github_token"),
    }

    const status = await evaluateSetup(altPaths)

    expect(status.ready).toBe(false)
    expect(status.nextStep).toBe("appDir")
    expect(status.checks.appDir.reason).toContain("does not exist")
  })
})
