/**
 * Usage by model, plugin, key, provider, day or hour over any range, for the
 * Rules window's Activity view: the same measures the Dashboard shows
 * (requests, input, output and cache tokens, cost), from the same SQL
 * (`~/lib/token-usage/aggregate`). Periods and ranges start and end on UTC
 * boundaries (weeks on Monday, months on the 1st), like the fixed limit
 * resets.
 */

import type { BudgetActivityResponse } from "~/lib/config/settings-types"
import type { UsageGroup } from "~/lib/token-usage/aggregate"

import type { UsageRange } from "./reports/range"
import type { BudgetConfig } from "./schema"

import { getUsageByGroup, getUsageTotals } from "./reports/usage"
import { nanoAiuToDisplay, resolveBudgetDisplay } from "./units"

export type ActivityGroup = UsageGroup

export async function buildBudgetActivity(
  budget: BudgetConfig | undefined,
  query: { range: UsageRange; group: ActivityGroup; includeFree?: boolean },
): Promise<BudgetActivityResponse> {
  const { range, group } = query
  const display = resolveBudgetDisplay(budget)
  const [rows, totals] = await Promise.all([
    getUsageByGroup(group, range, { includeFree: query.includeFree === true }),
    getUsageTotals(range),
  ])
  return {
    period:
      (
        range.label === "day"
        || range.label === "week"
        || range.label === "month"
      ) ?
        range.label
      : "range",
    group,
    period_start: new Date(range.fromMs).toISOString(),
    display: { unit: display.unit, credit_usd: display.creditUsd },
    range: {
      from: new Date(range.fromMs).toISOString(),
      to: new Date(range.toMs).toISOString(),
      label: range.label,
    },
    totals,
    rows: rows.map((row) => ({
      key: row.key,
      nano_aiu: row.total_nano_aiu,
      requests: row.request_count,
      amount: nanoAiuToDisplay(row.total_nano_aiu, display),
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_input_tokens: row.cache_read_input_tokens,
      cache_creation_input_tokens: row.cache_creation_input_tokens,
      total_tokens: row.total_tokens,
    })),
  }
}

function csvCell(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** The activity as CSV:
 *  `<group>,nano_aiu,requests,amount_<unit>,input_tokens,output_tokens,`
 *  `cache_read_input_tokens,cache_creation_input_tokens,total_tokens`, the
 *  amount in the display unit. */
export function activityCsv(activity: BudgetActivityResponse): string {
  const lines = [
    `${activity.group},nano_aiu,requests,amount_${activity.display.unit},input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,total_tokens`,
  ]
  for (const row of activity.rows) {
    lines.push(
      [
        csvCell(row.key ?? ""),
        row.nano_aiu,
        row.requests,
        row.amount,
        row.input_tokens ?? 0,
        row.output_tokens ?? 0,
        row.cache_read_input_tokens ?? 0,
        row.cache_creation_input_tokens ?? 0,
        row.total_tokens ?? 0,
      ].join(","),
    )
  }
  return `${lines.join("\n")}\n`
}
