/**
 * Spend (nano-AIU) per budget scope: the rows of `token_usage_events`, plus
 * the estimates of holds a crash left `orphaned` (`budget_holds`), which are
 * counted because the call they reserved for may have been billed.
 */

import { globToSqlite } from "~/lib/budget/glob"
import {
  EVENT_METRIC_SQL,
  HOLD_METRIC_SQL,
  type SpendMetric,
} from "~/lib/budget/metric"
import { KEY_SQL, PROVIDER_SQL } from "~/lib/token-usage/aggregate"
import {
  isTokenUsageStorageEnabled,
  readUsageDb,
} from "~/lib/token-usage/store"

/** What a filter's members are matched against. */
export type MemberField = "model" | "key" | "plugin"

/** The rows a budget scope covers. A key is the API key's label, else the
 *  client recognised from the user agent, else `unidentified`; a provider is
 *  `copilot` or the configured provider's name; `members` rows whose model,
 *  key or plugin matches any of the globs. */
export type SpendScope =
  | { kind: "global" }
  | { kind: "key" | "plugin" | "provider"; id: string }
  | { kind: "members"; field: MemberField; members: ReadonlyArray<string> }

/** A scope as a `WHERE` fragment over `token_usage_events`, one `?` for the
 *  scope's id. */
export const SCOPE_SQL: Record<"key" | "plugin" | "provider", string> = {
  key: `${KEY_SQL} = ?`,
  plugin: "plugin_id = ?",
  provider: `(${PROVIDER_SQL}) = ?`,
}

/** The same scopes over `budget_holds`' columns. */
const HOLD_SCOPE_SQL: Record<"key" | "plugin" | "provider", string> = {
  key: "client_key = ?",
  plugin: "plugin_id = ?",
  provider: "provider = ?",
}

const MEMBER_COLUMN: Record<MemberField, string> = {
  model: "model",
  key: KEY_SQL,
  plugin: "plugin_id",
}

const HOLD_MEMBER_COLUMN: Record<MemberField, string> = {
  model: "model",
  key: "client_key",
  plugin: "plugin_id",
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

/** The WHERE clauses that pick a scope's rows, over the usage rows
 *  (`events`) or the holds. A filter with no members selects nothing. */
export function scopeWhere(
  scope: SpendScope,
  table: "events" | "holds",
): { clauses: Array<string>; values: Array<string | number> } {
  if (scope.kind === "global") return { clauses: [], values: [] }
  if (scope.kind === "members") {
    if (scope.members.length === 0) return { clauses: ["0"], values: [] }
    const column = (table === "events" ? MEMBER_COLUMN : HOLD_MEMBER_COLUMN)[
      scope.field
    ]
    return {
      clauses: [
        `(${scope.members.map(() => `${column} GLOB ?`).join(" OR ")})`,
      ],
      values: scope.members.map((member) => globToSqlite(member)),
    }
  }
  const sql = table === "events" ? SCOPE_SQL : HOLD_SCOPE_SQL
  return { clauses: [sql[scope.kind]], values: [scope.id] }
}

/** Total spend and the unreconciled subset in each range. */
export interface SpendBreakdown {
  usage: Array<number>
  unreconciled: Array<number>
}

/** What the scope's rows spent in each range, with unreconciled hold estimates
 *  returned separately. Both arrays are zeros when storage is off. */
export async function getSpendBreakdown(
  scope: SpendScope,
  ranges: ReadonlyArray<SpendRange>,
  metric: SpendMetric = "nano_aiu",
): Promise<SpendBreakdown> {
  if (ranges.length === 0) return { usage: [], unreconciled: [] }
  if (!isTokenUsageStorageEnabled()) {
    const zeros = ranges.map(() => 0)
    return { usage: zeros, unreconciled: [...zeros] }
  }

  const sums = (expression: string): Array<string> =>
    ranges.map(
      (_, index) =>
        `COALESCE(SUM(CASE WHEN created_at_ms >= ? AND created_at_ms < ? THEN ${expression} ELSE 0 END), 0) AS spend_${index}`,
    )
  const rangeValues = ranges.flatMap((range) => [
    range.startMs,
    range.endMs ?? Number.MAX_SAFE_INTEGER,
  ])
  const earliest = Math.min(...ranges.map((range) => range.startMs))
  const events = scopeWhere(scope, "events")
  const holds = scopeWhere(scope, "holds")
  const eventWhere = ["created_at_ms >= ?", ...events.clauses]
  const holdWhere = [
    "state = 'orphaned'",
    "created_at_ms >= ?",
    ...holds.clauses,
  ]
  const [eventRow, holdRow] = await readUsageDb((db) => [
    db
      .prepare(
        `SELECT ${sums(EVENT_METRIC_SQL[metric]).join(", ")} FROM token_usage_events WHERE ${eventWhere.join(" AND ")}`,
      )
      .get(...rangeValues, earliest, ...events.values),
    db
      .prepare(
        `SELECT ${sums(HOLD_METRIC_SQL[metric]).join(", ")} FROM budget_holds WHERE ${holdWhere.join(" AND ")}`,
      )
      .get(...rangeValues, earliest, ...holds.values),
  ])
  const unreconciled = ranges.map((_, index) => readSpend(holdRow, index))
  return {
    usage: ranges.map(
      (_, index) => readSpend(eventRow, index) + unreconciled[index],
    ),
    unreconciled,
  }
}

/** What the scope's rows spent in each range, in one database read (nano-AIU,
 *  or the tokens of `metric`); zeros when storage is off. */
export async function getNanoAiuSpend(
  scope: SpendScope,
  ranges: ReadonlyArray<SpendRange>,
  metric: SpendMetric = "nano_aiu",
): Promise<Array<number>> {
  return (await getSpendBreakdown(scope, ranges, metric)).usage
}

/** The unreconciled subset of spend: estimates retained for dispatched calls
 * whose final provider charge was not established. */
export async function getUnreconciledSpend(
  scope: SpendScope,
  ranges: ReadonlyArray<SpendRange>,
  metric: SpendMetric = "nano_aiu",
): Promise<Array<number>> {
  return (await getSpendBreakdown(scope, ranges, metric)).unreconciled
}

/** One cost the scope incurred at an instant, in the unit asked for
 *  (nano-AIU, or the tokens of a metric). */
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
  metric: SpendMetric = "nano_aiu",
): Promise<Array<SpendRow>> {
  if (!isTokenUsageStorageEnabled()) return []
  const end = range.endMs ?? Number.MAX_SAFE_INTEGER
  const events = scopeWhere(scope, "events")
  const holds = scopeWhere(scope, "holds")
  const eventWhere = [
    "created_at_ms >= ?",
    "created_at_ms < ?",
    `${EVENT_METRIC_SQL[metric]} > 0`,
    ...events.clauses,
  ]
  const holdWhere = [
    "state = 'orphaned'",
    "created_at_ms >= ?",
    "created_at_ms < ?",
    `${HOLD_METRIC_SQL[metric]} > 0`,
    ...holds.clauses,
  ]
  const [eventRows, holdRows] = await readUsageDb((db) => [
    db
      .prepare(
        `SELECT created_at_ms AS at_ms, ${EVENT_METRIC_SQL[metric]} AS nano_aiu FROM token_usage_events WHERE ${eventWhere.join(" AND ")}`,
      )
      .all(range.startMs, end, ...events.values),
    db
      .prepare(
        `SELECT created_at_ms AS at_ms, ${HOLD_METRIC_SQL[metric]} AS nano_aiu FROM budget_holds WHERE ${holdWhere.join(" AND ")}`,
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
  metric: SpendMetric = "nano_aiu",
): Promise<number | undefined> {
  const rows = await getNanoAiuSpendRows(scope, range, metric)
  return rows.length === 0 ? undefined : rows[0].createdAtMs
}

/** When each request the scope's usage rows recorded in the range was made,
 *  oldest first, whatever it cost. Empty when storage is off. */
export async function getRequestTimes(
  scope: SpendScope,
  range: SpendRange,
): Promise<Array<number>> {
  if (!isTokenUsageStorageEnabled()) return []
  const events = scopeWhere(scope, "events")
  const where = ["created_at_ms >= ?", "created_at_ms < ?", ...events.clauses]
  const rows = await readUsageDb((db) =>
    db
      .prepare(
        `SELECT created_at_ms AS at_ms FROM token_usage_events WHERE ${where.join(" AND ")} ORDER BY created_at_ms ASC`,
      )
      .all(
        range.startMs,
        range.endMs ?? Number.MAX_SAFE_INTEGER,
        ...events.values,
      ),
  )
  return (rows as Array<Record<string, unknown>>).map((row) =>
    Number(row.at_ms),
  )
}
