/**
 * Spend (nano-AIU) per budget scope, summed from `token_usage_events`.
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
  const row = await readUsageDb((db) =>
    db
      .prepare(
        `SELECT ${sums.join(", ")} FROM token_usage_events WHERE ${where.join(" AND ")}`,
      )
      .get(...rangeValues, ...whereValues),
  )
  return ranges.map((_, index) => {
    const value =
      typeof row === "object" && row !== null ?
        (row as Record<string, unknown>)[`spend_${index}`]
      : undefined
    return typeof value === "number" && Number.isFinite(value) ? value : 0
  })
}
