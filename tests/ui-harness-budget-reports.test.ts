import { describe, expect, test } from "bun:test"

import {
  budgetLimitsSeed,
  createBudgetMock,
} from "../scripts/ui-harness-budget"
import { BudgetActivityResponse } from "../src/lib/config/settings-types"

const BASE = "http://harness.invalid/settings/api/budget"

function request(path: string): Request {
  return new Request(`${BASE}${path}`)
}

type Row = BudgetActivityResponse["rows"][number]

function sumOf(rows: Array<Row>, pick: (row: Row) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0)
}

async function activityOf(
  mock: ReturnType<typeof createBudgetMock>,
  query: string,
) {
  const response = await mock.handle(request(`/activity?${query}`))
  expect(response?.status).toBe(200)
  return BudgetActivityResponse.parse(await response?.json())
}

describe("the Budget mock's reports", () => {
  test("activity takes any range, and every group, with the Dashboard's token measures", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    for (const range of ["24h", "7d", "30d", "90d", "all"] as const) {
      for (const group of [
        "model",
        "plugin",
        "key",
        "provider",
        "day",
        "hour",
      ]) {
        const activity = await activityOf(
          mock,
          `range=${range}&group=${group}&include_free=true`,
        )
        expect(activity.range?.label).toBe(range)
        expect(activity.totals).toBeDefined()
        // The rows add up to the totals once nothing is left out.

        expect(sumOf(activity.rows, (row) => row.requests)).toBe(
          activity.totals?.request_count ?? -1,
        )
        expect(sumOf(activity.rows, (row) => row.nano_aiu)).toBe(
          activity.totals?.total_nano_aiu ?? -1,
        )
        expect(sumOf(activity.rows, (row) => row.total_tokens ?? 0)).toBe(
          activity.totals?.total_tokens ?? -1,
        )
      }
    }
  })

  test("a custom range is half-open, and hours are UTC keys oldest first", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const to = new Date()
    to.setUTCHours(0, 0, 0, 0)
    const from = new Date(to.getTime() - 3 * 86_400_000)
    const activity = await activityOf(
      mock,
      `from=${from.toISOString()}&to=${to.toISOString()}&group=hour`,
    )
    expect(activity.range?.label).toBe("custom")
    const keys = activity.rows.map((row) => row.key ?? "")
    expect(keys).toEqual([...keys].sort())
    expect(
      keys.every((key) => /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/u.test(key)),
    ).toBe(true)
    expect(
      keys.every((key) => key >= from.toISOString() && key < to.toISOString()),
    ).toBe(true)
    // The ledger spreads a day over the working hours, so a day is far more than one row.
    expect(keys.length).toBeGreaterThan(24)
  })

  test("a model that spent nothing is listed only when asked for", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const without = await activityOf(mock, "range=7d&group=model")
    const withFree = await activityOf(
      mock,
      "range=7d&group=model&include_free=true",
    )
    expect(without.rows.some((row) => row.nano_aiu === 0)).toBe(false)
    const free = withFree.rows.find((row) => row.nano_aiu === 0)
    expect(free?.key).toBe("gpt-5-mini")
    expect(free?.total_tokens).toBeGreaterThan(0)
  })

  test("a range with from, to and range at once is a 400", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const both = await mock.handle(
      request("/activity?range=7d&from=2026-11-01T00:00:00Z&group=model"),
    )
    expect(both?.status).toBe(400)
  })
})
