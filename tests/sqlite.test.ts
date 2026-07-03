import { describe, expect, test } from "bun:test"

import {
  isNodeSqliteSupportedVersion,
  isSqliteRuntimeSupported,
  type Migration,
  openSqliteDatabase,
  runMigrations,
  type SqliteDatabase,
  UnsupportedNodeSqliteRuntimeError,
} from "~/lib/sqlite"

describe("sqlite runtime support", () => {
  test("detects the minimum Node.js version for node:sqlite", () => {
    expect(isNodeSqliteSupportedVersion("22.12.0")).toBe(false)
    expect(isNodeSqliteSupportedVersion("22.13.0")).toBe(true)
    expect(isNodeSqliteSupportedVersion("23.0.0")).toBe(true)
  })

  test("disables SQLite on older Node.js versions while allowing Bun", () => {
    expect(
      isSqliteRuntimeSupported({ isBun: false, nodeVersion: "22.12.0" }),
    ).toBe(false)
    expect(
      isSqliteRuntimeSupported({ isBun: false, nodeVersion: "22.13.0" }),
    ).toBe(true)
    expect(
      isSqliteRuntimeSupported({ isBun: true, nodeVersion: "20.0.0" }),
    ).toBe(true)
  })

  test("unsupported Node.js message uses current maximal package branding", () => {
    const error = new UnsupportedNodeSqliteRuntimeError("22.12.0")

    expect(error.message).toContain(
      "`bunx --bun @stuffbucket/maximal@latest start` or `maximal start`.",
    )
    expect(error.message).not.toContain("copilot-api")
  })
})

function userVersion(db: SqliteDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version?: number
  }
  return row.user_version ?? 0
}

describe("runMigrations", () => {
  test("runs all migrations in order on a fresh DB and sets user_version", async () => {
    const db = await openSqliteDatabase(":memory:")
    const migrations: Array<Migration> = [
      {
        name: "create t",
        up: (d) => d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)"),
      },
      {
        name: "add col b",
        up: (d) =>
          d.exec("ALTER TABLE t ADD COLUMN b INTEGER NOT NULL DEFAULT 0"),
      },
    ]
    expect(runMigrations(db, migrations)).toBe(2)
    expect(userVersion(db)).toBe(2)
    // Column b exists.
    db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run("x", 5)
    const row = db.prepare("SELECT a, b FROM t").get() as {
      a: string
      b: number
    }
    expect(row).toEqual({ a: "x", b: 5 })
  })

  test("is idempotent — re-running only applies new migrations, preserving data", async () => {
    const db = await openSqliteDatabase(":memory:")
    const v1: Array<Migration> = [
      {
        name: "create t",
        up: (d) => d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)"),
      },
    ]
    runMigrations(db, v1)
    db.prepare("INSERT INTO t (a) VALUES (?)").run("keep-me")

    // Add a second migration that backfills existing rows.
    const v2: Array<Migration> = [
      ...v1,
      {
        name: "add col b + backfill",
        up: (d) => {
          d.exec("ALTER TABLE t ADD COLUMN b INTEGER NOT NULL DEFAULT 0")
          d.exec("UPDATE t SET b = 42")
        },
      },
    ]
    expect(runMigrations(db, v2)).toBe(2)
    // Existing row survived AND was backfilled by the data migration.
    const row = db.prepare("SELECT a, b FROM t").get() as {
      a: string
      b: number
    }
    expect(row).toEqual({ a: "keep-me", b: 42 })

    // Running again is a no-op.
    expect(runMigrations(db, v2)).toBe(2)
  })

  test("rolls back and throws on failure without advancing user_version", async () => {
    const db = await openSqliteDatabase(":memory:")
    const migrations: Array<Migration> = [
      {
        name: "create t",
        up: (d) => d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)"),
      },
      {
        name: "broken",
        up: (d) => d.exec("THIS IS NOT VALID SQL"),
      },
    ]
    expect(() => runMigrations(db, migrations)).toThrow(/step 2 \(broken\)/)
    // First migration committed (version 1); the broken one didn't advance it.
    expect(userVersion(db)).toBe(1)
  })
})
