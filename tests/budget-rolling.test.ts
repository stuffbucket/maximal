/**
 * Rolling and monthly resets: the period math, the schema, the service's
 * ledger as the window moves, the wording, and the real store's spend rows.
 * Pinned by mutation testing (`bun run mutate`).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import {
  DAY_MS,
  HOUR_MS,
  everyDurationMs,
  monthlyPeriod,
  resolvePeriod,
  rollingPeriod,
  rollingPeriodEnd,
} from "~/lib/budget/periods"
import { BudgetLimitReset } from "~/lib/budget/schema"
import { buildBudgetStatus } from "~/lib/budget/status"
import { createUsageDbBudgetStore } from "~/lib/budget/store"
import { refusalMessage } from "~/lib/budget/wording"
import { requestContext } from "~/lib/http/request-context"
import { closeUsageStore, recordTokenUsageEvent } from "~/lib/token-usage"
import { getNanoAiuSpendRows, getOldestSpendMs } from "~/lib/token-usage/spend"

import {
  AIU,
  NOON,
  event,
  harness,
  intent,
  limit,
} from "./helpers/budget-service-harness"

const ms = (iso: string): number => Date.parse(iso)
const iso = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString()

function monthRange(day: number, now: string): Array<string | null> {
  const period = monthlyPeriod(day, ms(now))
  return [iso(period.startMs), iso(period.endMs)]
}

describe("rolling periods", () => {
  test("the window is the last N ms: a cost stops counting exactly N ms later", () => {
    const now = ms("2026-11-10T12:00:00Z")
    const period = rollingPeriod(5 * HOUR_MS, now)
    expect(period).toEqual({
      startMs: now - 5 * HOUR_MS + 1,
      endMs: null,
      basis: "fixed",
      estimated: false,
      rollingMs: 5 * HOUR_MS,
    })
    // A cost at exactly `now - 5 h` is already out; one ms younger is in.
    expect(now - 5 * HOUR_MS).toBeLessThan(period.startMs)
    expect(now - 5 * HOUR_MS + 1).toBeGreaterThanOrEqual(period.startMs)
  })

  test("the window ends when its oldest cost ages out, or never without one", () => {
    expect(rollingPeriodEnd(undefined, 5 * HOUR_MS)).toBeNull()
    expect(rollingPeriodEnd(1_000, 5 * HOUR_MS)).toBe(1_000 + 5 * HOUR_MS)
    expect(rollingPeriodEnd(0, 7)).toBe(7)
  })

  test("every reads hours and days", () => {
    expect(everyDurationMs({ hours: 5 })).toBe(5 * HOUR_MS)
    expect(everyDurationMs({ hours: 1 })).toBe(3_600_000)
    expect(everyDurationMs({ days: 7 })).toBe(7 * DAY_MS)
    expect(everyDurationMs({ days: 1 })).toBe(86_400_000)
  })

  test("resolvePeriod dispatches every, monthly, follow and fixed", () => {
    const now = ms("2026-11-10T12:00:00Z")
    expect(
      resolvePeriod({ every: { hours: 5 } }, now, () => undefined),
    ).toEqual(rollingPeriod(5 * HOUR_MS, now))
    expect(resolvePeriod({ every: { days: 2 } }, now, () => undefined)).toEqual(
      rollingPeriod(2 * DAY_MS, now),
    )
    expect(
      resolvePeriod({ monthly: { day: 15 } }, now, () => undefined),
    ).toEqual(monthlyPeriod(15, now))
    expect(
      resolvePeriod({ follow: "a:b" }, now, () => ({
        resetsAt: "2026-12-01T00:00:00Z",
      })).basis,
    ).toBe("provider")
  })
})

describe("monthly periods", () => {
  test("starts on the day at 00:00 UTC, and the day itself is the new period", () => {
    expect(monthRange(15, "2026-11-14T23:59:59.999Z")).toEqual([
      "2026-10-15T00:00:00.000Z",
      "2026-11-15T00:00:00.000Z",
    ])
    expect(monthRange(15, "2026-11-15T00:00:00.000Z")).toEqual([
      "2026-11-15T00:00:00.000Z",
      "2026-12-15T00:00:00.000Z",
    ])
    expect(monthRange(15, "2026-11-30T12:00:00.000Z")).toEqual([
      "2026-11-15T00:00:00.000Z",
      "2026-12-15T00:00:00.000Z",
    ])
  })

  test("the 1st is a calendar month", () => {
    expect(monthRange(1, "2026-10-31T23:59:59.999Z")).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
    ])
    expect(monthRange(1, "2026-11-01T00:00:00.000Z")).toEqual([
      "2026-11-01T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z",
    ])
  })

  test("crosses the year both ways", () => {
    expect(monthRange(28, "2026-12-28T00:00:00.000Z")).toEqual([
      "2026-12-28T00:00:00.000Z",
      "2027-01-28T00:00:00.000Z",
    ])
    expect(monthRange(28, "2027-01-27T23:59:59.999Z")).toEqual([
      "2026-12-28T00:00:00.000Z",
      "2027-01-28T00:00:00.000Z",
    ])
    expect(monthRange(15, "2027-01-05T00:00:00.000Z")).toEqual([
      "2026-12-15T00:00:00.000Z",
      "2027-01-15T00:00:00.000Z",
    ])
    expect(monthRange(1, "2026-12-31T23:59:59.999Z")).toEqual([
      "2026-12-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    ])
  })

  test("the 28th exists in February", () => {
    expect(monthRange(28, "2027-03-01T00:00:00.000Z")).toEqual([
      "2027-02-28T00:00:00.000Z",
      "2027-03-28T00:00:00.000Z",
    ])
    expect(monthRange(28, "2028-02-29T12:00:00.000Z")).toEqual([
      "2028-02-28T00:00:00.000Z",
      "2028-03-28T00:00:00.000Z",
    ])
  })

  test("is a fixed period, never estimated", () => {
    expect(monthlyPeriod(3, ms("2026-11-10T00:00:00Z"))).toMatchObject({
      basis: "fixed",
      estimated: false,
    })
    expect(
      monthlyPeriod(3, ms("2026-11-10T00:00:00Z")).rollingMs,
    ).toBeUndefined()
  })
})

describe("the reset schema", () => {
  const accepts = [
    "daily",
    { follow: "copilot:premium_interactions" },
    { every: { hours: 1 } },
    { every: { hours: 5 } },
    { every: { hours: 720 } },
    { every: { days: 1 } },
    { every: { days: 90 } },
    { monthly: { day: 1 } },
    { monthly: { day: 28 } },
  ]
  const rejects = [
    { every: { hours: 0 } },
    { every: { hours: 721 } },
    { every: { hours: 1.5 } },
    { every: { days: 0 } },
    { every: { days: 91 } },
    { every: { hours: 1, days: 1 } },
    { every: {} },
    { every: { weeks: 1 } },
    { monthly: { day: 0 } },
    { monthly: { day: 29 } },
    { monthly: { day: 1.5 } },
    { monthly: { day: 1, extra: true } },
    { monthly: {} },
    "hourly",
  ]

  test("accepts the forms and their edges", () => {
    for (const value of accepts) {
      expect(BudgetLimitReset.safeParse(value).success).toBe(true)
    }
  })

  test("rejects out-of-range, fractional, ambiguous and unknown forms", () => {
    for (const value of rejects) {
      expect(BudgetLimitReset.safeParse(value).success).toBe(false)
    }
  })
})

describe("the refusal wording for a rolling window", () => {
  const words = {
    name: "Agents",
    limit: AIU,
    used: AIU,
    held: 0,
    requested: 0,
    nowMs: NOON,
    inFlight: false,
    display: { unit: "usd", creditUsd: 0.01 } as const,
    rollingMs: 5 * HOUR_MS,
  }

  test("says how long spend counts and when the oldest ages out", () => {
    const message = refusalMessage({ ...words, resetsAtMs: NOON + 90 * 60_000 })
    expect(message).toBe(
      'Maximal rule "Agents" blocked this request: it is used up ($0.01 of $0.01 used). Spend counts for 5 h. The oldest ages out 2026-11-11T13:30:00.000Z (in 1 h 30 min). Raise or remove it in Maximal → Rules.',
    )
  })

  test("with nothing to age out, only says how long spend counts", () => {
    expect(refusalMessage({ ...words, resetsAtMs: null })).toBe(
      'Maximal rule "Agents" blocked this request: it is used up ($0.01 of $0.01 used). Spend counts for 5 h. Raise or remove it in Maximal → Rules.',
    )
  })

  test("a refusal caused only by calls in flight still says to try again", () => {
    const message = refusalMessage({
      ...words,
      used: 0,
      held: AIU,
      inFlight: true,
      resetsAtMs: null,
    })
    expect(message).toContain("Try again in a moment.")
    expect(message).not.toContain("Spend counts")
  })
})

describe("a rolling limit in the service", () => {
  const every5h = { every: { hours: 5 } } as const
  const FIVE_HOURS = 5 * HOUR_MS

  test("a cost counts until it is exactly one window old, loaded from the store", async () => {
    // Recorded before the service starts: read back from the store.
    const edge = harness([limit({ id: "r", limitReset: every5h })])
    edge.emit(event({ createdAtMs: NOON - FIVE_HOURS, nanoAiu: AIU }))
    expect((await edge.service.check(intent())).ok).toBe(true)

    const inside = harness([limit({ id: "r", limitReset: every5h })])
    inside.emit(event({ createdAtMs: NOON - FIVE_HOURS + 1, nanoAiu: AIU }))
    const decision = await inside.service.check(intent())
    expect(decision.ok).toBe(false)
  })

  test("a cost counts until it is exactly one window old, announced live", async () => {
    const h = harness([limit({ id: "r", limitReset: every5h })])
    await h.service.check(intent())
    h.emit(event({ createdAtMs: NOON - FIVE_HOURS, nanoAiu: AIU }))
    expect((await h.service.check(intent())).ok).toBe(true)
    h.emit(event({ createdAtMs: NOON - FIVE_HOURS + 1, nanoAiu: AIU }))
    expect((await h.service.check(intent())).ok).toBe(false)
  })

  test("room returns as the clock passes the oldest cost, without a reload", async () => {
    const h = harness([limit({ id: "r", limitReset: every5h })])
    const at = NOON - HOUR_MS
    h.emit(event({ createdAtMs: at, nanoAiu: AIU }))

    const refused = await h.service.check(intent())
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.refusal.resetsAtMs).toBe(at + FIVE_HOURS)
    expect(h.calls.spend).toHaveLength(1)

    h.setNow(at + FIVE_HOURS - 1)
    expect((await h.service.check(intent())).ok).toBe(false)
    h.setNow(at + FIVE_HOURS)
    expect((await h.service.check(intent())).ok).toBe(true)
    // The same entry served all three: the window moving isn't a reload.
    expect(h.calls.spend).toHaveLength(1)
  })

  test("partial room: only the aged-out part is freed", async () => {
    const h = harness([limit({ id: "r", limit: 2 * AIU, limitReset: every5h })])
    h.emit(event({ createdAtMs: NOON - 4 * HOUR_MS, nanoAiu: AIU }))
    h.emit(event({ createdAtMs: NOON - HOUR_MS, nanoAiu: AIU }))
    expect((await h.service.check(intent())).ok).toBe(false)

    h.setNow(NOON - 4 * HOUR_MS + FIVE_HOURS)
    // The older AIU aged out; the newer one still counts: 1 of 2 used.
    const room = await h.service.check(intent({ estimateNanoAiu: AIU }))
    expect(room.ok).toBe(true)
    const over = await h.service.check(intent({ estimateNanoAiu: AIU + 1 }))
    expect(over.ok).toBe(false)
  })

  test("the reset is the oldest cost's, whatever order they were recorded in", async () => {
    const h = harness([limit({ id: "r", limit: 2 * AIU, limitReset: every5h })])
    await h.service.check(intent())
    h.emit(event({ createdAtMs: NOON - HOUR_MS, nanoAiu: AIU }))
    h.emit(event({ createdAtMs: NOON - 3 * HOUR_MS, nanoAiu: AIU }))
    h.emit(event({ createdAtMs: NOON - 2 * HOUR_MS, nanoAiu: 0 }))
    const refused = await h.service.check(intent())
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.refusal.resetsAtMs).toBe(NOON - 3 * HOUR_MS + FIVE_HOURS)
      expect(refused.refusal.message).toContain("Spend counts for 5 h")
    }
  })

  test("a refusal with no cost to age out has no reset", async () => {
    const h = harness([limit({ id: "r", limit: 0, limitReset: every5h })])
    const refused = await h.service.check(intent())
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.refusal.resetsAtMs).toBeNull()
  })

  test("a cost recorded while the ledger loads counts", async () => {
    const h = harness([limit({ id: "r", limitReset: every5h })])
    const gate = h.deferSpend()
    const pending = h.service.check(intent())
    await gate.started
    h.emit(event({ createdAtMs: NOON - 1_000, nanoAiu: AIU }))
    gate.release()
    expect((await pending).ok).toBe(false)
  })

  test("a failed read counts from now", async () => {
    const warn = spyOn(consola, "warn").mockImplementation(
      Object.assign(() => {}, { raw: () => {} }),
    )
    try {
      const h = harness([limit({ id: "r", limitReset: every5h })], {
        spendFails: true,
      })
      expect((await h.service.check(intent())).ok).toBe(true)
      h.emit(event({ createdAtMs: NOON - 1_000, nanoAiu: AIU }))
      expect((await h.service.check(intent())).ok).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  test("changing the window reloads the ledger; spelling it differently does not", async () => {
    const h = harness([limit({ id: "r", limitReset: every5h })])
    await h.service.check(intent())
    expect(h.calls.spend).toHaveLength(1)

    h.setConfig({
      limits: [limit({ id: "r", limitReset: { every: { hours: 6 } } })],
    })
    await h.service.check(intent())
    expect(h.calls.spend).toHaveLength(2)

    h.setConfig({
      limits: [limit({ id: "r", limitReset: { every: { hours: 24 } } })],
    })
    await h.service.check(intent())
    expect(h.calls.spend).toHaveLength(3)
    h.setConfig({
      limits: [limit({ id: "r", limitReset: { every: { days: 1 } } })],
    })
    await h.service.check(intent())
    expect(h.calls.spend).toHaveLength(3)
  })

  test("the warning is announced once per crossing, and again after dropping back under", async () => {
    const h = harness([limit({ id: "r", limitReset: every5h })])
    await h.service.check(intent())
    h.emit(event({ createdAtMs: NOON - HOUR_MS, nanoAiu: 0.9 * AIU }))

    await h.service.check(intent())
    await h.service.check(intent())
    expect(h.warnings).toHaveLength(1)

    // The cost ages out; a check under the threshold re-arms the warning.
    h.setNow(NOON + 5 * HOUR_MS)
    expect((await h.service.check(intent())).ok).toBe(true)
    expect(h.warnings).toHaveLength(1)

    h.emit(event({ createdAtMs: NOON + 5 * HOUR_MS, nanoAiu: 0.9 * AIU }))
    await h.service.check(intent())
    expect(h.warnings).toHaveLength(2)
  })

  test("a fixed period's warning is still once per period", async () => {
    const h = harness([limit({ id: "d" })])
    await h.service.check(intent())
    h.emit(event({ nanoAiu: 0.9 * AIU }))
    await h.service.check(intent())
    await h.service.check(intent())
    expect(h.warnings).toHaveLength(1)
  })

  test("holds count against a rolling limit like any other", async () => {
    const h = harness([limit({ id: "r", limitReset: every5h })])
    const first = await h.service.reserve(intent({ estimateNanoAiu: AIU }))
    expect(first.ok).toBe(true)
    const second = await h.service.reserve(intent({ estimateNanoAiu: 1 }))
    expect(second.ok).toBe(false)
  })
})

describe("a monthly limit in the service", () => {
  test("counts from the start of the month that began on its day", async () => {
    // NOON is 2026-11-11: with day 15, the month began 2026-10-15.
    const monthly = { monthly: { day: 15 } } as const
    const before = harness([limit({ id: "m", limitReset: monthly })])
    before.emit(
      event({
        createdAtMs: Date.UTC(2026, 9, 14, 23, 59, 59, 999),
        nanoAiu: AIU,
      }),
    )
    expect((await before.service.check(intent())).ok).toBe(true)

    const onTheDay = harness([limit({ id: "m", limitReset: monthly })])
    onTheDay.emit(event({ createdAtMs: Date.UTC(2026, 9, 15), nanoAiu: AIU }))
    const refused = await onTheDay.service.check(intent())
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.refusal.resetsAtMs).toBe(Date.UTC(2026, 10, 15))
      expect(refused.refusal.message).not.toContain("Spend counts")
    }
  })
})

function record(at: number, nanoAiu: number, label?: string): void {
  setSystemTime(new Date(at))
  requestContext.run(
    {
      parentSessionId: undefined,
      sessionAffinity: undefined,
      startTime: at,
      traceId: `trace-${at}`,
      usage: { apiKeyLabel: label },
      userAgent: "test",
    },
    () => {
      recordTokenUsageEvent({
        endpoint: "images",
        model: "gpt-image-test",
        source: "copilot",
        input_tokens: 1,
        total_nano_aiu: nanoAiu,
      })
    },
  )
  setSystemTime()
}

const heldFor = (id: string, createdAtMs: number) => ({
  id,
  createdAtMs,
  operation: "images.generations" as const,
  key: "laptop",
  provider: "copilot",
  estimateNanoAiu: 4,
})

describe("rolling spend in the usage database", () => {
  const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

  beforeEach(async () => {
    process.env[DB_PATH_ENV] = ":memory:"
    await closeUsageStore()
  })

  afterEach(async () => {
    setSystemTime()
    await closeUsageStore()
    Reflect.deleteProperty(process.env, DB_PATH_ENV)
  })

  test("spend rows are the costs in the range, oldest first, without free ones", async () => {
    record(NOON - 3_000, 3)
    record(NOON - 5_000, 5)
    record(NOON - 4_000, 0)
    record(NOON - 9_000, 9)
    record(NOON + 1_000, 7)

    const rows = await getNanoAiuSpendRows(
      { kind: "global" },
      { startMs: NOON - 5_000, endMs: NOON + 1_000 },
    )
    expect(rows).toEqual([
      { createdAtMs: NOON - 5_000, nanoAiu: 5 },
      { createdAtMs: NOON - 3_000, nanoAiu: 3 },
    ])
    const open = await getNanoAiuSpendRows(
      { kind: "global" },
      { startMs: NOON - 5_000, endMs: null },
    )
    expect(open.map((row) => row.nanoAiu)).toEqual([5, 3, 7])
  })

  test("spend rows follow the scope", async () => {
    record(NOON - 2_000, 2, "laptop")
    record(NOON - 1_000, 1, "desktop")
    const rows = await getNanoAiuSpendRows(
      { kind: "key", id: "laptop" },
      { startMs: 0, endMs: null },
    )
    expect(rows).toEqual([{ createdAtMs: NOON - 2_000, nanoAiu: 2 }])
    expect(
      await getNanoAiuSpendRows(
        { kind: "key", id: "nobody" },
        { startMs: 0, endMs: null },
      ),
    ).toEqual([])
  })

  test("orphaned holds are costs too, open and released ones are not", async () => {
    const store = createUsageDbBudgetStore()
    store.openHold(heldFor("crashed", NOON - 2_000))
    store.openHold(heldFor("done", NOON - 1_000))
    store.closeHold({ id: "done", state: "released", closedAtMs: NOON })
    await store.recover(NOON)
    store.openHold(heldFor("open", NOON - 500))

    const rows = await store.spendRows(
      { kind: "key", id: "laptop" },
      { startMs: 0, endMs: null },
    )
    expect(rows).toEqual([{ createdAtMs: NOON - 2_000, nanoAiu: 4 }])
    expect(
      await store.spendRows(
        { kind: "key", id: "other" },
        { startMs: 0, endMs: null },
      ),
    ).toEqual([])
  })

  test("the oldest spend in a range", async () => {
    expect(
      await getOldestSpendMs({ kind: "global" }, { startMs: 0, endMs: null }),
    ).toBeUndefined()
    record(NOON - 1_000, 1)
    record(NOON - 4_000, 4)
    expect(
      await getOldestSpendMs({ kind: "global" }, { startMs: 0, endMs: null }),
    ).toBe(NOON - 4_000)
    expect(
      await getOldestSpendMs(
        { kind: "global" },
        { startMs: NOON - 3_000, endMs: null },
      ),
    ).toBe(NOON - 1_000)
  })

  test("status counts the trailing window and resets when its oldest spend ages out", async () => {
    record(NOON - 6 * HOUR_MS, AIU) // too old
    record(NOON - 5 * HOUR_MS, AIU) // exactly one window old: out
    record(NOON - 4 * HOUR_MS, AIU / 2)
    record(NOON - HOUR_MS, AIU / 4)
    const budget = {
      limits: [
        limit({ id: "r", limit: 2 * AIU, limitReset: { every: { hours: 5 } } }),
      ],
    }
    const status = await buildBudgetStatus(budget, { nowMs: NOON, windows: [] })
    expect(status.budgets[0]).toMatchObject({
      limit_reset: { every: { hours: 5 } },
      usage: 0.75 * AIU,
      limit_remaining: 1.25 * AIU,
      period_start: iso(NOON - 5 * HOUR_MS + 1),
      resets_at: iso(NOON - 4 * HOUR_MS + 5 * HOUR_MS),
      reset_basis: "fixed",
      reset_estimated: false,
      state: "ok",
    })
    // The daily figure is the calendar day's, as for any limit.
    expect(status.budgets[0].usage_daily).toBe(2.75 * AIU)
  })

  test("a rolling limit with no spend has no reset, and a monthly one reports its month", async () => {
    const budget = {
      limits: [
        limit({ id: "r", limitReset: { every: { days: 2 } } }),
        limit({ id: "m", limitReset: { monthly: { day: 15 } } }),
      ],
    }
    const status = await buildBudgetStatus(budget, { nowMs: NOON, windows: [] })
    const byId = new Map(status.budgets.map((entry) => [entry.id, entry]))
    expect(byId.get("r")).toMatchObject({ usage: 0, resets_at: null })
    expect(byId.get("m")).toMatchObject({
      period_start: "2026-10-15T00:00:00.000Z",
      resets_at: "2026-11-15T00:00:00.000Z",
    })
  })
})
