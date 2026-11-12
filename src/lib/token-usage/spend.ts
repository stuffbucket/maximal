/**
 * Spend (nano-AIU) per budget scope: the rows of `token_usage_events`, plus
 * the estimates of holds a crash left `orphaned` (`budget_holds`), which are
 * counted because the call they reserved for may have been billed.
 */

import { KEY_SQL, PROVIDER_SQL } from "~/lib/token-usage/aggregate"
import {
  isTokenUsageStorageEnabled,
  readUsageDb,
} from "~/lib/token-usage/store"

/** The rows a budget scope covers. A key is the API key's label, else the
 *  client recognised from the user agent, else `unidentified`; a provider is
 *  `copilot` or the configured provider's name. */
export type SpendScope =
  | { kind: "global" }
  | { kind: "key" | "plugin" | "provider"; id: string }

/** A scope as a `WHERE` fragment over `token_usage_events`, one `?` for the
 *  scope's id. */
export const SCOPE_SQL: Record<
  Exclude<SpendScope["kind"], "global">,
  string
> = {
  key: `${KEY_SQL} = ?`,
  plugin: "plugin_id = ?",
  provider: `(${PROVIDER_SQL}) = ?`,
}

/** The same scopes over `budget_holds`' columns. */
const HOLD_SCOPE_SQL: Record<Exclude<SpendScope["kind"], "global">, string> = {
  key: "client_key = ?",
  plugin: "plugin_id = ?",
  provider: "provider = ?",
}

function readSpend(row: unknown, index: number): number {
  const value =
    typeof row === "object" && row !== null ?
      (row as Record<string, unknown>)[`spend_${index}`]
    : undefined
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** `[startMs, endMs)`; a null end never ends. */
export interface SpendRange {
  startMs: number
  endMs: number | null
}

/** The WHERE clauses that pick a scope's rows, from the SQL for its kind. */
function scopeWhere(
  scope: SpendScope,
  sql: Record<Exclude<SpendScope["kind"], "global">, string>,
): { clauses: Array<string>; values: Array<string | number> } {
  if (scope.kind === "global") return { clauses: [], values: [] }
  return { clauses: [sql[scope.kind]], values: [scope.id] }
}

/** Nano-AIU the scope's rows spent in each range, in one query; zeros when
 *  storage is off. */
export async function getNanoAiuSpend(
  scope: SpendScope,
  ranges: ReadonlyArray<SpendRange>,
): Promise<Array<number>> {
  if (ranges.length === 0) return []
  if (!isTokenUsageStorageEnabled()) return ranges.map(() => 0)

  const sums = ranges.map(
    (_, index) =>
      `COALESCE(SUM(CASE WHEN created_at_ms >= ? AND created_at_ms < ? THEN total_nano_aiu ELSE 0 END), 0) AS spend_${index}`,
  )
  const rangeValues = ranges.flatMap((range) => [
    range.startMs,
    range.endMs ?? Number.MAX_SAFE_INTEGER,
  ])
  const earliest = Math.min(...ranges.map((range) => range.startMs))
  const events = scopeWhere(scope, SCOPE_SQL)
  const where = ["created_at_ms >= ?", ...events.clauses]
  const whereValues = [earliest, ...events.values]
  const holdSums = ranges.map(
    (_, index) =>
      `COALESCE(SUM(CASE WHEN created_at_ms >= ? AND created_at_ms < ? THEN estimate_nano_aiu ELSE 0 END), 0) AS spend_${index}`,
  )
  const holds = scopeWhere(scope, HOLD_SCOPE_SQL)
  const holdWhere = [
    "state = 'orphaned'",
    "created_at_ms >= ?",
    ...holds.clauses,
  ]
  const holdWhereValues = [earliest, ...holds.values]
  const [row, orphanRow] = await readUsageDb((db) => [
    db
      .prepare(
        `SELECT ${sums.join(", ")} FROM token_usage_events WHERE ${where.join(" AND ")}`,
      )
      .get(...rangeValues, ...whereValues),
    db
      .prepare(
        `SELECT ${holdSums.join(", ")} FROM budget_holds WHERE ${holdWhere.join(" AND ")}`,
      )
      .get(...rangeValues, ...holdWhereValues),
  ])
  return ranges.map(
    (_, index) => readSpend(row, index) + readSpend(orphanRow, index),
  )
}

/** One cost the scope incurred at an instant. */
export interface SpendRow {
  createdAtMs: number
  nanoAiu: number
}

/** Every cost the scope incurred in the range (usage rows and orphaned
 *  holds), oldest first, for a rolling window that counts each as it ages.
 *  Rows that cost nothing are left out. Empty when storage is off. */
export async function getNanoAiuSpendRows(
  scope: SpendScope,
  range: SpendRange,
): Promise<Array<SpendRow>> {
  if (!isTokenUsageStorageEnabled()) return []
  const end = range.endMs ?? Number.MAX_SAFE_INTEGER
  const events = scopeWhere(scope, SCOPE_SQL)
  const holds = scopeWhere(scope, HOLD_SCOPE_SQL)
  const eventWhere = [
    "created_at_ms >= ?",
    "created_at_ms < ?",
    "total_nano_aiu > 0",
    ...events.clauses,
  ]
  const holdWhere = [
    "state = 'orphaned'",
    "created_at_ms >= ?",
    "created_at_ms < ?",
    "estimate_nano_aiu > 0",
    ...holds.clauses,
  ]
  const [eventRows, holdRows] = await readUsageDb((db) => [
    db
      .prepare(
        `SELECT created_at_ms AS at_ms, total_nano_aiu AS nano_aiu FROM token_usage_events WHERE ${eventWhere.join(" AND ")}`,
      )
      .all(range.startMs, end, ...events.values),
    db
      .prepare(
        `SELECT created_at_ms AS at_ms, estimate_nano_aiu AS nano_aiu FROM budget_holds WHERE ${holdWhere.join(" AND ")}`,
      )
      .all(range.startMs, end, ...holds.values),
  ])
  return [...eventRows, ...holdRows]
    .map((row) => spendRowOf(row))
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
}

function spendRowOf(row: unknown): SpendRow {
  const record =
    typeof row === "object" && row !== null ?
      (row as Record<string, unknown>)
    : {}
  return { createdAtMs: Number(record.at_ms), nanoAiu: Number(record.nano_aiu) }
}

/** When the scope's oldest cost in the range was incurred, or undefined
 *  when it incurred none. */
export async function getOldestSpendMs(
  scope: SpendScope,
  range: SpendRange,
): Promise<number | undefined> {
  const rows = await getNanoAiuSpendRows(scope, range)
  return rows.length === 0 ? undefined : rows[0].createdAtMs
}
