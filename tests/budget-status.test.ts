import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test"

import type { BudgetConfig } from "~/lib/budget/schema"

import { buildBudgetStatus } from "~/lib/budget/status"
import { BudgetStatusResponse } from "~/lib/config/settings-types"
import { requestContext } from "~/lib/http/request-context"
import { closeUsageStore, recordTokenUsageEvent } from "~/lib/token-usage"
import { getNanoAiuSpend } from "~/lib/token-usage/spend"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const NOW = Date.parse("2026-11-10T12:00:00Z") // a Tuesday
const AIU = 1_000_000_000

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
})

afterEach(async () => {
  setSystemTime()
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

interface Spend {
  at: string
  nanoAiu: number
  endpoint?: "messages" | "images" | "provider_messages"
  apiKeyLabel?: string
  userAgent?: string
  providerName?: string
}

function spend(entry: Spend): void {
  setSystemTime(new Date(entry.at))
  const endpoint = entry.endpoint ?? "messages"
  const provider = endpoint === "provider_messages"
  requestContext.run(
    {
      parentSessionId: undefined,
      sessionAffinity: undefined,
      startTime: Date.parse(entry.at),
      traceId: `trace-${entry.at}`,
      usage: { apiKeyLabel: entry.apiKeyLabel },
      userAgent: entry.userAgent ?? "test",
    },
    () => {
      recordTokenUsageEvent({
        endpoint,
        input_tokens: 10,
        model: provider ? "claude-test" : "gpt-test",
        source: provider ? "provider" : "copilot",
        providerName: entry.providerName,
        total_nano_aiu: entry.nanoAiu,
      })
    },
  )
  setSystemTime()
}

function seed(): void {
  // Last month: outside a daily/weekly period, inside "never".
  spend({ at: "2026-10-20T10:00:00Z", nanoAiu: 5 * AIU, apiKeyLabel: "codex" })
  // Monday this week.
  spend({ at: "2026-11-09T10:00:00Z", nanoAiu: 2 * AIU, apiKeyLabel: "codex" })
  // Today.
  spend({ at: "2026-11-10T08:00:00Z", nanoAiu: AIU, apiKeyLabel: "codex" })
  spend({
    at: "2026-11-10T09:00:00Z",
    nanoAiu: AIU / 2,
    endpoint: "images",
    apiKeyLabel: "my laptop",
  })
  spend({ at: "2026-11-10T10:00:00Z", nanoAiu: AIU / 4 }) // no key, unknown UA
  spend({
    at: "2026-11-10T11:00:00Z",
    nanoAiu: AIU / 8,
    userAgent: "claude-cli/2.1.0 (external, cli)",
  })
  spend({
    at: "2026-11-10T11:30:00Z",
    nanoAiu: 3 * AIU,
    endpoint: "provider_messages",
    providerName: "anthropic",
  })
}

describe("spend per scope", () => {
  const today = {
    startMs: Date.parse("2026-11-10T00:00:00Z"),
    endMs: Date.parse("2026-11-11T00:00:00Z"),
  }
  const lifetime = { startMs: 0, endMs: null }

  test("sums nano-AIU per scope and per range in one call", async () => {
    seed()
    const cases: Array<
      [Parameters<typeof getNanoAiuSpend>[0], number, number]
    > = [
      // scope, today, lifetime
      [{ kind: "global" }, 4.875 * AIU, 11.875 * AIU],
      [{ kind: "key", id: "codex" }, AIU, 8 * AIU],
      [{ kind: "key", id: "my laptop" }, AIU / 2, AIU / 2],
      [{ kind: "key", id: "claude-code" }, AIU / 8, AIU / 8],
      [{ kind: "key", id: "unidentified" }, 3.25 * AIU, 3.25 * AIU],
      [{ kind: "plugin", id: "images" }, AIU / 2, AIU / 2],
      [{ kind: "provider", id: "copilot" }, 1.875 * AIU, 8.875 * AIU],
      [{ kind: "provider", id: "anthropic" }, 3 * AIU, 3 * AIU],
      [{ kind: "provider", id: "nobody" }, 0, 0],
    ]
    for (const [scope, expectedToday, expectedLifetime] of cases) {
      expect(await getNanoAiuSpend(scope, [today, lifetime])).toEqual([
        expectedToday,
        expectedLifetime,
      ])
    }
  })

  test("no ranges, no query", async () => {
    expect(await getNanoAiuSpend({ kind: "global" }, [])).toEqual([])
  })
})

describe("budget status", () => {
  const budget: BudgetConfig = {
    limits: [
      {
        id: "codex-weekly",
        scope: { kind: "key", id: "codex" },
        limit: 4 * AIU,
        limitReset: "weekly",
        warnAt: 0.5,
        action: "block",
      },
      {
        id: "everything",
        label: "Everything",
        scope: { kind: "global" },
        limit: 20 * AIU,
        limitReset: { follow: "copilot:premium_interactions" },
        action: "warn",
      },
      {
        id: "images-daily",
        scope: { kind: "plugin", id: "images" },
        limit: AIU / 2,
        limitReset: "daily",
        warnAt: 0.8,
        action: "block",
      },
      {
        id: "copilot-lifetime",
        scope: { kind: "provider", id: "copilot" },
        limit: 100 * AIU,
        limitReset: "never",
        action: "block",
      },
    ],
  }
  const windows = [
    {
      provider: "copilot",
      id: "premium_interactions",
      label: "Copilot premium allowance",
      unit: "credits",
      percentRemaining: 80,
      resetsAt: "2026-12-01T00:00:00.000Z",
      previousResetsAt: "2026-11-01T00:00:00.000Z",
      kind: "fixed" as const,
      overage: { permitted: false },
      observedAt: "2026-11-10T11:00:00.000Z",
      source: "header" as const,
    },
  ]

  test("reports each limit's period, spend and state in the contract", async () => {
    seed()
    const status = await buildBudgetStatus(budget, { nowMs: NOW, windows })
    expect(BudgetStatusResponse.safeParse(status).success).toBe(true)

    expect(status.display).toEqual({ unit: "usd", credit_usd: 0.01 })
    expect(status.storage_enabled).toBe(true)
    expect(status.budgets.map((entry) => entry.id)).toEqual([
      "everything",
      "copilot-lifetime",
      "images-daily",
      "codex-weekly",
    ])
    const byId = new Map(status.budgets.map((entry) => [entry.id, entry]))

    expect(byId.get("everything")).toMatchObject({
      label: "Everything",
      warn_at: 0.8,
      usage: 6.875 * AIU, // since Nov 1
      period_start: "2026-11-01T00:00:00.000Z",
      resets_at: "2026-12-01T00:00:00.000Z",
      reset_basis: "provider",
      reset_estimated: false,
      state: "ok",
    })
    expect(byId.get("codex-weekly")).toMatchObject({
      usage: 3 * AIU,
      usage_daily: AIU,
      usage_weekly: 3 * AIU,
      limit_remaining: AIU,
      period_start: "2026-11-09T00:00:00.000Z",
      resets_at: "2026-11-16T00:00:00.000Z",
      state: "warning",
    })
    expect(byId.get("images-daily")).toMatchObject({
      usage: AIU / 2,
      limit_remaining: 0,
      state: "exhausted",
    })
    expect(byId.get("copilot-lifetime")).toMatchObject({
      usage: 8.875 * AIU,
      period_start: "1970-01-01T00:00:00.000Z",
      resets_at: null,
      state: "ok",
    })
    expect(byId.get("codex-weekly")?.display.limit_remaining).toBeCloseTo(
      0.01,
      12,
    )

    // A spent blocking limit wins over the one with the least room.
    expect(status.effective_budget).toBe("images-daily")

    expect(status.provider_windows).toEqual([
      {
        provider: "copilot",
        id: "premium_interactions",
        label: "Copilot premium allowance",
        unit: "credits",
        used: null,
        limit: null,
        percent_remaining: 80,
        resets_at: "2026-12-01T00:00:00.000Z",
        previous_resets_at: "2026-11-01T00:00:00.000Z",
        kind: "fixed",
        duration_ms: null,
        scope: null,
        overage: { used: null, permitted: false },
        observed_at: "2026-11-10T11:00:00.000Z",
        source: "header",
      },
    ])
  })

  test("a followed window not yet reported falls back to daily", async () => {
    seed()
    const status = await buildBudgetStatus(budget, { nowMs: NOW, windows: [] })
    expect(status.budgets[0]).toMatchObject({
      id: "everything",
      usage: 4.875 * AIU,
      period_start: "2026-11-10T00:00:00.000Z",
      resets_at: "2026-11-11T00:00:00.000Z",
      reset_basis: "fallback",
      reset_estimated: true,
    })
  })

  test("effective budget: least room among blocking limits; none without one", async () => {
    seed()
    const withoutSpent = {
      limits: (budget.limits ?? []).filter(
        (limit) => limit.id !== "images-daily",
      ),
    }
    const status = await buildBudgetStatus(withoutSpent, {
      nowMs: NOW,
      windows,
    })
    expect(status.effective_budget).toBe("codex-weekly")

    const warnOnly = await buildBudgetStatus(
      { limits: [{ ...(budget.limits ?? [])[1] }] },
      { nowMs: NOW, windows },
    )
    expect(warnOnly.effective_budget).toBeNull()

    const empty = await buildBudgetStatus(undefined, {
      nowMs: NOW,
      windows: [],
    })
    expect(empty).toMatchObject({ budgets: [], effective_budget: null })
  })

  test("display amounts follow the unit and the creditUsd override", async () => {
    seed()
    const limit = (budget.limits ?? [])[0]
    const credits = await buildBudgetStatus(
      { display: { unit: "credits" }, limits: [limit] },
      { nowMs: NOW, windows: [] },
    )
    expect(credits.display).toEqual({ unit: "credits", credit_usd: 0.01 })
    expect(credits.budgets[0].display).toEqual({
      limit: 4,
      usage: 3,
      limit_remaining: 1,
    })

    const override = await buildBudgetStatus(
      { display: { creditUsd: 0.02 }, limits: [limit] },
      { nowMs: NOW, windows: [] },
    )
    expect(override.display).toEqual({ unit: "usd", credit_usd: 0.02 })
    expect(override.budgets[0].display.limit).toBeCloseTo(0.08, 12)
    expect(override.budgets[0].display.usage).toBeCloseTo(0.06, 12)
    // Stored amounts never change with the display.
    expect(override.budgets[0].limit).toBe(4 * AIU)
  })
})
