/**
 * Spend (nano-AIU) per budget scope: the rows of `token_usage_events`, plus
 * the estimates of holds a crash left `orphaned` (`budget_holds`), which are
 * counted because the call they reserved for may have been billed.
 */

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

const SCOPE_SQL: Record<Exclude<SpendScope["kind"], "global">, string> = {
  key: "COALESCE(client_label, CASE client WHEN 'other' THEN 'unidentified' ELSE client END) = ?",
  plugin: "plugin_id = ?",
  provider:
    "(CASE source WHEN 'copilot' THEN 'copilot' ELSE COALESCE(provider_name, '') END) = ?",
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
  const where = ["created_at_ms >= ?"]
  const whereValues: Array<string | number> = [
    Math.min(...ranges.map((range) => range.startMs)),
  ]
  if (scope.kind !== "global") {
    where.push(SCOPE_SQL[scope.kind])
    whereValues.push(scope.id)
  }
  const holdSums = ranges.map(
    (_, index) =>
      `COALESCE(SUM(CASE WHEN created_at_ms >= ? AND created_at_ms < ? THEN estimate_nano_aiu ELSE 0 END), 0) AS spend_${index}`,
  )
  const holdWhere = ["state = 'orphaned'", "created_at_ms >= ?"]
  if (scope.kind !== "global") holdWhere.push(HOLD_SCOPE_SQL[scope.kind])
  const holdWhereValues = [...whereValues]
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

/** How activity rows are grouped. */
export type ActivityGroup = "model" | "plugin" | "key" | "provider" | "day"

const GROUP_SQL: Record<ActivityGroup, string> = {
  model: "model",
  plugin: "plugin_id",
  key: "COALESCE(client_label, CASE client WHEN 'other' THEN 'unidentified' ELSE client END)",
  provider:
    "CASE source WHEN 'copilot' THEN 'copilot' ELSE COALESCE(provider_name, '') END",
  day: "strftime('%Y-%m-%d', created_at_ms / 1000, 'unixepoch')",
}

export interface ActivityRow {
  /** The group's value; null for rows with none (no plugin, say). */
  key: string | null
  nanoAiu: number
  requests: number
}

/** Spend and request count since `sinceMs`, grouped, biggest spender first
 *  (by day: oldest first). Rows that spent nothing are left out. Empty when
 *  storage is off. */
export async function getNanoAiuActivity(
  group: ActivityGroup,
  sinceMs: number,
): Promise<Array<ActivityRow>> {
  if (!isTokenUsageStorageEnabled()) return []
  const expression = GROUP_SQL[group]
  const order = group === "day" ? "group_key ASC" : "nano_aiu DESC, group_key"
  const rows = await readUsageDb((db) =>
    db
      .prepare(
        `SELECT ${expression} AS group_key, COALESCE(SUM(total_nano_aiu), 0) AS nano_aiu, COUNT(*) AS requests
         FROM token_usage_events WHERE created_at_ms >= ?
         GROUP BY group_key HAVING nano_aiu > 0 ORDER BY ${order}`,
      )
      .all(sinceMs),
  )
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    key: typeof row.group_key === "string" ? row.group_key : null,
    nanoAiu: Number(row.nano_aiu),
    requests: Number(row.requests),
  }))
}
