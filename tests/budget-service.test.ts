/**
 * The budget service: holds, decisions and the spend ledger, with an injected
 * clock, config, store, provider windows and usage stream (nothing here
 * touches the real database or module-mocks anything).
 */

import { describe, expect, test } from "bun:test"

import type { FollowedWindow } from "~/lib/budget/periods"
import type { BudgetConfig } from "~/lib/budget/schema"

import { scopeMatches } from "~/lib/budget/scope"
import {
  createBudgetService,
  type BudgetIntent,
  type BudgetStore,
  type BudgetWarning,
  type SpendEvent,
  type StoredHold,
} from "~/lib/budget/service"

const AIU = 1_000_000_000
const NOON = Date.UTC(2026, 10, 11, 12, 0, 0)
const MIDNIGHT = Date.UTC(2026, 10, 12, 0, 0, 0)

type Limit = NonNullable<BudgetConfig["limits"]>[number]

function limit(overrides: Partial<Limit> & { id: string }): Limit {
  return {
    scope: { kind: "global" },
    limit: AIU,
    limitReset: "daily",
    action: "block",
    ...overrides,
  }
}

function event(overrides: Partial<SpendEvent> = {}): SpendEvent {
  return {
    createdAtMs: NOON - 60_000,
    nanoAiu: 0,
    key: "claude-code",
    provider: "copilot",
    ...overrides,
  }
}

function intent(overrides: Partial<BudgetIntent> = {}): BudgetIntent {
  return {
    operation: "images.generations",
    key: "claude-code",
    provider: "copilot",
    plugin: "images",
    estimateNanoAiu: 0,
    ...overrides,
  }
}

interface Harness {
  service: ReturnType<typeof createBudgetService>
  setNow(ms: number): void
  setConfig(config: BudgetConfig | undefined): void
  setWindow(ref: string, window: FollowedWindow | undefined): void
  /** Record a usage row: stored, then announced, like the real recorder. */
  emit(row: SpendEvent): void
  rows: Array<SpendEvent>
  warnings: Array<BudgetWarning>
  calls: {
    spend: Array<{ startMs: number; endMs: number | null }>
    recover: number
    subscribed: number
    opened: Array<StoredHold>
    closed: Array<{
      id: string
      state: string
      actualNanoAiu?: number
      closedAtMs: number
    }>
  }
  /** Hold every store read until `releaseSpend()`. */
  deferSpend(): { started: Promise<void>; release(): void }
}

function harness(
  limits: Array<Limit>,
  options: { spendFails?: boolean; enabled?: boolean } = {},
): Harness {
  let now = NOON
  let config: BudgetConfig | undefined = {
    limits,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  }
  const windows = new Map<string, FollowedWindow>()
  const rows: Array<SpendEvent> = []
  const listeners = new Set<(row: SpendEvent) => void>()
  const warnings: Array<BudgetWarning> = []
  let deferred: { started(): void; gate: Promise<void> } | undefined
  const calls: Harness["calls"] = {
    spend: [],
    recover: 0,
    subscribed: 0,
    opened: [],
    closed: [],
  }

  const store: BudgetStore = {
    async spend(scope, range) {
      calls.spend.push(range)
      if (options.spendFails) throw new Error("database is down")
      // Rows recorded before the read are in it; later ones are not.
      const sum = rows
        .filter(
          (row) =>
            row.createdAtMs >= range.startMs
            && (range.endMs === null || row.createdAtMs < range.endMs)
            && scopeMatches(scope, row),
        )
        .reduce((total, row) => total + row.nanoAiu, 0)
      if (deferred) {
        deferred.started()
        await deferred.gate
      }
      return sum
    },
    recover() {
      calls.recover += 1
      return Promise.resolve()
    },
    openHold(hold) {
      calls.opened.push(hold)
    },
    closeHold(close) {
      calls.closed.push(close)
    },
  }

  const service = createBudgetService({
    clock: () => now,
    config: () => config,
    store,
    windows: {
      lookup: (ref) => windows.get(ref),
      ready: () => Promise.resolve(),
    },
    spendEvents: (listener) => {
      calls.subscribed += 1
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onWarning: (warning) => warnings.push(warning),
  })

  return {
    service,
    setNow: (ms) => {
      now = ms
    },
    setConfig: (next) => {
      config = next
    },
    setWindow: (ref, window) => {
      if (window) windows.set(ref, window)
      else windows.delete(ref)
    },
    emit: (row) => {
      rows.push(row)
      for (const listener of listeners) listener(row)
    },
    rows,
    warnings,
    calls,
    deferSpend: () => {
      const gate = Promise.withResolvers<undefined>()
      const started = Promise.withResolvers<undefined>()
      deferred = {
        started: () => {
          started.resolve(undefined)
        },
        gate: gate.promise,
      }
      return {
        started: started.promise,
        release: () => {
          deferred = undefined
          gate.resolve(undefined)
        },
      }
    },
  }
}

describe("with no limit that covers the call", () => {
  test("admits without a hold, a database read or a subscription", async () => {
    const h = harness([
      limit({ id: "images", scope: { kind: "plugin", id: "images" } }),
    ])

    const decision = await h.service.reserve(
      intent({ plugin: "decisions", estimateNanoAiu: 5 * AIU }),
    )

    expect(decision.ok).toBe(true)
    if (decision.ok) expect(decision.hold.estimateNanoAiu).toBe(0)
    expect(h.calls.spend).toHaveLength(0)
    expect(h.calls.opened).toHaveLength(0)
  })

  test("admits with budget switched off, whatever is spent", async () => {
    const h = harness([limit({ id: "all", limit: 1 })], { enabled: false })
    h.emit(event({ nanoAiu: 10 * AIU }))

    const decision = await h.service.reserve(intent({ estimateNanoAiu: AIU }))

    expect(decision.ok).toBe(true)
    expect(h.calls.spend).toHaveLength(0)
  })
})

describe("reserve", () => {
  test("admits a call that fits and holds its estimate until commit", async () => {
    const h = harness([limit({ id: "all" })])

    const decision = await h.service.reserve(
      intent({ estimateNanoAiu: 0.6 * AIU }),
    )

    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.hold.estimateNanoAiu).toBe(0.6 * AIU)
    expect(h.service.heldNanoAiu({ kind: "global" })).toBe(0.6 * AIU)
    decision.hold.commit({ nanoAiu: 0.5 * AIU })
    expect(h.service.heldNanoAiu({ kind: "global" })).toBe(0)
  })

  test("refuses a call that would go over, naming the limit and the reset", async () => {
    const h = harness([limit({ id: "images-daily", label: "Images per day" })])
    h.emit(event({ nanoAiu: 0.8 * AIU }))

    const decision = await h.service.reserve(
      intent({ estimateNanoAiu: 0.6 * AIU }),
    )

    expect(decision.ok).toBe(false)
    if (decision.ok) return
    const { refusal } = decision
    expect(refusal).toMatchObject({
      limitId: "images-daily",
      label: "Images per day",
      limit: AIU,
      used: 0.8 * AIU,
      held: 0,
      requested: 0.6 * AIU,
      resetsAtMs: MIDNIGHT,
      resetEstimated: false,
      inFlight: false,
    })
    expect(refusal.message).toContain('Maximal budget "Images per day"')
    expect(refusal.message).toContain("$0.008 of $0.01 used")
    expect(refusal.message).toContain("this request needs about $0.006")
    expect(refusal.message).toContain("Resets 2026-11-12T00:00:00.000Z")
    expect(refusal.message).toContain("Maximal → Budget")
    expect(h.service.heldNanoAiu({ kind: "global" })).toBe(0)
  })

  test("admits exactly up to the limit, and a call with no estimate while there is room", async () => {
    const h = harness([limit({ id: "all" })])
    h.emit(event({ nanoAiu: 0.4 * AIU }))

    const exact = await h.service.reserve(
      intent({ estimateNanoAiu: 0.6 * AIU }),
    )
    expect(exact.ok).toBe(true)

    // 0.4 spent + 0.6 held = the limit: nothing more fits, even free.
    const gateOnly = await h.service.reserve(intent({ estimateNanoAiu: 0 }))
    expect(gateOnly.ok).toBe(false)
  })

  test("a call with no estimate is refused once the limit is spent, and admitted just under it", async () => {
    const h = harness([limit({ id: "all" })])
    h.emit(event({ nanoAiu: AIU - 1 }))
    expect((await h.service.check(intent())).ok).toBe(true)

    h.emit(event({ nanoAiu: 1 }))
    const spent = await h.service.check(intent())

    expect(spent.ok).toBe(false)
    if (!spent.ok) expect(spent.refusal.inFlight).toBe(false)
  })

  test("concurrent reserves can't both claim the same room", async () => {
    const h = harness([limit({ id: "all" })])

    const [first, second] = await Promise.all([
      h.service.reserve(intent({ estimateNanoAiu: 0.6 * AIU })),
      h.service.reserve(intent({ estimateNanoAiu: 0.6 * AIU })),
    ])

    expect([first.ok, second.ok]).toEqual([true, false])
    if (second.ok) return
    // Only the first call's hold is in the way: it clears by itself.
    expect(second.refusal.inFlight).toBe(true)
    expect(second.refusal.held).toBe(0.6 * AIU)
    expect(second.refusal.message).toContain("requests in progress")
    expect(second.refusal.message).toContain("Try again in a moment")
  })

  test("release frees the room; so does commit once the call is booked", async () => {
    const h = harness([limit({ id: "all" })])
    const first = await h.service.reserve(
      intent({ estimateNanoAiu: 0.6 * AIU }),
    )
    if (!first.ok) throw new Error("expected the first call to be admitted")

    first.hold.release("upstream-error")
    const second = await h.service.reserve(
      intent({ estimateNanoAiu: 0.6 * AIU }),
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return

    // The call finished and was billed 0.7: the usage row is what counts now.
    h.emit(event({ nanoAiu: 0.7 * AIU }))
    second.hold.commit({ nanoAiu: 0.7 * AIU })
    const third = await h.service.reserve(
      intent({ estimateNanoAiu: 0.6 * AIU }),
    )
    expect(third.ok).toBe(false)
    if (!third.ok) {
      expect(third.refusal.used).toBe(0.7 * AIU)
      expect(third.refusal.inFlight).toBe(false)
    }
  })

  test("commit and release are idempotent and the first one wins", async () => {
    const h = harness([limit({ id: "all" })])
    const decision = await h.service.reserve(
      intent({ estimateNanoAiu: 0.6 * AIU }),
    )
    if (!decision.ok) throw new Error("expected admission")

    decision.hold.commit({ nanoAiu: 0.5 * AIU })
    decision.hold.commit({ nanoAiu: 0.9 * AIU })
    decision.hold.release("aborted")

    expect(h.calls.closed).toEqual([
      {
        id: decision.hold.id,
        state: "committed",
        actualNanoAiu: 0.5 * AIU,
        closedAtMs: NOON,
      },
    ])
  })

  test("check previews a decision and holds nothing", async () => {
    const h = harness([limit({ id: "all" })])

    const preview = await h.service.check(
      intent({ estimateNanoAiu: 0.6 * AIU }),
    )

    expect(preview.ok).toBe(true)
    expect(h.service.heldNanoAiu({ kind: "global" })).toBe(0)
    expect(h.calls.opened).toHaveLength(0)
  })
})

describe("scopes", () => {
  const scoped = [
    limit({ id: "key-codex", scope: { kind: "key", id: "codex" }, limit: 1 }),
    limit({
      id: "plugin-images",
      scope: { kind: "plugin", id: "images" },
      limit: 1,
    }),
    limit({
      id: "provider-other",
      scope: { kind: "provider", id: "other" },
      limit: 1,
    }),
  ]

  test("a limit applies only to calls in its scope", async () => {
    const h = harness(scoped)
    h.emit(event({ nanoAiu: AIU, key: "codex", provider: "other" }))
    h.emit(event({ nanoAiu: AIU, key: "x", plugin: "images" }))

    const refusedKey = await h.service.check(
      intent({ key: "codex", plugin: "decisions", provider: "copilot" }),
    )
    const refusedPlugin = await h.service.check(
      intent({ key: "other-key", plugin: "images" }),
    )
    const refusedProvider = await h.service.check(
      intent({ key: "other-key", plugin: "decisions", provider: "other" }),
    )
    const admitted = await h.service.check(
      intent({ key: "other-key", plugin: "decisions", provider: "copilot" }),
    )

    expect(refusedKey.ok ? undefined : refusedKey.refusal.limitId).toBe(
      "key-codex",
    )
    expect(refusedPlugin.ok ? undefined : refusedPlugin.refusal.limitId).toBe(
      "plugin-images",
    )
    expect(
      refusedProvider.ok ? undefined : refusedProvider.refusal.limitId,
    ).toBe("provider-other")
    expect(admitted.ok).toBe(true)
  })

  test("spend counts only the rows its scope covers", async () => {
    const h = harness([
      limit({ id: "codex", scope: { kind: "key", id: "codex" }, limit: AIU }),
    ])
    h.emit(event({ nanoAiu: 0.9 * AIU, key: "claude-code" }))

    const decision = await h.service.reserve(
      intent({ key: "codex", estimateNanoAiu: 0.5 * AIU }),
    )

    expect(decision.ok).toBe(true)
  })

  test("with several limits spent, the one that stays spent longest decides", async () => {
    const h = harness([
      limit({ id: "daily", limit: 1 }),
      limit({ id: "lifetime", limit: 1, limitReset: "never" }),
      limit({ id: "weekly", limit: 1, limitReset: "weekly" }),
    ])
    h.emit(event({ nanoAiu: AIU }))

    const decision = await h.service.check(intent())

    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.refusal.limitId).toBe("lifetime")
    expect(decision.refusal.resetsAtMs).toBeNull()
    expect(decision.refusal.message).toContain("It never resets.")
  })

  test("a hard refusal beats one that only in-flight calls cause", async () => {
    const h = harness([
      limit({ id: "tight", limit: 0.5 * AIU }),
      limit({
        id: "wide",
        limit: AIU,
        scope: { kind: "key", id: "claude-code" },
      }),
    ])
    const first = await h.service.reserve(
      intent({ estimateNanoAiu: 0.4 * AIU }),
    )
    expect(first.ok).toBe(true)
    h.emit(event({ nanoAiu: 0.5 * AIU }))

    const second = await h.service.check(intent({ estimateNanoAiu: 0.3 * AIU }))

    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.refusal.limitId).toBe("tight")
      expect(second.refusal.inFlight).toBe(false)
    }
  })
})

describe("warnings", () => {
  test("a block limit past its threshold admits, warns, and warns once per period", async () => {
    const h = harness([limit({ id: "all", warnAt: 0.5 })])
    h.emit(event({ nanoAiu: 0.6 * AIU }))

    const first = await h.service.reserve(intent())
    const second = await h.service.reserve(intent())

    expect(first.ok && first.warnings).toEqual([
      { limitId: "all", used: 0.6 * AIU, limit: AIU, resetsAtMs: MIDNIGHT },
    ])
    expect(second.ok && second.warnings).toHaveLength(1)
    expect(h.warnings).toHaveLength(1)

    h.setNow(MIDNIGHT + 60_000)
    h.emit(event({ createdAtMs: MIDNIGHT + 30_000, nanoAiu: 0.7 * AIU }))
    await h.service.reserve(intent())
    expect(h.warnings).toHaveLength(2)
  })

  test("a limit under its threshold doesn't warn", async () => {
    const h = harness([limit({ id: "all", warnAt: 0.9 })])
    h.emit(event({ nanoAiu: 0.5 * AIU }))

    const decision = await h.service.reserve(intent())

    expect(decision.ok && decision.warnings).toEqual([])
    expect(h.warnings).toEqual([])
  })

  test("a warn-only limit never refuses, even when spent", async () => {
    const h = harness([limit({ id: "soft", action: "warn" })])
    h.emit(event({ nanoAiu: 3 * AIU }))

    const decision = await h.service.reserve(intent({ estimateNanoAiu: AIU }))

    expect(decision.ok).toBe(true)
    expect(decision.ok && decision.warnings.map((w) => w.limitId)).toEqual([
      "soft",
    ])
    expect(h.warnings).toHaveLength(1)
  })
})

describe("the ledger", () => {
  test("loads the period's spend once, then follows recorded rows", async () => {
    const h = harness([limit({ id: "all" })])
    h.emit(event({ nanoAiu: 0.2 * AIU }))

    await h.service.check(intent())
    await h.service.check(intent())
    h.emit(event({ nanoAiu: 0.5 * AIU }))
    const decision = await h.service.reserve(
      intent({ estimateNanoAiu: 0.4 * AIU }),
    )

    expect(h.calls.spend).toEqual([
      { startMs: Date.UTC(2026, 10, 11), endMs: MIDNIGHT },
    ])
    expect(h.calls.subscribed).toBe(1)
    expect(h.calls.recover).toBe(1)
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.refusal.used).toBe(0.7 * AIU)
  })

  test("ignores rows from before the period", async () => {
    const h = harness([limit({ id: "all" })])
    h.emit(
      event({ createdAtMs: Date.UTC(2026, 10, 10, 23, 59), nanoAiu: 5 * AIU }),
    )
    await h.service.check(intent())

    h.emit(
      event({ createdAtMs: Date.UTC(2026, 10, 10, 23, 59), nanoAiu: 5 * AIU }),
    )

    expect((await h.service.check(intent())).ok).toBe(true)
  })

  test("rows recorded while the period loads are added to it", async () => {
    const h = harness([limit({ id: "all" })])
    h.emit(event({ nanoAiu: 0.2 * AIU }))
    const read = h.deferSpend()

    const pending = h.service.reserve(intent({ estimateNanoAiu: 0.2 * AIU }))
    await read.started
    h.emit(event({ nanoAiu: 0.7 * AIU }))
    read.release()
    const decision = await pending

    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.refusal.used).toBe(0.9 * AIU)
  })

  test("starts a new period at the reset, with that period's spend", async () => {
    const h = harness([limit({ id: "all" })])
    h.emit(event({ nanoAiu: AIU }))
    expect((await h.service.check(intent())).ok).toBe(false)

    h.setNow(MIDNIGHT + 1000)

    expect((await h.service.check(intent())).ok).toBe(true)
    expect(h.calls.spend).toHaveLength(2)
    expect(h.calls.spend[1]).toEqual({
      startMs: MIDNIGHT,
      endMs: MIDNIGHT + 86_400_000,
    })
  })

  test("a limit that follows a provider window resets with it", async () => {
    const reset = Date.UTC(2026, 11, 1)
    const h = harness([
      limit({
        id: "copilot",
        limitReset: { follow: "copilot:premium_interactions" },
      }),
    ])
    h.setWindow("copilot:premium_interactions", {
      resetsAt: new Date(reset).toISOString(),
      previousResetsAt: new Date(Date.UTC(2026, 10, 1)).toISOString(),
    })
    h.emit(event({ createdAtMs: Date.UTC(2026, 10, 2), nanoAiu: AIU }))

    const spent = await h.service.check(intent())
    expect(spent.ok).toBe(false)
    if (!spent.ok) expect(spent.refusal.resetsAtMs).toBe(reset)

    // The provider reports the next cycle: a new period starts.
    h.setNow(reset + 1000)
    h.setWindow("copilot:premium_interactions", {
      resetsAt: new Date(Date.UTC(2027, 0, 1)).toISOString(),
      previousResetsAt: new Date(reset).toISOString(),
    })
    expect((await h.service.check(intent())).ok).toBe(true)
  })

  test("a limit removed from the config stops counting", async () => {
    const h = harness([limit({ id: "all", limit: 1 })])
    h.emit(event({ nanoAiu: AIU }))
    expect((await h.service.check(intent())).ok).toBe(false)

    h.setConfig({ limits: [] })

    expect((await h.service.check(intent())).ok).toBe(true)
  })

  test("a store that can't be read counts from now instead of failing the call", async () => {
    const h = harness([limit({ id: "all" })], { spendFails: true })
    h.emit(event({ nanoAiu: 0.2 * AIU }))

    const first = await h.service.check(intent())
    h.emit(event({ nanoAiu: AIU }))
    const second = await h.service.check(intent())

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
  })
})

describe("holds in the store", () => {
  test("a hold that reserves something is written ahead and closed with the actual cost", async () => {
    const h = harness([limit({ id: "all" })])

    const decision = await h.service.reserve(
      intent({
        operation: "server_tool",
        plugin: "images",
        tool: "generate_image",
        estimateNanoAiu: 0.6 * AIU,
      }),
    )
    if (!decision.ok) throw new Error("expected admission")
    expect(h.calls.opened).toEqual([
      {
        id: decision.hold.id,
        createdAtMs: NOON,
        operation: "server_tool",
        provider: "copilot",
        plugin: "images",
        tool: "generate_image",
        key: "claude-code",
        estimateNanoAiu: 0.6 * AIU,
      },
    ])

    decision.hold.release("upstream-error")
    expect(h.calls.closed).toEqual([
      { id: decision.hold.id, state: "released", closedAtMs: NOON },
    ])
  })

  test("a hold with no estimate isn't written", async () => {
    const h = harness([limit({ id: "all" })])

    const decision = await h.service.reserve(intent())
    if (decision.ok) decision.hold.commit()

    expect(h.calls.opened).toHaveLength(0)
    expect(h.calls.closed).toHaveLength(0)
  })

  test("recovery runs before the first hold opens", async () => {
    const h = harness([limit({ id: "all" })])
    expect(h.calls.recover).toBe(0)

    await h.service.reserve(intent({ estimateNanoAiu: AIU / 10 }))

    expect(h.calls.recover).toBe(1)
    expect(h.calls.opened).toHaveLength(1)
  })
})
