/**
 * The token-usage database migration that adds `budget_holds`
 * (`~/lib/token-usage/store` appends it to its migration list).
 *
 * A hold is the estimate reserved before a billed call, written ahead so a
 * crash mid-call still counts against the budget. A hold still open at the
 * next start is marked `orphaned` and counts at its estimate
 * (`~/lib/budget/store`).
 */

import type { Migration } from "~/lib/platform/sqlite"

export const BUDGET_HOLDS_MIGRATION: Migration = {
  name: "add budget_holds",
  up: (db) => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS budget_holds (id TEXT PRIMARY KEY, created_at_ms INTEGER NOT NULL, operation TEXT NOT NULL, provider TEXT, plugin_id TEXT, tool_name TEXT, client_key TEXT NOT NULL, estimate_nano_aiu INTEGER NOT NULL, actual_nano_aiu INTEGER, state TEXT NOT NULL CHECK (state IN ('open', 'committed', 'released', 'orphaned')), closed_at_ms INTEGER)",
    )
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_budget_holds_state_created ON budget_holds(state, created_at_ms)",
    )
  },
}
