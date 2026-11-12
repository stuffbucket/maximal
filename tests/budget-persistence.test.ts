/**
 * The budget across a restart: spend and holds live in the token-usage
 * database under the test sandbox's temp `COPILOT_API_HOME`, so a service
 * built after the usage store is closed and reopened sees what the first one
 * did. Also the migration that adds `budget_holds` to a pre-budget database.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import consola from "consola"
import path from "node:path"

import type { BudgetConfig } from "~/lib/budget/schema"

import {
  findProviderWindow,
  listProviderWindows,
  __resetProviderWindowsForTests,
} from "~/lib/budget/provider-windows"
import { createBudgetService, type BudgetService } from "~/lib/budget/service"
import { createUsageDbBudgetStore } from "~/lib/budget/store"
import { PATHS } from "~/lib/platform/paths"
import { openSqliteDatabase } from "~/lib/platform/sqlite"
import {
  closeUsageStore,
  onTokenUsageEvent,
  recordTokenUsageEvent,
} from "~/lib/token-usage"
import { getNanoAiuSpend } from "~/lib/token-usage/spend"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const AIU = 1_000_000_000
const NOON = Date.UTC(2026, 10, 11, 12, 0, 0)

const config: BudgetConfig = {
  limits: [
    {
      id: "all",
      scope: { kind: "global" },
      limit: AIU,
      limitReset: "never",
      action: "block",
    },
  ],
}

let dbPath = ""
let running: Array<BudgetService> = []

/** A service wired like the app's, on the real store, with a fixed clock. */
function startService(): BudgetService {
  const service = createBudgetService({
    clock: () => NOON,
    config: () => config,
    store: createUsageDbBudgetStore(),
    windows: {
      lookup: (ref) => findProviderWindow(ref),
      ready: async () => {
        await listProviderWindows()
      },
    },
    spendEvents: (listener) =>
      onTokenUsageEvent((row) => {
        listener({
          createdAtMs: row.created_at_ms,
          nanoAiu: row.total_nano_aiu,
          key: "unidentified",
          provider: "copilot",
        })
      }),
  })
  running.push(service)
  return service
}

/** The process stops: the usage store is flushed and closed. */
async function restart(): Promise<void> {
  for (const service of running) service.stop()
  running = []
  await closeUsageStore()
  __resetProviderWindowsForTests()
}

function spendRow(nanoAiu: number): void {
  recordTokenUsageEvent({
    endpoint: "images",
    model: "gpt-image-test",
    source: "copilot",
    input_tokens: 1,
    total_nano_aiu: nanoAiu,
  })
}

const intent = (estimateNanoAiu: number) => ({
  operation: "images.generations" as const,
  key: "unidentified",
  provider: "copilot",
  plugin: "images",
  estimateNanoAiu,
})

beforeEach(async () => {
  consola.level = 1
  dbPath = path.join(PATHS.APP_DIR, `budget-${crypto.randomUUID()}.sqlite`)
  process.env[DB_PATH_ENV] = dbPath
  await closeUsageStore()
  __resetProviderWindowsForTests()
})

afterEach(async () => {
  consola.level = 3
  await restart()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

describe("across a restart", () => {
  test("spend recorded before the restart still counts against the limit", async () => {
    const before = startService()
    expect((await before.check(intent(0))).ok).toBe(true)
    spendRow(AIU)
    expect((await before.check(intent(0))).ok).toBe(false)

    await restart()
    const after = startService()
    const decision = await after.check(intent(0))

    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.refusal.used).toBe(AIU)
  })

  test("a call in progress when the app died counts at its estimate", async () => {
    const before = startService()
    const decision = await before.reserve(intent(0.6 * AIU))
    expect(decision.ok).toBe(true)
    // No commit, no release: the process is gone.

    await restart()
    const after = startService()
    const next = await after.check(intent(0.6 * AIU))

    expect(next.ok).toBe(false)
    if (next.ok) return
    expect(next.refusal.used).toBe(0.6 * AIU)
    // It is spend now, not a hold: it won't clear by itself.
    expect(next.refusal.held).toBe(0)
    expect(next.refusal.inFlight).toBe(false)
  })

  test("a call that finished before the restart isn't counted twice", async () => {
    const before = startService()
    const decision = await before.reserve(intent(0.6 * AIU))
    if (!decision.ok) throw new Error("expected admission")
    spendRow(0.5 * AIU)
    decision.hold.commit({ nanoAiu: 0.5 * AIU })

    await restart()
    const after = startService()
    const next = await after.check(intent(0.4 * AIU))

    expect(next.ok).toBe(true)
  })

  test("a released hold leaves no trace", async () => {
    const before = startService()
    const decision = await before.reserve(intent(0.9 * AIU))
    if (!decision.ok) throw new Error("expected admission")
    decision.hold.release("upstream-error")

    await restart()
    const after = startService()

    expect((await after.check(intent(0.9 * AIU))).ok).toBe(true)
  })
})

describe("the budget_holds migration", () => {
  test("adds the table to a database from before budgets, keeping its rows", async () => {
    spendRow(0.25 * AIU)
    await closeUsageStore()
    // Take the table away and roll the version back, as an older build left it.
    const old = await openSqliteDatabase(dbPath)
    old.exec("DROP TABLE budget_holds")
    old.exec("PRAGMA user_version = 4")
    old.close?.()

    const service = startService()
    const decision = await service.reserve(intent(0.5 * AIU))

    expect(decision.ok).toBe(true)
    const [sum] = await getNanoAiuSpend({ kind: "global" }, [
      { startMs: 0, endMs: null },
    ])
    expect(sum).toBe(0.25 * AIU)
    await restart()
    const after = await openSqliteDatabase(dbPath)
    const version = after.prepare("PRAGMA user_version").get() as {
      user_version: number
    }
    const holds = after
      .prepare("SELECT state, estimate_nano_aiu FROM budget_holds")
      .all()
    after.close?.()
    expect(version.user_version).toBeGreaterThanOrEqual(5)
    expect(holds).toEqual([{ state: "open", estimate_nano_aiu: 0.5 * AIU }])
  })
})
