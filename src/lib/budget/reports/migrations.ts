/**
 * The token-usage database migration that adds `budget_events` (appended to
 * `TOKEN_USAGE_MIGRATIONS` in `~/lib/token-usage/store`).
 *
 * One row per decision the budget service made about a limit that is worth
 * looking back on: a call it refused, the first call to cross a limit's
 * warning threshold in a period, and a billed call it admitted with an
 * estimate held. `usage rows` already say what was spent; this says what the
 * limits did about it, which the timeline (`./timeline`) reports.
 */

import type { Migration } from "~/lib/platform/sqlite"

export const BUDGET_EVENTS_MIGRATION: Migration = {
  name: "add budget_events",
  up: (db) => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS budget_events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at_ms INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('refused', 'warned', 'approved')), limit_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT, client_key TEXT NOT NULL, operation TEXT NOT NULL, estimate_nano_aiu INTEGER NOT NULL, used_nano_aiu INTEGER NOT NULL, limit_nano_aiu INTEGER NOT NULL)",
    )
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_budget_events_limit_created ON budget_events(limit_id, created_at_ms)",
    )
  },
}
