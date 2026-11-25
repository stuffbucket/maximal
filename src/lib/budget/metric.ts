/**
 * What a limit measures: nano-AIU of cost, or tokens (input, output or
 * total). Pure helpers over a usage row, so the ledger and the database
 * count the same thing.
 *
 * Tokens come from the usage row's columns: input is `input_tokens` plus
 * `cache_read_input_tokens` (a cached prompt is still a prompt), output is
 * `output_tokens`, total is their sum. Cache-creation tokens are not counted.
 */

import type { BudgetLimitConfig } from "./schema"

/** What a limit's `limit`, spend and holds are in. */
export type SpendMetric =
  | "input_tokens"
  | "nano_aiu"
  | "output_tokens"
  | "total_tokens"

/** What a refusal's figures are in: a metric, or a count of requests. */
export type RefusalUnit = SpendMetric | "requests"

export function metricOf(
  limit: Pick<BudgetLimitConfig, "measure" | "unit">,
): SpendMetric {
  if (limit.unit !== "tokens") return "nano_aiu"
  return `${limit.measure ?? "total"}_tokens`
}

/** The columns of a usage row a metric reads. */
export interface MetricRow {
  nanoAiu: number
  inputTokens: number
  outputTokens: number
}

export function amountOf(row: MetricRow, metric: SpendMetric): number {
  if (metric === "nano_aiu") return row.nanoAiu
  if (metric === "input_tokens") return row.inputTokens
  if (metric === "output_tokens") return row.outputTokens
  return row.inputTokens + row.outputTokens
}

/** A call's estimate in every unit it can be asked in. */
export type Estimate = MetricRow

/** SQL for the amount of a usage row, summed by the spend queries. */
export const EVENT_METRIC_SQL: Record<SpendMetric, string> = {
  nano_aiu: "total_nano_aiu",
  input_tokens: "(input_tokens + cache_read_input_tokens)",
  output_tokens: "output_tokens",
  total_tokens: "(input_tokens + cache_read_input_tokens + output_tokens)",
}

/** The same over `budget_holds`' estimate columns. */
export const HOLD_METRIC_SQL: Record<SpendMetric, string> = {
  nano_aiu: "estimate_nano_aiu",
  input_tokens: "est_input_tokens",
  output_tokens: "est_output_tokens",
  total_tokens: "(est_input_tokens + est_output_tokens)",
}
