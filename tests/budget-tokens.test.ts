/**
 * Token limits, request caps and conditions: the metric helpers, the SQL they
 * share with the ledger, the sentences, and the service's enforcement. Pinned
 * by mutation testing (`bun run mutate`).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test"

import { limitApplies } from "~/lib/budget/conditions"
import {
  EVENT_METRIC_SQL,
  HOLD_METRIC_SQL,
  amountOf,
  metricOf,
} from "~/lib/budget/metric"
import { BudgetConfigSchema } from "~/lib/budget/schema"
import { createUsageDbBudgetStore } from "~/lib/budget/store"
import {
  formatTokens,
  formatUnitAmount,
  refusalMessage,
  type RefusalWords,
} from "~/lib/budget/wording"
import { requestContext } from "~/lib/http/request-context"
import { closeUsageStore, recordTokenUsageEvent } from "~/lib/token-usage"
import {
  getNanoAiuSpend,
  getNanoAiuSpendRows,
  getRequestTimes,
} from "~/lib/token-usage/spend"

import {
  AIU,
  NOON,
  event,
  harness,
  intent,
  limit,
} from "./helpers/budget-service-harness"

const HOUR = 3_600_000
const MINUTE = 60_000
const USD = { unit: "usd", creditUsd: 0.01 } as const

describe("metrics", () => {
  test("a cost limit counts nano-AIU; a token limit its measure, total by default", () => {
    expect(metricOf({})).toBe("nano_aiu")
    expect(metricOf({ unit: "cost" })).toBe("nano_aiu")
    expect(metricOf({ unit: "tokens" })).toBe("total_tokens")
    expect(metricOf({ unit: "tokens", measure: "total" })).toBe("total_tokens")
    expect(metricOf({ unit: "tokens", measure: "input" })).toBe("input_tokens")
    expect(metricOf({ unit: "tokens", measure: "output" })).toBe(
      "output_tokens",
    )
  })

  test("a row's amount in each metric", () => {
    const row = { nanoAiu: 7, inputTokens: 100, outputTokens: 30 }
    expect(amountOf(row, "nano_aiu")).toBe(7)
    expect(amountOf(row, "input_tokens")).toBe(100)
    expect(amountOf(row, "output_tokens")).toBe(30)
    expect(amountOf(row, "total_tokens")).toBe(130)
  })

  test("the SQL reads the same columns, cache reads counted as input", () => {
    expect(EVENT_METRIC_SQL).toEqual({
      nano_aiu: "total_nano_aiu",
      input_tokens: "(input_tokens + cache_read_input_tokens)",
      output_tokens: "output_tokens",
      total_tokens: "(input_tokens + cache_read_input_tokens + output_tokens)",
    })
    expect(HOLD_METRIC_SQL).toEqual({
      nano_aiu: "estimate_nano_aiu",
      input_tokens: "est_input_tokens",
      output_tokens: "est_output_tokens",
      total_tokens: "(est_input_tokens + est_output_tokens)",
    })
  })
})

describe("the config schema for tokens, requests and conditions", () => {
  const base = {
    id: "l",
    scope: { kind: "global" },
    limit: 1000,
    limitReset: "daily",
    action: "block",
  }
  const parses = (extra: Record<string, unknown>) =>
    BudgetConfigSchema.safeParse({ limits: [{ ...base, ...extra }] }).success

  test("units and measures", () => {
    expect(parses({ unit: "tokens" })).toBe(true)
    expect(parses({ unit: "tokens", measure: "output" })).toBe(true)
    expect(parses({ unit: "cost" })).toBe(true)
    expect(parses({ unit: "credits" })).toBe(false)
    expect(parses({ unit: "tokens", measure: "all" })).toBe(false)
    // A measure is only for tokens.
    expect(parses({ measure: "input" })).toBe(false)
    expect(parses({ unit: "cost", measure: "input" })).toBe(false)
  })

  test("a request cap is a whole number above zero", () => {
    expect(parses({ maxRequests: 1 })).toBe(true)
    expect(parses({ maxRequests: 500 })).toBe(true)
    expect(parses({ maxRequests: 0 })).toBe(false)
    expect(parses({ maxRequests: 1.5 })).toBe(false)
  })

  test("a condition needs locked or idle minutes, within a day", () => {
    expect(parses({ when: { locked: true } })).toBe(true)
    expect(parses({ when: { idleMinutes: 1 } })).toBe(true)
    expect(parses({ when: { idleMinutes: 1440 } })).toBe(true)
    expect(parses({ when: { locked: true, idleMinutes: 30 } })).toBe(true)
    expect(parses({ when: {} })).toBe(false)
    expect(parses({ when: { locked: false } })).toBe(false)
    expect(parses({ when: { idleMinutes: 0 } })).toBe(false)
    expect(parses({ when: { idleMinutes: 1441 } })).toBe(false)
    expect(parses({ when: { idleMinutes: 1.5 } })).toBe(false)
    expect(parses({ when: { locked: true, other: 1 } })).toBe(false)
  })

  test("rolling minutes", () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const parse = (every: unknown) =>
      BudgetConfigSchema.safeParse({
        limits: [{ ...base, limitReset: { every } }],
      }).success
    expect(parse({ minutes: 1 })).toBe(true)
    expect(parse({ minutes: 1440 })).toBe(true)
    expect(parse({ minutes: 0 })).toBe(false)
    expect(parse({ minutes: 1441 })).toBe(false)
    expect(parse({ minutes: 5, hours: 1 })).toBe(false)
  })
})

describe("who a condition applies to", () => {
  const away = { locked: true, idleSeconds: 0 }

  test("no condition always applies, even with presence unknown", () => {
    expect(limitApplies(undefined, undefined)).toBe(true)
    expect(limitApplies(undefined, { locked: null, idleSeconds: null })).toBe(
      true,
    )
  })

  test("unknown presence never meets a condition", () => {
    for (const when of [
      { locked: true as const },
      { idleMinutes: 5 },
      { locked: true as const, idleMinutes: 5 },
    ]) {
      expect(limitApplies(when, undefined)).toBe(false)
      expect(limitApplies(when, { locked: null, idleSeconds: null })).toBe(
        false,
      )
    }
  })

  test("locked: only while the screen is locked", () => {
    expect(limitApplies({ locked: true }, away)).toBe(true)
    expect(
      limitApplies({ locked: true }, { locked: false, idleSeconds: 9999 }),
    ).toBe(false)
    expect(
      limitApplies({ locked: true }, { locked: null, idleSeconds: 9999 }),
    ).toBe(false)
  })

  test("idle: from exactly N minutes with no input", () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const idle = (seconds: number | null) => ({
      locked: false,
      idleSeconds: seconds,
    })
    expect(limitApplies({ idleMinutes: 5 }, idle(299))).toBe(false)
    expect(limitApplies({ idleMinutes: 5 }, idle(300))).toBe(true)
    expect(limitApplies({ idleMinutes: 5 }, idle(301))).toBe(true)
    expect(limitApplies({ idleMinutes: 5 }, idle(null))).toBe(false)
    expect(limitApplies({ idleMinutes: 1 }, idle(60))).toBe(true)
    // Locked alone doesn't meet an idle condition.
    expect(limitApplies({ idleMinutes: 5 }, away)).toBe(false)
  })

  test("both: either is enough", () => {
    const when = { locked: true as const, idleMinutes: 30 }
    expect(limitApplies(when, away)).toBe(true)
    expect(limitApplies(when, { locked: false, idleSeconds: 1800 })).toBe(true)
    expect(limitApplies(when, { locked: false, idleSeconds: 1799 })).toBe(false)
    expect(limitApplies(when, { locked: null, idleSeconds: 1800 })).toBe(true)
  })
})

describe("the sentences", () => {
  test("tokens read as three significant digits", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(999.4)).toBe("999")
    expect(formatTokens(1000)).toBe("1k")
    expect(formatTokens(12_345)).toBe("12.3k")
    expect(formatTokens(250_000)).toBe("250k")
    expect(formatTokens(999_499)).toBe("999k")
    expect(formatTokens(999_500)).toBe("1M")
    expect(formatTokens(2_000_000)).toBe("2M")
    expect(formatTokens(1_250_000)).toBe("1.25M")
    expect(formatTokens(999_500_000)).toBe("1B")
    expect(formatTokens(1_500_000_000)).toBe("1.5B")
  })

  test("an amount in each unit", () => {
    expect(formatUnitAmount(AIU, "nano_aiu", USD)).toBe("$0.01")
    expect(formatUnitAmount(2_000_000, "total_tokens", USD)).toBe("2M tokens")
    expect(formatUnitAmount(1500, "input_tokens", USD)).toBe(
      "1.5k input tokens",
    )
    expect(formatUnitAmount(900, "output_tokens", USD)).toBe(
      "900 output tokens",
    )
    expect(formatUnitAmount(1, "requests", USD)).toBe("1 request")
    expect(formatUnitAmount(0, "requests", USD)).toBe("0 requests")
    expect(formatUnitAmount(120, "requests", USD)).toBe("120 requests")
  })

  const words: RefusalWords = {
    name: "Runaway",
    unit: "total_tokens",
    limit: 2_000_000,
    used: 2_000_000,
    held: 0,
    requested: 0,
    resetsAtMs: NOON + 40 * MINUTE,
    nowMs: NOON,
    inFlight: false,
    display: USD,
    rollingMs: HOUR,
  }

  test("a token limit speaks in tokens, with what the request needs", () => {
    expect(refusalMessage(words)).toBe(
      'Maximal rule "Runaway" blocked this request: it is used up (2M tokens of 2M tokens used). Usage counts for 1 h. The oldest ages out 2026-11-11T12:40:00.000Z (in 40 min). Raise or remove it in Maximal → Rules.',
    )
    expect(
      refusalMessage({ ...words, used: 1_990_000, requested: 64_000 }),
    ).toContain(
      "1.99M tokens of 2M tokens used, and the request needs about 64k tokens",
    )
    expect(
      refusalMessage({
        ...words,
        used: 1_000_000,
        held: 990_000,
        inFlight: true,
      }),
    ).toContain(
      "it has 1M tokens left, and requests in progress already hold 990k tokens of it",
    )
  })

  test("a request cap says how many requests were made", () => {
    expect(
      refusalMessage({
        ...words,
        unit: "requests",
        limit: 120,
        used: 120,
        requested: 1,
      }),
    ).toBe(
      'Maximal rule "Runaway" blocked this request: it has made 120 of its 120 requests. Requests counts for 1 h. The oldest ages out 2026-11-11T12:40:00.000Z (in 40 min). Raise or remove it in Maximal → Rules.',
    )
    expect(
      refusalMessage({
        ...words,
        unit: "requests",
        limit: 1,
        used: 1,
        rollingMs: undefined,
        resetsAtMs: null,
      }),
    ).toContain("it has made 1 of its 1 request. It never resets.")
  })

  test("a cost limit still reads as money", () => {
    expect(
      refusalMessage({ ...words, unit: "nano_aiu", limit: AIU, used: AIU }),
    ).toContain("it is used up ($0.01 of $0.01 used)")
    expect(
      refusalMessage({ ...words, unit: "nano_aiu", limit: AIU, used: AIU }),
    ).toContain("Spend counts for 1 h.")
  })
})

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

interface Row {
  at?: number
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
  nano?: number
  label?: string
  model?: string
}

function record(row: Row): void {
  const at = row.at ?? NOON - 1000
  setSystemTime(new Date(at))
  requestContext.run(
    {
      parentSessionId: undefined,
      sessionAffinity: undefined,
      startTime: at,
      traceId: `trace-${at}-${row.input ?? 0}-${row.output ?? 0}`,
      usage: { apiKeyLabel: row.label },
      userAgent: "test",
    },
    () => {
      recordTokenUsageEvent({
        endpoint: "messages",
        model: row.model ?? "gpt-test",
        source: "copilot",
        input_tokens: row.input ?? 0,
        output_tokens: row.output ?? 0,
        cache_read_input_tokens: row.cacheRead ?? 0,
        cache_creation_input_tokens: row.cacheCreation ?? 0,
        total_nano_aiu: row.nano ?? 0,
      })
    },
  )
  setSystemTime()
}

describe("tokens over the usage database", () => {
  beforeEach(async () => {
    process.env[DB_PATH_ENV] = ":memory:"
    await closeUsageStore()
  })

  afterEach(async () => {
    setSystemTime()
    await closeUsageStore()
    Reflect.deleteProperty(process.env, DB_PATH_ENV)
  })

  const everything = { startMs: 0, endMs: null }
  const global = { kind: "global" } as const

  // eslint-disable-next-line unicorn/consistent-function-scoping
  function seed(): void {
    record({
      input: 100,
      output: 10,
      cacheRead: 1000,
      cacheCreation: 500,
      nano: 7,
    })
    record({ input: 200, output: 20, nano: 0 })
    record({ input: 0, output: 0, nano: 3 })
  }

  test("each metric sums its own columns; cache reads are input, cache creation isn't counted", async () => {
    seed()
    const sum = async (metric: Parameters<typeof getNanoAiuSpend>[2]) =>
      (await getNanoAiuSpend(global, [everything], metric))[0]
    expect(await sum("nano_aiu")).toBe(10)
    expect(await sum("input_tokens")).toBe(100 + 1000 + 200)
    expect(await sum("output_tokens")).toBe(30)
    expect(await sum("total_tokens")).toBe(1330)
    expect((await getNanoAiuSpend(global, [everything]))[0]).toBe(10)
  })

  test("spend rows leave out rows that count nothing in that metric", async () => {
    seed()
    expect(
      (await getNanoAiuSpendRows(global, everything, "output_tokens")).map(
        (r) => r.nanoAiu,
      ),
    ).toEqual([10, 20])
    expect(
      (await getNanoAiuSpendRows(global, everything, "nano_aiu")).map(
        (r) => r.nanoAiu,
      ),
    ).toEqual([7, 3])
    expect(
      (await getNanoAiuSpendRows(global, everything, "total_tokens")).map(
        (r) => r.nanoAiu,
      ),
    ).toEqual([1110, 220])
  })

  test("request times include every row, free ones too, in range and scope", async () => {
    record({ at: NOON - 5000, input: 1, label: "ci" })
    record({ at: NOON - 3000, input: 2, nano: 9 })
    record({ at: NOON - 1000, input: 3, label: "ci" })
    expect(await getRequestTimes(global, everything)).toEqual([
      NOON - 5000,
      NOON - 3000,
      NOON - 1000,
    ])
    expect(
      await getRequestTimes({ kind: "key", id: "ci" }, everything),
    ).toEqual([NOON - 5000, NOON - 1000])
    expect(
      await getRequestTimes(global, {
        startMs: NOON - 4000,
        endMs: NOON - 1000,
      }),
    ).toEqual([NOON - 3000])
    expect(
      await getRequestTimes(global, { startMs: NOON - 3000, endMs: null }),
    ).toEqual([NOON - 3000, NOON - 1000])
  })

  test("orphaned holds count their token estimates", async () => {
    seed()
    const store = createUsageDbBudgetStore()
    await store.openHold({
      id: "crashed",
      createdAtMs: NOON - 500,
      operation: "messages",
      key: "claude-code",
      provider: "copilot",
      estimateNanoAiu: 5,
      estimateInputTokens: 40,
      estimateOutputTokens: 60,
    })
    await store.openHold({
      id: "open",
      createdAtMs: NOON - 400,
      operation: "messages",
      key: "claude-code",
      provider: "copilot",
      estimateNanoAiu: 0,
      estimateInputTokens: 1,
      estimateOutputTokens: 1,
    })
    // Both were left open, so both are orphaned at the next start.
    await store.recover(NOON)
    expect(await store.spend(global, everything, "input_tokens")).toBe(
      1300 + 40 + 1,
    )
    expect(await store.spend(global, everything, "output_tokens")).toBe(
      30 + 60 + 1,
    )
    expect(await store.spend(global, everything, "total_tokens")).toBe(
      1330 + 100 + 2,
    )
    expect(await store.spend(global, everything, "nano_aiu")).toBe(15)
    expect(
      (await store.spendRows(global, everything, "total_tokens")).map(
        (r) => r.nanoAiu,
      ),
    ).toEqual([1110, 220, 100, 2])
    expect(await store.requestTimes(global, everything)).toHaveLength(3)
  })
})

function tokens(
  overrides: Partial<Parameters<typeof limit>[0]> = {},
): ReturnType<typeof limit> {
  return limit({ id: "t", unit: "tokens", limit: 1000, ...overrides })
}

describe("a token limit in the service", () => {
  test("counts total tokens: input with cache reads, plus output", async () => {
    const h = harness([tokens()])
    h.emit(event({ inputTokens: 600, outputTokens: 399 }))
    expect((await h.service.check(intent())).ok).toBe(true)
    h.emit(event({ inputTokens: 1, outputTokens: 0 }))
    const refused = await h.service.check(intent())
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.refusal).toMatchObject({
        unit: "total_tokens",
        limit: 1000,
        used: 1000,
      })
      expect(refused.refusal.message).toContain(
        "it is used up (1k tokens of 1k tokens used)",
      )
    }
  })

  test("a cost row with no tokens counts nothing, and a token row no cost", async () => {
    const h = harness([tokens(), limit({ id: "cost" })])
    h.emit(event({ nanoAiu: 100 * AIU }))
    const decision = await h.service.check(intent())
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.refusal.limitId).toBe("cost")

    const tokensOnly = harness([limit({ id: "cost" })])
    tokensOnly.emit(event({ inputTokens: 9_000_000 }))
    expect((await tokensOnly.service.check(intent())).ok).toBe(true)
  })

  test("input and output measures count only their side", async () => {
    const input = harness([tokens({ measure: "input" })])
    input.emit(event({ inputTokens: 1000, outputTokens: 9_999 }))
    expect((await input.service.check(intent())).ok).toBe(false)
    const input2 = harness([tokens({ measure: "input" })])
    input2.emit(event({ inputTokens: 999, outputTokens: 9_999 }))
    expect((await input2.service.check(intent())).ok).toBe(true)

    const output = harness([tokens({ measure: "output" })])
    output.emit(event({ inputTokens: 9_999, outputTokens: 999 }))
    expect((await output.service.check(intent())).ok).toBe(true)
    output.emit(event({ outputTokens: 1 }))
    const refused = await output.service.check(intent())
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.refusal.unit).toBe("output_tokens")
  })

  test("the request's token estimate is held and checked against the room", async () => {
    const h = harness([tokens({ measure: "output" })])
    h.emit(event({ outputTokens: 900 }))
    expect(
      (await h.service.check(intent({ estimateOutputTokens: 100 }))).ok,
    ).toBe(true)
    const over = await h.service.check(intent({ estimateOutputTokens: 101 }))
    expect(over.ok).toBe(false)
    if (!over.ok) {
      expect(over.refusal).toMatchObject({
        requested: 101,
        used: 900,
        unit: "output_tokens",
      })
    }
    // A prompt estimate doesn't count against an output limit.
    expect(
      (await h.service.check(intent({ estimateInputTokens: 5000 }))).ok,
    ).toBe(true)
  })

  test("holds reserve tokens against concurrent calls and are written ahead", async () => {
    const h = harness([tokens({ measure: "total" })])
    const first = await h.service.reserve(
      intent({ estimateInputTokens: 300, estimateOutputTokens: 600 }),
    )
    expect(first.ok).toBe(true)
    expect(h.service.heldNanoAiu({ kind: "global" }, "total_tokens")).toBe(900)
    expect(h.service.heldNanoAiu({ kind: "global" }, "input_tokens")).toBe(300)
    expect(h.service.heldNanoAiu({ kind: "global" }, "output_tokens")).toBe(600)
    expect(h.service.heldNanoAiu({ kind: "global" })).toBe(0)
    expect(h.calls.opened[0]).toMatchObject({
      estimateNanoAiu: 0,
      estimateInputTokens: 300,
      estimateOutputTokens: 600,
    })

    const second = await h.service.reserve(
      intent({ estimateOutputTokens: 101 }),
    )
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.refusal.inFlight).toBe(true)
      expect(second.refusal.held).toBe(900)
    }

    if (first.ok) await first.hold.commit()
    expect(h.calls.closed).toHaveLength(1)
    expect(
      (await h.service.reserve(intent({ estimateOutputTokens: 101 }))).ok,
    ).toBe(true)
  })

  test("estimates are rounded to whole tokens and never negative", async () => {
    const h = harness([tokens({ measure: "output" })])
    const decision = await h.service.reserve(
      intent({ estimateOutputTokens: 10.6, estimateInputTokens: -5 }),
    )
    expect(decision.ok).toBe(true)
    expect(h.service.heldNanoAiu({ kind: "global" }, "output_tokens")).toBe(11)
    expect(h.service.heldNanoAiu({ kind: "global" }, "input_tokens")).toBe(0)
  })

  test("a call with no estimate at all writes no hold", async () => {
    const h = harness([tokens()])
    const decision = await h.service.reserve(intent())
    expect(decision.ok).toBe(true)
    expect(h.calls.opened).toEqual([])
    if (decision.ok) await decision.hold.commit()
    expect(h.calls.closed).toEqual([])
  })

  test("the warning is in tokens, and the decision log carries the limit's unit", async () => {
    const h = harness([tokens()])
    h.emit(event({ inputTokens: 800 }))
    await h.service.check(intent({ estimateOutputTokens: 5 }))
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toMatchObject({
      limitId: "t",
      used: 800,
      limit: 1000,
      unit: "total_tokens",
    })
    h.emit(event({ inputTokens: 300 }))
    await h.service.check(intent({ estimateOutputTokens: 7 }))
    expect(h.events.at(-1)).toMatchObject({
      kind: "refused",
      estimateNanoAiu: 7,
      usedNanoAiu: 1100,
      limitNanoAiu: 1000,
    })
  })

  test("changing what a limit counts reloads its ledger", async () => {
    const h = harness([tokens()])
    await h.service.check(intent())
    expect(h.calls.spend).toHaveLength(1)
    h.setConfig({ limits: [tokens({ measure: "output" })] })
    await h.service.check(intent())
    expect(h.calls.spend).toHaveLength(2)
    h.setConfig({ limits: [limit({ id: "t", limit: 1000 })] })
    await h.service.check(intent())
    expect(h.calls.spend).toHaveLength(3)
  })

  test("a hold with only a prompt estimate, or only a reply estimate, is still written ahead", async () => {
    for (const estimate of [
      { estimateInputTokens: 10 },
      { estimateOutputTokens: 10 },
    ]) {
      const h = harness([tokens()])
      const decision = await h.service.reserve(intent(estimate))
      expect(decision.ok).toBe(true)
      expect(h.calls.opened).toHaveLength(1)
      if (decision.ok) await decision.hold.release("aborted")
      expect(h.calls.closed).toHaveLength(1)
    }
  })

  test("rolling windows of each token measure say what they count", async () => {
    for (const measure of ["input", "output", "total"] as const) {
      const h = harness([
        tokens({ measure, limitReset: { every: { minutes: 10 } } }),
      ])
      h.emit(
        event({
          createdAtMs: NOON - MINUTE,
          inputTokens: 1000,
          outputTokens: 1000,
        }),
      )
      const refused = await h.service.check(intent())
      expect(refused.ok).toBe(false)
      if (!refused.ok) {
        expect(refused.refusal.message).toContain("Usage counts for 10 min.")
      }
    }
  })

  test("a rolling token window ages out like spend does", async () => {
    const h = harness([tokens({ limitReset: { every: { minutes: 10 } } })])
    h.emit(event({ createdAtMs: NOON - 10 * MINUTE, inputTokens: 1000 }))
    expect((await h.service.check(intent())).ok).toBe(true)
    h.emit(event({ createdAtMs: NOON - 10 * MINUTE + 1, inputTokens: 1000 }))
    const refused = await h.service.check(intent())
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.refusal.resetsAtMs).toBe(NOON + 1)
      expect(refused.refusal.message).toContain("Usage counts for 10 min.")
    }
  })
})

const capped = (
  max: number,
  extra: Partial<Parameters<typeof limit>[0]> = {},
) =>
  limit({
    id: "burst",
    limit: 1000 * AIU,
    maxRequests: max,
    limitReset: { every: { minutes: 10 } },
    ...extra,
  })

describe("a request cap", () => {
  test("admits up to the cap and refuses the next, whatever the requests cost", async () => {
    const h = harness([capped(3)])
    h.emit(event({ createdAtMs: NOON - 3 * MINUTE }))
    h.emit(event({ createdAtMs: NOON - 2 * MINUTE }))
    expect((await h.service.check(intent())).ok).toBe(true)
    h.emit(event({ createdAtMs: NOON - MINUTE }))
    const refused = await h.service.check(intent())
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.refusal).toMatchObject({
        limitId: "burst",
        unit: "requests",
        limit: 3,
        used: 3,
        held: 0,
        requested: 1,
        inFlight: false,
      })
      expect(refused.refusal.message).toContain(
        "it has made 3 of its 3 requests",
      )
      // Room returns when the oldest request is ten minutes old.
      expect(refused.refusal.resetsAtMs).toBe(NOON - 3 * MINUTE + 10 * MINUTE)
    }
  })

  test("room returns as requests age out, to the millisecond", async () => {
    const h = harness([capped(1)])
    h.emit(event({ createdAtMs: NOON - 10 * MINUTE }))
    expect((await h.service.check(intent())).ok).toBe(true)
    h.emit(event({ createdAtMs: NOON - 10 * MINUTE + 1 }))
    expect((await h.service.check(intent())).ok).toBe(false)
    h.setNow(NOON + 1)
    expect((await h.service.check(intent())).ok).toBe(true)
  })

  test("room returns when the oldest request ages out, wherever it was recorded", async () => {
    const h = harness([capped(3)])
    await h.service.check(intent())
    // Newest first, oldest in the middle.
    h.emit(event({ createdAtMs: NOON - MINUTE }))
    h.emit(event({ createdAtMs: NOON - 4 * MINUTE }))
    h.emit(event({ createdAtMs: NOON - 2 * MINUTE }))
    const refused = await h.service.check(intent())
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.refusal.resetsAtMs).toBe(NOON - 4 * MINUTE + 10 * MINUTE)
    }
  })

  test("adding or removing a cap reloads the ledger so it has the requests it needs", async () => {
    const h = harness([limit({ id: "burst", limit: 1000 * AIU })])
    h.emit(event({ createdAtMs: NOON - MINUTE }))
    h.emit(event({ createdAtMs: NOON - 2 * MINUTE }))
    expect((await h.service.check(intent())).ok).toBe(true)
    expect(h.calls.spend).toHaveLength(1)

    h.setConfig({ limits: [capped(2, { limitReset: "daily" })] })
    expect((await h.service.check(intent())).ok).toBe(false)
    expect(h.calls.spend).toHaveLength(2)

    h.setConfig({
      limits: [limit({ id: "burst", limit: 1000 * AIU, limitReset: "daily" })],
    })
    expect((await h.service.check(intent())).ok).toBe(true)
    expect(h.calls.spend).toHaveLength(3)
  })

  test("a calendar period counts from its start, and its reset is its end", async () => {
    const h = harness([capped(2, { limitReset: "daily" })])
    h.emit(event({ createdAtMs: Date.UTC(2026, 10, 10, 23, 59) }))
    h.emit(event({ createdAtMs: Date.UTC(2026, 10, 11, 1) }))
    expect((await h.service.check(intent())).ok).toBe(true)
    h.emit(event({ createdAtMs: Date.UTC(2026, 10, 11, 2) }))
    const refused = await h.service.check(intent())
    expect(refused.ok).toBe(false)
    if (!refused.ok)
      expect(refused.refusal.resetsAtMs).toBe(Date.UTC(2026, 10, 12))
  })

  test("counts the rows of its scope, recorded live or before the check", async () => {
    const h = harness([capped(1, { scope: { kind: "key", id: "ci" } })])
    h.emit(event({ key: "laptop" }))
    expect((await h.service.check(intent({ key: "ci" }))).ok).toBe(true)
    h.emit(event({ key: "ci", createdAtMs: NOON - 1000 }))
    expect((await h.service.check(intent({ key: "ci" }))).ok).toBe(false)
    expect((await h.service.check(intent({ key: "laptop" }))).ok).toBe(true)
  })

  test("the amount can refuse too, and the cap is a different refusal", async () => {
    const h = harness([capped(100, { limit: AIU })])
    h.emit(event({ nanoAiu: AIU }))
    const refused = await h.service.check(intent())
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.refusal.unit).toBe("nano_aiu")
  })

  test("only requests that arrive after the ledger loaded are added once", async () => {
    const h = harness([capped(2)])
    const gate = h.deferSpend()
    const pending = h.service.check(intent())
    await gate.started
    h.emit(event({ createdAtMs: NOON - 1000 }))
    h.emit(event({ createdAtMs: NOON - 500 }))
    gate.release()
    expect((await pending).ok).toBe(false)
  })

  test("an orphan without a usage row does not invent a recorded request", async () => {
    const h = harness([capped(1)])
    const decision = await h.service.reserve(
      intent({ estimateNanoAiu: AIU / 10 }),
    )
    if (!decision.ok) throw new Error("expected admission")

    await decision.hold.unreconcile("usage-missing")

    expect((await h.service.check(intent())).ok).toBe(true)
  })

  test("a warn rule never refuses on its cap", async () => {
    const h = harness([capped(1, { action: "warn" })])
    h.emit(event({ createdAtMs: NOON - 1000 }))
    h.emit(event({ createdAtMs: NOON - 500 }))
    expect((await h.service.check(intent())).ok).toBe(true)
  })

  test("a limit with no cap keeps no request list", async () => {
    const h = harness([limit({ id: "plain" })])
    await h.service.check(intent())
    expect(h.calls.requestReads).toBe(0)
    const capHarness = harness([capped(5)])
    await capHarness.service.check(intent())
    expect(capHarness.calls.requestReads).toBe(1)
  })
})

describe("a rule that applies only while away", () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping
  const conditional = () =>
    limit({ id: "away", limit: AIU, when: { locked: true, idleMinutes: 30 } })

  test("is not enforced while presence is unknown or the person is there", async () => {
    const h = harness([conditional()])
    h.emit(event({ nanoAiu: 5 * AIU }))
    expect((await h.service.check(intent())).ok).toBe(true)
    h.setPresence({ locked: null, idleSeconds: null })
    expect((await h.service.check(intent())).ok).toBe(true)
    h.setPresence({ locked: false, idleSeconds: 10 })
    expect((await h.service.check(intent())).ok).toBe(true)
    expect(h.warnings).toEqual([])
  })

  test("refuses once the screen is locked, or after the idle time", async () => {
    const h = harness([conditional()])
    h.emit(event({ nanoAiu: 5 * AIU }))
    h.setPresence({ locked: true, idleSeconds: 0 })
    const locked = await h.service.check(intent())
    expect(locked.ok).toBe(false)
    h.setPresence({ locked: false, idleSeconds: 1800 })
    expect((await h.service.check(intent())).ok).toBe(false)
    h.setPresence({ locked: false, idleSeconds: 1799 })
    expect((await h.service.check(intent())).ok).toBe(true)
    // Back at the machine: enforcement stops at once.
    h.setPresence(undefined)
    expect((await h.service.check(intent())).ok).toBe(true)
  })

  test("keeps counting while it isn't enforced", async () => {
    const h = harness([conditional()])
    await h.service.check(intent())
    h.emit(event({ nanoAiu: 5 * AIU }))
    h.setPresence({ locked: true, idleSeconds: 0 })
    expect((await h.service.check(intent())).ok).toBe(false)
  })

  test("a rule with no condition is unaffected by presence", async () => {
    const h = harness([limit({ id: "always" })])
    h.emit(event({ nanoAiu: 5 * AIU }))
    for (const presence of [undefined, { locked: false, idleSeconds: 0 }]) {
      h.setPresence(presence)
      expect((await h.service.check(intent())).ok).toBe(false)
    }
  })

  test("warnings are held back too", async () => {
    const h = harness([conditional()])
    h.emit(event({ nanoAiu: 0.9 * AIU }))
    await h.service.check(intent())
    expect(h.warnings).toEqual([])
    h.setPresence({ locked: true, idleSeconds: 0 })
    await h.service.check(intent())
    expect(h.warnings).toHaveLength(1)
  })
})
