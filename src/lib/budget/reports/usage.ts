/**
 * Reads of `token_usage_events` for the budget reports: usage grouped over
 * any range (the Activity view), its totals, and the raw rows a limit's
 * timeline and simulation replay. The measures come from the same SQL the
 * Dashboard's summary uses (`~/lib/token-usage/aggregate`).
 *
 * Every read waits for queued usage writes, so a row recorded a moment ago is
 * included. With no usage database each read is empty.
 */

import type { TokenUsageTotals } from "~/lib/token-usage/store"

import {
  emptyTotals,
  totalsFromRow,
  USAGE_GROUP_SQL,
  USAGE_TOTALS_SELECT,
  type UsageGroup,
} from "~/lib/token-usage/aggregate"
import { scopeWhere, type SpendScope } from "~/lib/token-usage/spend"
import {
  isTokenUsageStorageEnabled,
  readUsageDb,
} from "~/lib/token-usage/store"

import type { UsageRange } from "./range"

export interface UsageGroupRow extends TokenUsageTotals {
  /** The group's value; null for rows with none (no plugin, say). */
  key: string | null
}

export interface UsageQueryOptions {
  /** Keep groups that spent nothing (the Dashboard lists free models);
   *  the Activity view leaves them out by default. */
  includeFree?: boolean
}

/** Usage per group over the range. Biggest spender first (ties by key);
 *  by day or hour, oldest first. */
export async function getUsageByGroup(
  group: UsageGroup,
  range: UsageRange,
  options: UsageQueryOptions = {},
): Promise<Array<UsageGroupRow>> {
  if (!isTokenUsageStorageEnabled()) return []
  const chronological = group === "day" || group === "hour"
  const order =
    chronological ? "group_key ASC" : "SUM(total_nano_aiu) DESC, group_key"
  const having =
    options.includeFree === true ? "" : "HAVING SUM(total_nano_aiu) > 0"
  const rows = await readUsageDb((db) =>
    db
      .prepare(
        `SELECT ${USAGE_GROUP_SQL[group]} AS group_key, ${USAGE_TOTALS_SELECT}
         FROM token_usage_events
         WHERE created_at_ms >= ? AND created_at_ms < ?
         GROUP BY group_key ${having} ORDER BY ${order}`,
      )
      .all(range.fromMs, range.toMs),
  )
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    ...totalsFromRow(row),
    key: typeof row.group_key === "string" ? row.group_key : null,
  }))
}

/** Everything the range recorded, whatever it cost: the Dashboard's totals. */
export async function getUsageTotals(
  range: UsageRange,
): Promise<TokenUsageTotals> {
  if (!isTokenUsageStorageEnabled()) return emptyTotals()
  const row = await readUsageDb((db) =>
    db
      .prepare(
        `SELECT ${USAGE_TOTALS_SELECT} FROM token_usage_events
         WHERE created_at_ms >= ? AND created_at_ms < ?`,
      )
      .get(range.fromMs, range.toMs),
  )
  return totalsFromRow(row as Record<string, unknown> | undefined)
}

/** One recorded request, as a limit's replay reads it. */
export interface SpendRow {
  createdAtMs: number
  nanoAiu: number
}

/** The scope's rows in `[fromMs, toMs)`, oldest first. */
export async function getSpendRows(
  scope: SpendScope,
  fromMs: number,
  toMs: number,
): Promise<Array<SpendRow>> {
  if (!isTokenUsageStorageEnabled()) return []
  const events = scopeWhere(scope, "events")
  const where = ["created_at_ms >= ?", "created_at_ms < ?", ...events.clauses]
  const values: Array<string | number> = [fromMs, toMs, ...events.values]
  const rows = await readUsageDb((db) =>
    db
      .prepare(
        `SELECT created_at_ms, total_nano_aiu FROM token_usage_events
         WHERE ${where.join(" AND ")} ORDER BY created_at_ms ASC, id ASC`,
      )
      .all(...values),
  )
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    createdAtMs: Number(row.created_at_ms),
    nanoAiu: Number(row.total_nano_aiu),
  }))
}

/** When the oldest recorded request happened; null with no usage. */
export async function getFirstUsageMs(): Promise<number | null> {
  if (!isTokenUsageStorageEnabled()) return null
  const row = await readUsageDb((db) =>
    db
      .prepare("SELECT MIN(created_at_ms) AS first_ms FROM token_usage_events")
      .get(),
  )
  const value = (row as Record<string, unknown> | undefined)?.first_ms
  return typeof value === "number" ? value : null
}
