import { describe, expect, test } from "bun:test"

import {
  openSqliteDatabase,
  runMigrations,
  type SqliteDatabase,
} from "~/lib/platform/sqlite"
import { TOKEN_USAGE_MIGRATIONS } from "~/lib/token-usage/store"

/**
 * Nullable `project_id` migration (spec §5, §10 gate "Nullable project_id migration
 * test — :memory:, idempotent, back-compat reads").
 *
 * project_id is forward-looking schema: the column exists so the filter/route can
 * reference it before per-project tracking turns on. Existing rows predate it and
 * MUST read back NULL (unattributed) — never crash, never invent a project. The
 * migration framework is version-based, so re-running it is a no-op.
 */

/** The v0 baseline table as it exists before ANY migration (pre-total_nano_aiu). */
const V0_BASELINE = `
  CREATE TABLE token_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    total_tokens INTEGER NOT NULL DEFAULT 0
  )
`

function columnNames(db: SqliteDatabase): Array<string> {
  return (
    db.prepare("PRAGMA table_info(token_usage_events)").all() as Array<{
      name: string
    }>
  ).map((row) => row.name)
}

function userVersion(db: SqliteDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version?: number
  }
  return row.user_version ?? 0
}

async function freshV0Db(): Promise<SqliteDatabase> {
  const db = await openSqliteDatabase(":memory:")
  db.exec(V0_BASELINE)
  return db
}

describe("token_usage project_id migration (§5)", () => {
  test("adds a nullable project_id column on top of the earlier migration", async () => {
    const db = await freshV0Db()
    runMigrations(db, TOKEN_USAGE_MIGRATIONS)
    const cols = columnNames(db)
    expect(cols).toContain("project_id")
    // The whole append-only chain applied, in order.
    expect(cols).toContain("total_nano_aiu")
    expect(cols).toContain("is_premium")
    expect(userVersion(db)).toBe(TOKEN_USAGE_MIGRATIONS.length)
    db.close?.()
  })

  test("back-compat: a pre-migration row reads project_id as NULL (unattributed)", async () => {
    const db = await freshV0Db()
    db.prepare("INSERT INTO token_usage_events (session_id) VALUES (?)").run(
      "legacy-session",
    )
    runMigrations(db, TOKEN_USAGE_MIGRATIONS)
    const row = db
      .prepare(
        "SELECT session_id, project_id, total_nano_aiu, is_premium FROM token_usage_events WHERE session_id = ?",
      )
      .get("legacy-session") as {
      session_id: string
      project_id: string | null
      total_nano_aiu: number
      is_premium: number | null
    }
    expect(row.session_id).toBe("legacy-session")
    expect(row.project_id).toBeNull()
    // The earlier migration backfills a cost of 0 and unknown premium status.
    expect(row.total_nano_aiu).toBe(0)
    expect(row.is_premium).toBeNull()
    db.close?.()
  })

  test("project_id accepts a value and round-trips", async () => {
    const db = await freshV0Db()
    runMigrations(db, TOKEN_USAGE_MIGRATIONS)
    db.prepare(
      "INSERT INTO token_usage_events (session_id, project_id) VALUES (?, ?)",
    ).run("s", "acme")
    const row = db
      .prepare("SELECT project_id FROM token_usage_events WHERE session_id = ?")
      .get("s") as { project_id: string | null }
    expect(row.project_id).toBe("acme")
    db.close?.()
  })

  test("idempotent: re-running the migrations is a no-op (version-guarded)", async () => {
    const db = await freshV0Db()
    const first = runMigrations(db, TOKEN_USAGE_MIGRATIONS)
    const second = runMigrations(db, TOKEN_USAGE_MIGRATIONS)
    expect(first).toBe(TOKEN_USAGE_MIGRATIONS.length)
    expect(second).toBe(first)
    // Still exactly one project_id column — a second ADD COLUMN would have thrown.
    expect(columnNames(db).filter((n) => n === "project_id")).toHaveLength(1)
    db.close?.()
  })
})
