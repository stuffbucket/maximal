/**
 * The SQL and row mapping behind every aggregate of `token_usage_events`: the
 * Dashboard's summary (`getTokenUsageSummary`) and the Budget window's
 * activity (`~/lib/budget/reports/usage`) both select the same measures with
 * `USAGE_TOTALS_SELECT` and read them with `totalsFromRow`, so the two cannot
 * disagree on what a request, a token or a cost is.
 *
 * Pure: nothing here opens the database.
 */

import type { TokenUsageTotals } from "./store"

/** The Dashboard's measures, summed over whatever rows the query selects. */
export const USAGE_TOTALS_SELECT = `
  COUNT(*) AS request_count,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
  COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
  COALESCE(SUM(total_tokens), 0) AS total_tokens,
  COALESCE(SUM(total_nano_aiu), 0) AS total_nano_aiu`

/** A usage row's client key: the API key's label, else the client Maximal
 *  recognised, else `unidentified` (`budgetKeyOf`). */
export const KEY_SQL =
  "COALESCE(client_label, CASE client WHEN 'other' THEN 'unidentified' ELSE client END)"

/** The provider that billed a usage row: `copilot`, or the configured
 *  provider's name. */
export const PROVIDER_SQL =
  "CASE source WHEN 'copilot' THEN 'copilot' ELSE COALESCE(provider_name, '') END"

/** How usage is grouped. `day` and `hour` are UTC, like budget periods. */
export type UsageGroup =
  | "day"
  | "hour"
  | "key"
  | "model"
  | "plugin"
  | "provider"

export const USAGE_GROUP_SQL: Record<UsageGroup, string> = {
  model: "model",
  plugin: "plugin_id",
  key: KEY_SQL,
  provider: PROVIDER_SQL,
  day: "strftime('%Y-%m-%d', created_at_ms / 1000, 'unixepoch')",
  hour: "strftime('%Y-%m-%dT%H:00:00Z', created_at_ms / 1000, 'unixepoch')",
}

export function numberFromRow(
  row: Record<string, unknown> | undefined,
  key: string,
): number {
  const value = row?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function emptyTotals(): TokenUsageTotals {
  return {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    request_count: 0,
    total_tokens: 0,
    total_nano_aiu: 0,
  }
}

export function totalsFromRow(
  row: Record<string, unknown> | undefined,
): TokenUsageTotals {
  return {
    cache_creation_input_tokens: numberFromRow(
      row,
      "cache_creation_input_tokens",
    ),
    cache_read_input_tokens: numberFromRow(row, "cache_read_input_tokens"),
    input_tokens: numberFromRow(row, "input_tokens"),
    output_tokens: numberFromRow(row, "output_tokens"),
    request_count: numberFromRow(row, "request_count"),
    total_tokens: numberFromRow(row, "total_tokens"),
    total_nano_aiu: numberFromRow(row, "total_nano_aiu"),
  }
}
