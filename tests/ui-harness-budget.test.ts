import { describe, expect, test } from "bun:test"

import {
  budgetEmptySeed,
  budgetLimitsSeed,
  budgetNoLimitsSeed,
  budgetOffSeed,
  budgetStorageOffSeed,
  createBudgetMock,
} from "../scripts/ui-harness-budget"
import {
  BudgetActivityResponse,
  BudgetStatusResponse,
} from "../src/lib/config/settings-types"

const BASE = "http://harness.invalid/settings/api/budget"

function request(path: string, init?: RequestInit): Request {
  return new Request(`${BASE}${path}`, init)
}

function send(path: string, method: string, body: unknown): Request {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function statusOf(mock: ReturnType<typeof createBudgetMock>) {
  const response = await mock.handle(request(""))
  return BudgetStatusResponse.parse(await response?.json())
}

describe("the Budget mock service", () => {
  test("every seed answers with the wire contract", () => {
    for (const seed of [
      budgetLimitsSeed,
      budgetOffSeed,
      budgetEmptySeed,
      budgetStorageOffSeed,
    ]) {
      const mock = createBudgetMock(seed)
      expect(BudgetStatusResponse.safeParse(mock.status()).success).toBe(true)
      for (const group of ["model", "plugin", "key", "provider", "day"]) {
        for (const period of ["day", "week", "month"]) {
          expect(
            BudgetActivityResponse.safeParse(mock.activity(period, group))
              .success,
          ).toBe(true)
        }
      }
    }
  })

  test("the seeded limits show each state, widest scope first", () => {
    const { budgets, effective_budget } =
      createBudgetMock(budgetLimitsSeed).status()
    expect(budgets.map((limit) => limit.scope.kind)).toEqual([
      "global",
      "plugin",
      "key",
      "key",
    ])
    expect(budgets.map((limit) => limit.state)).toEqual([
      "ok",
      "warning",
      "ok",
      "exhausted",
    ])
    // A spent blocking limit is the one a request would hit first.
    expect(effective_budget).toBe("key-codex-weekly")
    // A limit that follows the provider's window resets when the window does.
    const followed = budgets.find((limit) => limit.id === "everything")
    expect(followed?.reset_basis).toBe("provider")
    expect(followed?.resets_at).toBe(
      createBudgetMock(budgetLimitsSeed).status().provider_windows[0]
        ?.resets_at,
    )
  })

  test("a first run has no limits, no provider windows and nothing spent", () => {
    const mock = createBudgetMock(budgetEmptySeed)
    const status = mock.status()
    expect(status.budgets).toEqual([])
    expect(status.provider_windows).toEqual([])
    expect(mock.activity("month", "model").rows).toEqual([])
  })

  test("without a usage database nothing is spent and the status says so", () => {
    const mock = createBudgetMock(budgetStorageOffSeed)
    expect(mock.status().storage_enabled).toBe(false)
    expect(mock.status().budgets.every((limit) => limit.usage === 0)).toBe(true)
    expect(mock.activity("week", "key").rows).toEqual([])
  })

  test("creating a limit works out its spend and announces the change", async () => {
    const mock = createBudgetMock(budgetNoLimitsSeed)
    const heard: Array<number> = []
    mock.onChange((status) => heard.push(status.budgets.length))
    const response = await mock.handle(
      send("/limits/everything-daily", "PUT", {
        scope: { kind: "global" },
        amount: 1,
        limit_reset: "daily",
        action: "block",
      }),
    )
    expect(response?.status).toBe(200)
    const created = BudgetStatusResponse.parse(
      await response?.json(),
    ).budgets.find((limit) => limit.id === "everything-daily")
    // $1.00 is 100 AI credits; the amount comes back in the display unit.
    expect(created?.limit).toBe(100_000_000_000)
    expect(created?.display.limit).toBeCloseTo(1)
    expect(created?.warn_at).toBe(0.8)
    expect(created?.usage).toBeGreaterThan(0)
    expect(heard).toEqual([1])
  })

  test("replacing a limit keeps one row; deleting removes it; an unknown id is a 404", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const before = (await statusOf(mock)).budgets.length
    await mock.handle(
      send("/limits/key-codex-weekly", "PUT", {
        scope: { kind: "key", id: "codex" },
        amount: 100,
        limit_reset: "weekly",
        warn_at: 0.5,
        action: "warn",
      }),
    )
    const replaced = (await statusOf(mock)).budgets
    expect(replaced).toHaveLength(before)
    expect(
      replaced.find((limit) => limit.id === "key-codex-weekly"),
    ).toMatchObject({ state: "ok", action: "warn", warn_at: 0.5 })

    const removed = await mock.handle(
      request("/limits/key-codex-weekly", { method: "DELETE" }),
    )
    expect(removed?.status).toBe(200)
    expect((await statusOf(mock)).budgets).toHaveLength(before - 1)
    const missing = await mock.handle(
      request("/limits/key-codex-weekly", { method: "DELETE" }),
    )
    expect(missing?.status).toBe(404)
  })

  test("a bad limit id or body is a 400 validation_error, like the real route", async () => {
    const mock = createBudgetMock(budgetEmptySeed)
    const badId = await mock.handle(
      send("/limits/Bad%20Id", "PUT", {
        scope: { kind: "global" },
        amount: 1,
        limit_reset: "daily",
        action: "block",
      }),
    )
    expect(badId?.status).toBe(400)
    const noAmount = await mock.handle(
      send("/limits/ok", "PUT", {
        scope: { kind: "global" },
        limit_reset: "daily",
        action: "block",
      }),
    )
    expect(noAmount?.status).toBe(400)
    expect(
      ((await noAmount?.json()) as { error: { type: string } }).error.type,
    ).toBe("validation_error")
  })

  test("the on/off switch and the display unit change what the status reports", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    await mock.handle(
      send("", "PATCH", { enabled: false, display_unit: "credits" }),
    )
    const status = await statusOf(mock)
    expect(status.enabled).toBe(false)
    expect(status.display.unit).toBe("credits")
    const codex = status.budgets.find(
      (limit) => limit.id === "key-codex-weekly",
    )
    // In credits the figures are 100 times the dollar amounts.
    expect(codex?.display.limit).toBeCloseTo((codex?.limit ?? 0) / 1e9)
    expect((await mock.handle(send("", "PATCH", {})))?.status).toBe(400)
  })

  test("activity groups the same spend every way, and rows that spent nothing are left out", () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const totals = (group: string): number =>
      mock
        .activity("month", group)
        .rows.reduce((sum, row) => sum + row.nano_aiu, 0)
    const model = totals("model")
    expect(model).toBeGreaterThan(0)
    for (const group of ["plugin", "key", "provider", "day"])
      expect(totals(group)).toBe(model)
    const rows = mock.activity("month", "model").rows
    expect(rows.every((row) => row.nano_aiu > 0)).toBe(true)
    expect(rows.map((row) => row.nano_aiu)).toEqual(
      rows.map((row) => row.nano_aiu).sort((a, b) => b - a),
    )
    // Spend outside any plugin has no plugin to name.
    expect(
      mock.activity("month", "plugin").rows.some((row) => row.key === null),
    ).toBe(true)
    // Days run oldest first.
    const days = mock.activity("month", "day").rows.map((row) => row.key)
    expect(days).toEqual([...days].sort())
  })

  test("a longer period holds at least the spend of a shorter one", () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const total = (period: string): number =>
      mock
        .activity(period, "provider")
        .rows.reduce((sum, row) => sum + row.nano_aiu, 0)
    expect(total("week")).toBeGreaterThanOrEqual(total("day"))
  })

  test("the CSV is the activity rows with a header, quoting what needs it", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    const response = await mock.handle(
      request("/activity.csv?period=week&group=model"),
    )
    expect(response?.headers.get("content-type")).toContain("text/csv")
    expect(response?.headers.get("content-disposition")).toContain(
      "maximal-budget-model-week.csv",
    )
    const lines = (await response?.text())?.trimEnd().split("\n") ?? []
    expect(lines[0]).toStartWith("model,nano_aiu,requests,amount_usd,input_")
    expect(lines).toHaveLength(mock.activity("week", "model").rows.length + 1)
  })

  test("an unknown period or group is a 400, and other paths are not the Budget's", async () => {
    const mock = createBudgetMock(budgetLimitsSeed)
    expect(
      (await mock.handle(request("/activity?period=year&group=model")))?.status,
    ).toBe(400)
    expect(
      (await mock.handle(request("/activity?period=day&group=colour")))?.status,
    ).toBe(400)
    expect(
      await mock.handle(
        new Request("http://harness.invalid/settings/api/models"),
      ),
    ).toBeNull()
  })
})
