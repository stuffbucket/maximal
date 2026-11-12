/**
 * The budget reports over the real usage database: Activity at parity with
 * the Dashboard's summary, any range, the limit timeline with its refusal
 * markers, and the `budget_events` log (written by the service, and added by
 * a migration to an older database).
 *
 * Real config and usage store (the preload gives each run a temp
 * `COPILOT_API_HOME`); nothing is module-mocked.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test"
import consola from "consola"
import { Hono } from "hono"
import path from "node:path"

import type { BudgetConfig } from "~/lib/budget/schema"

import {
  findProviderWindow,
  listProviderWindows,
  __resetProviderWindowsForTests,
} from "~/lib/budget/provider-windows"
import { getBudgetEvents, recordBudgetEvent } from "~/lib/budget/reports/events"
import { __resetBudgetServiceForTests } from "~/lib/budget/runtime"
import { createBudgetService, type BudgetService } from "~/lib/budget/service"
import { createUsageDbBudgetStore } from "~/lib/budget/store"
import { writeConfig } from "~/lib/config/config"
import {
  BudgetActivityResponse,
  BudgetTimelineResponse,
} from "~/lib/config/settings-types"
import { PATHS } from "~/lib/platform/paths"
import { openSqliteDatabase } from "~/lib/platform/sqlite"
import {
  closeUsageStore,
  getTokenUsageSummary,
  onTokenUsageEvent,
  recordTokenUsageEvent,
  type TokenUsageEventInput,
} from "~/lib/token-usage"
import { budgetRoutes } from "~/routes/settings/budget"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const AIU = 1_000_000_000
const at = (...parts: [number, number, number, number?, number?]): number =>
  Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] ?? 0, parts[4] ?? 0)
/** Wednesday 2026-11-11 12:00 UTC. */
const NOW = at(2026, 11, 11, 12)

let dbPath = ""
let running: Array<BudgetService> = []

function buildApp(): Hono {
  const app = new Hono()
  app.route("/budget", budgetRoutes)
  return app
}

/** Record a usage row as if it happened at `ms`. */
function recordAt(
  ms: number,
  row: Partial<TokenUsageEventInput> & { total_nano_aiu?: number },
): void {
  setSystemTime(new Date(ms))
  recordTokenUsageEvent({
    endpoint: "messages",
    model: "gpt-test",
    source: "copilot",
    input_tokens: 1,
    ...row,
  })
  setSystemTime(new Date(NOW))
}

type UsageRow = BudgetActivityResponse["rows"][number]

function sumOf(
  rows: ReadonlyArray<UsageRow>,
  pick: (row: UsageRow) => number | undefined,
): number {
  return rows.reduce((total, row) => total + (pick(row) ?? 0), 0)
}

async function json<T>(
  response: Response,
  parse: (v: unknown) => T,
): Promise<T> {
  expect(response.status).toBe(200)
  return parse(await response.json())
}

beforeEach(async () => {
  consola.level = 1
  dbPath = path.join(PATHS.APP_DIR, `reports-${crypto.randomUUID()}.sqlite`)
  process.env[DB_PATH_ENV] = dbPath
  await closeUsageStore()
  __resetProviderWindowsForTests()
  __resetBudgetServiceForTests()
  writeConfig({})
  setSystemTime(new Date(NOW))
})

afterEach(async () => {
  consola.level = 3
  setSystemTime()
  for (const service of running) service.stop()
  running = []
  __resetBudgetServiceForTests()
  await closeUsageStore()
  __resetProviderWindowsForTests()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

afterAll(() => {
  writeConfig({})
})

/** Rows across models, keys, plugins, providers, hours and days, with
 *  cache tokens and a free model. */
function recordFixture(): void {
  recordAt(at(2026, 11, 9, 8, 15), {
    model: "claude-big",
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 300,
    total_nano_aiu: 4 * AIU,
  })
  recordAt(at(2026, 11, 9, 8, 45), {
    model: "claude-big",
    input_tokens: 10,
    output_tokens: 2,
    total_nano_aiu: AIU,
  })
  recordAt(at(2026, 11, 10, 22, 0), {
    model: "gpt-free",
    input_tokens: 50,
    output_tokens: 50,
    total_nano_aiu: 0,
  })
  recordAt(at(2026, 11, 10, 23, 30), {
    endpoint: "images",
    model: "gpt-image",
    input_tokens: 7,
    total_nano_aiu: 2 * AIU,
  })
  recordAt(at(2026, 11, 11, 9, 5), {
    endpoint: "provider_messages",
    source: "provider",
    providerName: "openrouter",
    model: "other-model",
    input_tokens: 30,
    output_tokens: 3,
    total_nano_aiu: 3 * AIU,
  })
  // Before the 7-day window.
  recordAt(at(2026, 10, 1, 12), {
    model: "claude-big",
    input_tokens: 1,
    total_nano_aiu: 9 * AIU,
  })
}

describe("activity at parity with the Dashboard", () => {
  test("by model, every measure equals the Dashboard summary's over the same range", async () => {
    recordFixture()
    const summary = await getTokenUsageSummary("month")
    const query = new URLSearchParams({
      group: "model",
      from: new Date(summary.range.start_ms).toISOString(),
      to: new Date(summary.range.end_ms).toISOString(),
      include_free: "true",
    })

    const body = await json(
      await buildApp().request(`/budget/activity?${query.toString()}`),
      (v) => BudgetActivityResponse.parse(v),
    )

    expect(body.totals).toEqual(summary.totals)
    expect(body.rows).toHaveLength(summary.byModel.length)
    for (const model of summary.byModel) {
      const row = body.rows.find((r) => r.key === model.model)
      expect(row).toEqual({
        key: model.model,
        nano_aiu: model.total_nano_aiu,
        requests: model.request_count,
        amount: model.total_nano_aiu / AIU / 100,
        input_tokens: model.input_tokens,
        output_tokens: model.output_tokens,
        cache_read_input_tokens: model.cache_read_input_tokens,
        cache_creation_input_tokens: model.cache_creation_input_tokens,
        total_tokens: model.total_tokens,
      })
    }
    // The fixture's cache tokens made it through, and the free model is listed.
    expect(body.totals?.cache_read_input_tokens).toBe(5000)
    expect(body.rows.some((r) => r.key === "gpt-free")).toBe(true)
  })

  test("the groups' rows each sum to the totals", async () => {
    recordFixture()
    for (const group of ["model", "plugin", "key", "provider", "day", "hour"]) {
      const body = await json(
        await buildApp().request(
          `/budget/activity?group=${group}&range=all&include_free=true`,
        ),
        (v) => BudgetActivityResponse.parse(v),
      )
      expect(sumOf(body.rows, (r) => r.requests)).toBe(
        body.totals?.request_count ?? -1,
      )
      expect(sumOf(body.rows, (r) => r.nano_aiu)).toBe(
        body.totals?.total_nano_aiu ?? -1,
      )
      expect(sumOf(body.rows, (r) => r.input_tokens)).toBe(
        body.totals?.input_tokens ?? -1,
      )
      expect(sumOf(body.rows, (r) => r.cache_read_input_tokens)).toBe(
        body.totals?.cache_read_input_tokens ?? -1,
      )
      expect(sumOf(body.rows, (r) => r.total_tokens)).toBe(
        body.totals?.total_tokens ?? -1,
      )
    }
  })
})

describe("GET /settings/api/budget/activity over a range", () => {
  test("range=7d leaves out older rows; range=all has them", async () => {
    recordFixture()
    const app = buildApp()
    const week = await json(
      await app.request("/budget/activity?group=model&range=7d"),
      (v) => BudgetActivityResponse.parse(v),
    )
    const all = await json(
      await app.request("/budget/activity?group=model&range=all"),
      (v) => BudgetActivityResponse.parse(v),
    )

    expect(week.period).toBe("range")
    expect(week.range?.label).toBe("7d")
    expect(week.rows.find((r) => r.key === "claude-big")?.nano_aiu).toBe(
      5 * AIU,
    )
    expect(all.rows.find((r) => r.key === "claude-big")?.nano_aiu).toBe(
      14 * AIU,
    )
    expect(all.range?.from).toBe(new Date(0).toISOString())
  })

  test("from/to pick an exact window, to exclusive", async () => {
    recordFixture()
    const query = new URLSearchParams({
      group: "model",
      from: new Date(at(2026, 11, 9, 8, 15)).toISOString(),
      to: new Date(at(2026, 11, 9, 8, 45)).toISOString(),
    })

    const body = await json(
      await buildApp().request(`/budget/activity?${query.toString()}`),
      (v) => BudgetActivityResponse.parse(v),
    )

    expect(body.range?.label).toBe("custom")
    expect(body.rows).toMatchObject([{ key: "claude-big", requests: 1 }])
  })

  test("groups by hour and by day, oldest first, in UTC", async () => {
    recordFixture()
    const app = buildApp()
    const hours = await json(
      await app.request("/budget/activity?group=hour&range=7d"),
      (v) => BudgetActivityResponse.parse(v),
    )
    const days = await json(
      await app.request("/budget/activity?group=day&range=7d"),
      (v) => BudgetActivityResponse.parse(v),
    )

    expect(hours.rows.map((r) => r.key)).toEqual([
      "2026-11-09T08:00:00Z",
      "2026-11-10T23:00:00Z",
      "2026-11-11T09:00:00Z",
    ])
    expect(days.rows.map((r) => [r.key, r.nano_aiu])).toEqual([
      ["2026-11-09", 5 * AIU],
      ["2026-11-10", 2 * AIU],
      ["2026-11-11", 3 * AIU],
    ])
  })

  test("by provider and plugin, with the group's token measures", async () => {
    recordFixture()
    const app = buildApp()
    const providers = await json(
      await app.request("/budget/activity?group=provider&range=7d"),
      (v) => BudgetActivityResponse.parse(v),
    )
    expect(providers.rows.map((r) => [r.key, r.nano_aiu])).toEqual([
      ["copilot", 7 * AIU],
      ["openrouter", 3 * AIU],
    ])
    const plugins = await json(
      await app.request("/budget/activity?group=plugin&range=7d"),
      (v) => BudgetActivityResponse.parse(v),
    )
    expect(plugins.rows.find((r) => r.key === "images")).toMatchObject({
      requests: 1,
      input_tokens: 7,
    })
  })

  test("the original period query still works and echoes it", async () => {
    recordFixture()
    const body = await json(
      await buildApp().request("/budget/activity?period=week&group=model"),
      (v) => BudgetActivityResponse.parse(v),
    )
    expect(body.period).toBe("week")
    expect(body.period_start).toBe(new Date(at(2026, 11, 9)).toISOString())
    expect(body.rows.find((r) => r.key === "claude-big")?.nano_aiu).toBe(
      5 * AIU,
    )
  })

  test("a free model is left out unless include_free", async () => {
    recordFixture()
    const app = buildApp()
    const without = await json(
      await app.request("/budget/activity?group=model&range=7d"),
      (v) => BudgetActivityResponse.parse(v),
    )
    expect(without.rows.some((r) => r.key === "gpt-free")).toBe(false)
    expect(without.totals?.request_count).toBe(5)
  })

  test("rejects a bad range, hour group typo and conflicting forms", async () => {
    const app = buildApp()
    for (const query of [
      "range=year",
      "range=7d&from=2026-11-01",
      "from=nonsense",
      "group=week",
    ]) {
      expect((await app.request(`/budget/activity?${query}`)).status).toBe(400)
    }
  })

  test("the CSV covers the same range and names it in the file", async () => {
    recordFixture()
    const response = await buildApp().request(
      "/budget/activity.csv?group=provider&range=30d",
    )
    expect(response.headers.get("content-disposition")).toContain(
      "maximal-budget-provider-30d.csv",
    )
    const lines = (await response.text()).trim().split("\n")
    expect(lines[0].startsWith("provider,nano_aiu,requests,amount_usd,")).toBe(
      true,
    )
    expect(lines[1].startsWith(`copilot,${7 * AIU},`)).toBe(true)
  })
})

const dailyCap: BudgetConfig = {
  limits: [
    {
      id: "daily-cap",
      scope: { kind: "global" },
      limit: 10 * AIU,
      limitReset: "daily",
      warnAt: 0.8,
      action: "block",
    },
  ],
}

describe("GET /settings/api/budget/limits/:id/timeline", () => {
  test("buckets, cumulative spend, limit lines and crossing markers", async () => {
    writeConfig({ budget: dailyCap })
    recordAt(at(2026, 11, 9, 8), { total_nano_aiu: 6 * AIU })
    recordAt(at(2026, 11, 9, 20), { total_nano_aiu: 5 * AIU })
    recordAt(at(2026, 11, 10, 8), { total_nano_aiu: 3 * AIU })

    const body = await json(
      await buildApp().request("/budget/limits/daily-cap/timeline?range=7d"),
      (v) => BudgetTimelineResponse.parse(v),
    )

    expect(body.range.bucket).toBe("day")
    expect(body.limit).toMatchObject({
      id: "daily-cap",
      limit: 10 * AIU,
      warn_line: 8 * AIU,
      warn_at: 0.8,
    })
    expect(body.limit.display).toEqual({ limit: 0.1, warn_line: 0.08 })
    expect(body.buckets).toHaveLength(8)
    expect(body.buckets[0].start).toBe(new Date(at(2026, 11, 4)).toISOString())
    const spent = body.buckets.filter((b) => b.nano_aiu > 0)
    expect(
      spent.map((b) => [
        b.start.slice(0, 10),
        b.nano_aiu,
        b.cumulative_nano_aiu,
      ]),
    ).toEqual([
      ["2026-11-09", 11 * AIU, 11 * AIU],
      ["2026-11-10", 3 * AIU, 3 * AIU],
    ])
    expect(body.markers.map((m) => [m.kind, m.at])).toEqual([
      ["warned", new Date(at(2026, 11, 9, 20)).toISOString()],
      ["crossed", new Date(at(2026, 11, 9, 20)).toISOString()],
    ])
    expect(body.totals).toMatchObject({
      nano_aiu: 14 * AIU,
      requests: 3,
      refused: 0,
      periods_crossed: 1,
    })
    expect(body.periods).toHaveLength(8)
    expect(body.periods.at(-1)).toMatchObject({
      start: new Date(at(2026, 11, 11)).toISOString(),
      end: new Date(at(2026, 11, 12)).toISOString(),
      estimated: false,
    })
  })

  test("the limit's own scope decides which rows count", async () => {
    writeConfig({
      budget: {
        limits: [
          {
            id: "images-only",
            scope: { kind: "plugin", id: "images" },
            limit: 10 * AIU,
            limitReset: "never",
            action: "warn",
          },
        ],
      },
    })
    recordAt(at(2026, 11, 10, 8), { total_nano_aiu: 6 * AIU })
    recordAt(at(2026, 11, 10, 9), {
      endpoint: "images",
      model: "gpt-image",
      total_nano_aiu: 4 * AIU,
    })
    recordAt(at(2026, 10, 1), {
      endpoint: "images",
      model: "gpt-image",
      total_nano_aiu: 5 * AIU,
    })

    const body = await json(
      await buildApp().request("/budget/limits/images-only/timeline?range=7d"),
      (v) => BudgetTimelineResponse.parse(v),
    )

    // A lifetime limit counts the older 5 AIU too, so the 4 AIU reaches 9.
    expect(body.totals.nano_aiu).toBe(4 * AIU)
    expect(body.buckets.find((b) => b.nano_aiu > 0)?.cumulative_nano_aiu).toBe(
      9 * AIU,
    )
    expect(body.periods).toMatchObject([{ end: null, spend_nano_aiu: 9 * AIU }])
    expect(body.markers.map((m) => m.kind)).toEqual(["warned"])
  })

  test("refusals logged by the service appear as markers and counts", async () => {
    writeConfig({ budget: dailyCap })
    recordAt(at(2026, 11, 11, 8), { total_nano_aiu: 10 * AIU })
    const service = startService(dailyCap, at(2026, 11, 11, 9))
    const intent = {
      operation: "messages" as const,
      key: "claude-code",
      provider: "copilot",
      estimateNanoAiu: 0,
    }
    expect((await service.check(intent)).ok).toBe(false)
    expect((await service.check(intent)).ok).toBe(false)

    const body = await json(
      await buildApp().request(
        "/budget/limits/daily-cap/timeline?range=24h&bucket=hour",
      ),
      (v) => BudgetTimelineResponse.parse(v),
    )

    expect(body.totals.refused).toBe(2)
    expect(body.buckets.find((b) => b.refused > 0)?.start).toBe(
      new Date(at(2026, 11, 11, 9)).toISOString(),
    )
    expect(body.markers.find((m) => m.kind === "refused")).toMatchObject({
      count: 2,
      estimate_nano_aiu: 0,
    })
    expect(body.periods.at(-1)?.refused).toBe(2)
  })
})

describe("GET /settings/api/budget/limits/:id/timeline, edge cases", () => {
  test("an unknown limit is a 404; a bad range or bucket is a 400", async () => {
    writeConfig({ budget: dailyCap })
    const app = buildApp()
    expect((await app.request("/budget/limits/nope/timeline")).status).toBe(404)
    for (const query of ["range=year", "bucket=minute", "from=x"]) {
      expect(
        (await app.request(`/budget/limits/daily-cap/timeline?${query}`))
          .status,
      ).toBe(400)
    }
  })

  test("too many buckets asks for a coarser one", async () => {
    writeConfig({ budget: dailyCap })
    const response = await buildApp().request(
      "/budget/limits/daily-cap/timeline?range=90d&bucket=hour",
    )
    expect(response.status).toBe(400)
  })

  test("range=all starts at the first recorded row", async () => {
    writeConfig({ budget: dailyCap })
    recordAt(at(2026, 10, 20, 8), { total_nano_aiu: AIU })
    const body = await json(
      await buildApp().request("/budget/limits/daily-cap/timeline?range=all"),
      (v) => BudgetTimelineResponse.parse(v),
    )
    expect(body.range).toMatchObject({
      from: new Date(at(2026, 10, 20)).toISOString(),
      label: "all",
      bucket: "day",
    })
    expect(body.buckets).toHaveLength(23)
  })

  test("with no usage at all, range=all is a day of empty buckets", async () => {
    writeConfig({ budget: dailyCap })
    const body = await json(
      await buildApp().request("/budget/limits/daily-cap/timeline?range=all"),
      (v) => BudgetTimelineResponse.parse(v),
    )
    expect(body.totals.nano_aiu).toBe(0)
    expect(body.buckets.length).toBeGreaterThan(0)
  })

  test("a lifetime limit that crossed before the range reads as crossed at the range start", async () => {
    writeConfig({
      budget: {
        limits: [
          {
            id: "lifetime",
            scope: { kind: "global" },
            limit: 10 * AIU,
            limitReset: "never",
            action: "block",
          },
        ],
      },
    })
    recordAt(at(2026, 9, 1), { total_nano_aiu: 11 * AIU })
    recordAt(at(2026, 11, 10, 3), { total_nano_aiu: AIU })

    const body = await json(
      await buildApp().request("/budget/limits/lifetime/timeline?range=7d"),
      (v) => BudgetTimelineResponse.parse(v),
    )

    expect(body.periods[0].crossed_at).toBe(
      new Date(at(2026, 11, 4)).toISOString(),
    )
    expect(body.buckets.at(-1)?.cumulative_nano_aiu).toBe(12 * AIU)
  })

  test("a rolling limit reads as one open window whose spend ages out", async () => {
    writeConfig({
      budget: {
        limits: [
          {
            id: "rolling",
            scope: { kind: "global" },
            limit: 10 * AIU,
            limitReset: { every: { hours: 5 } },
            action: "block",
          },
        ],
      },
    })
    recordAt(at(2026, 11, 11, 3), { total_nano_aiu: 9 * AIU })
    recordAt(at(2026, 11, 11, 9), { total_nano_aiu: 2 * AIU })

    const body = await json(
      await buildApp().request("/budget/limits/rolling/timeline?range=24h"),
      (v) => BudgetTimelineResponse.parse(v),
    )

    expect(body.periods).toHaveLength(1)
    expect(body.periods[0].end).toBeNull()
    const at9 = body.buckets.find((b) => b.start.startsWith("2026-11-11T09"))
    expect(at9?.cumulative_nano_aiu).toBe(2 * AIU)
    const at7 = body.buckets.find((b) => b.start.startsWith("2026-11-11T07"))
    expect(at7?.cumulative_nano_aiu).toBe(9 * AIU)
    const at8 = body.buckets.find((b) => b.start.startsWith("2026-11-11T08"))
    expect(at8?.cumulative_nano_aiu).toBe(0)
    expect(body.markers.map((m) => m.kind)).toEqual(["warned"])
  })

  test("a followed window's earlier cycles are estimated", async () => {
    writeConfig({
      budget: {
        limits: [
          {
            id: "monthly",
            scope: { kind: "global" },
            limit: 10 * AIU,
            limitReset: { follow: "copilot:premium_interactions" },
            action: "warn",
          },
        ],
      },
    })
    recordAt(at(2026, 11, 3), { total_nano_aiu: AIU })

    const body = await json(
      await buildApp().request("/budget/limits/monthly/timeline?range=30d"),
      (v) => BudgetTimelineResponse.parse(v),
    )

    // No window reported: the limit falls back to daily, flagged estimated.
    expect(body.periods.every((p) => p.estimated)).toBe(true)
    expect(body.totals.nano_aiu).toBe(AIU)
  })
})

/** A service wired like the app's, logging events to the database. */
function startService(config: BudgetConfig, nowMs: number): BudgetService {
  const service = createBudgetService({
    clock: () => nowMs,
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
          key: "claude-code",
          provider: "copilot",
        })
      }),
    onEvent: recordBudgetEvent,
  })
  running.push(service)
  return service
}

const intent = (estimateNanoAiu: number) => ({
  operation: "images.generations" as const,
  key: "claude-code",
  provider: "copilot",
  plugin: "images",
  estimateNanoAiu,
})

const noWindows = { lookup: () => undefined, ready: () => Promise.resolve() }
function noop(): void {}
function noSpendEvents(): () => void {
  return noop
}

function failingHandler(): void {
  throw new Error("disk full")
}

describe("the budget_events log", () => {
  test("a refusal records the limit, scope, time, key and estimate", async () => {
    const service = startService(dailyCap, NOW)
    recordAt(at(2026, 11, 11, 1), { total_nano_aiu: 10 * AIU })

    const decision = await service.reserve(intent(2 * AIU))

    expect(decision.ok).toBe(false)
    const events = await getBudgetEvents({
      limitId: "daily-cap",
      fromMs: 0,
      toMs: NOW + 1,
    })
    expect(events).toEqual([
      {
        atMs: NOW,
        kind: "refused",
        limitId: "daily-cap",
        scope: { kind: "global" },
        key: "claude-code",
        operation: "images.generations",
        estimateNanoAiu: 2 * AIU,
        usedNanoAiu: 10 * AIU,
        limitNanoAiu: 10 * AIU,
      },
    ])
  })

  test("a warning is logged once per period; an admitted hold is logged as approved", async () => {
    const service = startService(dailyCap, NOW)
    recordAt(at(2026, 11, 11, 1), { total_nano_aiu: 8 * AIU })

    const first = await service.reserve(intent(AIU / 2))
    const second = await service.reserve(intent(AIU / 2))
    expect(first.ok && second.ok).toBe(true)

    const events = await getBudgetEvents({
      limitId: "daily-cap",
      fromMs: 0,
      toMs: NOW + 1,
    })
    expect(events.map((e) => e.kind)).toEqual([
      "approved",
      "warned",
      "approved",
    ])
    expect(events[1]).toMatchObject({
      usedNanoAiu: 8 * AIU,
      estimateNanoAiu: AIU / 2,
    })
  })

  test("a call with no estimate is not logged as approved", async () => {
    const service = startService(dailyCap, NOW)
    const decision = await service.reserve(intent(0))
    expect(decision.ok).toBe(true)
    expect(
      await getBudgetEvents({ limitId: "daily-cap", fromMs: 0, toMs: NOW + 1 }),
    ).toEqual([])
  })

  test("events are filtered by limit, kind and time", async () => {
    for (const [limitId, kind, atMs] of [
      ["a", "refused", 10],
      ["a", "warned", 20],
      ["b", "refused", 30],
      ["a", "refused", 40],
    ] as const) {
      recordBudgetEvent({
        kind,
        atMs,
        limitId,
        scope: { kind: "plugin", id: "images" },
        key: "k",
        operation: "messages",
        estimateNanoAiu: 1,
        usedNanoAiu: 2,
        limitNanoAiu: 3,
      })
    }
    const refused = await getBudgetEvents({
      limitId: "a",
      kind: "refused",
      fromMs: 0,
      toMs: 40,
    })
    expect(refused.map((e) => e.atMs)).toEqual([10])
    expect(refused[0].scope).toEqual({ kind: "plugin", id: "images" })
    expect(
      (await getBudgetEvents({ limitId: "a", fromMs: 15, toMs: 100 })).map(
        (e) => e.kind,
      ),
    ).toEqual(["warned", "refused"])
  })

  test("a failing event handler never fails the call", async () => {
    const service = createBudgetService({
      clock: () => NOW,
      config: () => dailyCap,
      store: createUsageDbBudgetStore(),
      windows: noWindows,
      spendEvents: noSpendEvents,
      onEvent: failingHandler,
    })
    running.push(service)
    expect((await service.reserve(intent(AIU))).ok).toBe(true)
  })
})

describe("the budget_events migration", () => {
  test("adds the table to a database from before it, keeping its rows", async () => {
    recordAt(at(2026, 11, 10), { total_nano_aiu: AIU })
    await closeUsageStore()
    const old = await openSqliteDatabase(dbPath)
    old.exec("DROP TABLE budget_events")
    old.exec("PRAGMA user_version = 5")
    old.close?.()

    recordBudgetEvent({
      kind: "refused",
      atMs: NOW,
      limitId: "daily-cap",
      scope: { kind: "key", id: "claude-code" },
      key: "claude-code",
      operation: "messages",
      estimateNanoAiu: 0,
      usedNanoAiu: 10 * AIU,
      limitNanoAiu: 10 * AIU,
    })
    const events = await getBudgetEvents({
      limitId: "daily-cap",
      fromMs: 0,
      toMs: NOW + 1,
    })
    await closeUsageStore()

    const after = await openSqliteDatabase(dbPath)
    const version = after.prepare("PRAGMA user_version").get() as {
      user_version: number
    }
    const usage = after
      .prepare("SELECT COUNT(*) AS n FROM token_usage_events")
      .get() as {
      n: number
    }
    const columns = (
      after.prepare("PRAGMA table_info(budget_events)").all() as Array<{
        name: string
      }>
    ).map((c) => c.name)
    after.close?.()
    expect(version.user_version).toBeGreaterThanOrEqual(6)
    expect(usage.n).toBe(1)
    expect(columns).toEqual([
      "id",
      "created_at_ms",
      "kind",
      "limit_id",
      "scope_kind",
      "scope_id",
      "client_key",
      "operation",
      "estimate_nano_aiu",
      "used_nano_aiu",
      "limit_nano_aiu",
    ])
    expect(events).toHaveLength(1)
    expect(events[0].scope).toEqual({ kind: "key", id: "claude-code" })
  })

  test("rejects a kind it doesn't know", async () => {
    recordBudgetEvent({
      kind: "refused",
      atMs: 1,
      limitId: "x",
      scope: { kind: "global" },
      key: "k",
      operation: "messages",
      estimateNanoAiu: 0,
      usedNanoAiu: 0,
      limitNanoAiu: 0,
    })
    await getBudgetEvents({ limitId: "x", fromMs: 0, toMs: 2 })
    const db = await openSqliteDatabase(dbPath)
    expect(() =>
      db
        .prepare(
          "INSERT INTO budget_events (created_at_ms, kind, limit_id, scope_kind, client_key, operation, estimate_nano_aiu, used_nano_aiu, limit_nano_aiu) VALUES (1, 'bogus', 'x', 'global', 'k', 'm', 0, 0, 0)",
        )
        .run(),
    ).toThrow()
    db.close?.()
  })
})
