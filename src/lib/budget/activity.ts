/**
 * Spend by model, plugin, key, provider or day over today, this week or this
 * month, for the Budget window's Activity view. Periods start at 00:00 UTC
 * (weeks on Monday, months on the 1st), like the fixed limit resets.
 */

import type { BudgetActivityResponse } from "~/lib/config/settings-types"

import { getNanoAiuActivity, type ActivityGroup } from "~/lib/token-usage/spend"

import type { BudgetConfig } from "./schema"

import { startOfUtcDay, startOfUtcWeek } from "./periods"
import { nanoAiuToDisplay, resolveBudgetDisplay } from "./units"

export type ActivityPeriod = "day" | "week" | "month"

export function activityStartMs(period: ActivityPeriod, nowMs: number): number {
  if (period === "day") return startOfUtcDay(nowMs)
  if (period === "week") return startOfUtcWeek(nowMs)
  const now = new Date(nowMs)
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
}

export async function buildBudgetActivity(
  budget: BudgetConfig | undefined,
  query: { period: ActivityPeriod; group: ActivityGroup; nowMs?: number },
): Promise<BudgetActivityResponse> {
  const startMs = activityStartMs(query.period, query.nowMs ?? Date.now())
  const display = resolveBudgetDisplay(budget)
  const rows = await getNanoAiuActivity(query.group, startMs)
  return {
    period: query.period,
    group: query.group,
    period_start: new Date(startMs).toISOString(),
    display: { unit: display.unit, credit_usd: display.creditUsd },
    rows: rows.map((row) => ({
      key: row.key,
      nano_aiu: row.nanoAiu,
      requests: row.requests,
      amount: nanoAiuToDisplay(row.nanoAiu, display),
    })),
  }
}

function csvCell(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** The activity as CSV: `<group>,nano_aiu,requests,amount_<unit>`, the amount
 *  in the display unit. */
export function activityCsv(activity: BudgetActivityResponse): string {
  const lines = [
    `${activity.group},nano_aiu,requests,amount_${activity.display.unit}`,
  ]
  for (const row of activity.rows) {
    lines.push(
      [csvCell(row.key ?? ""), row.nano_aiu, row.requests, row.amount].join(
        ",",
      ),
    )
  }
  return `${lines.join("\n")}\n`
}

export { type ActivityGroup } from "~/lib/token-usage/spend"
