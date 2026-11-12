/**
 * The budget service's edges: the limit boundary, scope ordering and
 * isolation, warning arithmetic, the ledger's period edges and the fields a
 * stored hold carries. Pinned by mutation testing (`bun run mutate`).
 */

import { describe, expect, spyOn, test } from "bun:test"
import consola from "consola"

import type { BudgetConfig } from "~/lib/budget/schema"
import type { BudgetHold } from "~/lib/budget/service"

import { settleBudgetUsage } from "~/lib/budget/runtime"

import {
  AIU,
  MIDNIGHT,
  NOON,
  event,
  harness,
  intent,
  limit,
} from "./helpers/budget-service-harness"

/** Capture `consola.warn` without printing; the caller restores it. */
function quietWarn() {
  const silent = Object.assign(() => {}, { raw: () => {} })
  return spyOn(consola, "warn").mockImplementation(silent)
}

describe("usage settlement", () => {
  test("a persistence failure leaves the hold unreconciled", async () => {
    const failure = new Error("database rejected usage")
    let orphanReason = ""
    const hold: BudgetHold = {
      id: "hold-1",
      estimateNanoAiu: AIU,
      persisted: true,
      settle: () => Promise.reject(failure),
      commit: () => Promise.resolve(),
      release: () => Promise.resolve(),
      unreconcile: (reason) => {
        orphanReason = reason
        return Promise.resolve()
      },
    }

    const caught = await settleBudgetUsage(hold, [], AIU).catch(
      (error: unknown) => error,
    )

    expect(caught).toBe(failure)
    expect(orphanReason).toBe("settlement-failed")
  })
})

describe("a service with nothing to enforce", () => {
  test("never starts, reads or subscribes when no limit is enforced", async () => {
    const configs: Array<BudgetConfig | undefined> = [
      undefined,
      {},
      { limits: [] },
      { enabled: false, limits: [limit({ id: "all", limit: 1 })] },
    ]
    for (const config of configs) {
      const h = harness([])
      h.setConfig(config)

      const reserved = await h.service.reserve(intent({ estimateNanoAiu: AIU }))
      const checked = await h.service.check(intent({ estimateNanoAiu: AIU }))

      expect(reserved.ok && reserved.warnings).toEqual([])
      expect(checked.ok && checked.warnings).toEqual([])
      expect(h.calls.recover).toBe(0)
      expect(h.calls.subscribed).toBe(0)
      expect(h.calls.spend).toHaveLength(0)
    }
  })

  test("stop unsubscribes from usage, and is safe before start and twice", async () => {
    const h = harness([limit({ id: "all" })])
    h.service.stop()

    await h.service.check(intent())
    expect(h.listening()).toBe(1)

    h.service.stop()
    h.service.stop()
    expect(h.listening()).toBe(0)
  })
})

describe("the limit boundary", () => {
  test("a call that lands exactly on the limit is only in flight, not spent", async () => {
    const h = harness([limit({ id: "all" })])
    h.emit(event({ nanoAiu: 0.4 * AIU }))
    const other = await h.service.reserve(
      intent({ estimateNanoAiu: 0.1 * AIU }),
    )
    expect(other.ok).toBe(true)

    // 0.4 spent + 0.1 held fits, but 0.6 more would pass the limit. Spent
    // alone plus the 0.6 is exactly the limit, so the refusal is the
    // in-flight kind: it clears when the other call finishes.
    const decision = await h.service.check(
      intent({ estimateNanoAiu: 0.6 * AIU }),
    )

    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.refusal).toMatchObject({
      used: 0.4 * AIU,
      held: 0.1 * AIU,
      requested: 0.6 * AIU,
      inFlight: true,
    })
  })

  test("a call one nano-AIU past the limit with nothing in flight is a hard refusal", async () => {
    const h = harness([limit({ id: "all" })])
    h.emit(event({ nanoAiu: 0.4 * AIU }))

    const decision = await h.service.check(
      intent({ estimateNanoAiu: 0.6 * AIU + 1 }),
    )

    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.refusal.inFlight).toBe(false)
  })

  test("a hard refusal beats an in-flight one when the in-flight limit comes first", async () => {
    // The in-flight limit is global (first in scope order); the hard one is
    // scoped to the key (second). "a hard refusal beats..." above has them
    // the other way round.
    const h = harness([
      limit({ id: "wide", limit: AIU }),
      limit({
        id: "tight",
        limit: 0.5 * AIU,
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
    if (second.ok) return
    expect(second.refusal.limitId).toBe("tight")
    expect(second.refusal.inFlight).toBe(false)
  })
})

const everyScope = (action: "block" | "warn") => [
  limit({ id: "a-key", action, scope: { kind: "key", id: "claude-code" } }),
  limit({
    id: "b-plugin",
    action,
    scope: { kind: "plugin", id: "images" },
  }),
  limit({
    id: "c-provider",
    action,
    scope: { kind: "provider", id: "copilot" },
  }),
  limit({ id: "g-2", action }),
  limit({ id: "g-1", action }),
]

describe("holds and scopes", () => {
  test("a hold counts only against the limits whose scope covers it", async () => {
    const h = harness([
      limit({ id: "everyone", limit: 10 * AIU }),
      limit({ id: "codex", scope: { kind: "key", id: "codex" } }),
    ])
    const elsewhere = await h.service.reserve(
      intent({ key: "other", estimateNanoAiu: 0.9 * AIU }),
    )
    expect(elsewhere.ok).toBe(true)

    expect(h.service.heldNanoAiu({ kind: "key", id: "codex" })).toBe(0)
    expect(h.service.heldNanoAiu({ kind: "key", id: "other" })).toBe(0.9 * AIU)
    expect(h.service.heldNanoAiu({ kind: "global" })).toBe(0.9 * AIU)

    const codex = await h.service.reserve(
      intent({ key: "codex", estimateNanoAiu: 0.5 * AIU }),
    )
    expect(codex.ok).toBe(true)
    expect(h.service.heldNanoAiu({ kind: "key", id: "codex" })).toBe(0.5 * AIU)
  })

  test("limits are applied widest scope first, then by id", async () => {
    // Config order is the reverse of the expected order, and the ids sort
    // against the scopes, so only the scope order and the id tiebreak can
    // produce it.
    const spent = event({ plugin: "images", nanoAiu: AIU })

    const warning = harness(everyScope("warn"))
    warning.emit(spent)
    const warned = await warning.service.check(intent())
    expect(warned.ok && warned.warnings.map((w) => w.limitId)).toEqual([
      "g-1",
      "g-2",
      "c-provider",
      "b-plugin",
      "a-key",
    ])

    const blocking = harness(everyScope("block"))
    blocking.emit(spent)
    const refused = await blocking.service.check(intent())
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.refusal.limitId).toBe("g-1")
  })

  test("a limit whose scope changes is read again for the new scope", async () => {
    const h = harness([
      limit({ id: "cap", scope: { kind: "key", id: "codex" } }),
    ])
    h.emit(event({ key: "codex", nanoAiu: 0.9 * AIU }))
    const before = await h.service.check(
      intent({ key: "codex", estimateNanoAiu: 0.2 * AIU }),
    )
    expect(before.ok).toBe(false)

    h.setConfig({
      limits: [limit({ id: "cap", scope: { kind: "key", id: "other" } })],
    })
    const after = await h.service.check(
      intent({ key: "other", estimateNanoAiu: 0.2 * AIU }),
    )

    expect(after.ok).toBe(true)
    expect(h.calls.spend).toHaveLength(2)
  })

  test("a limit put back after it was removed is read again", async () => {
    const h = harness([limit({ id: "all" })])
    h.emit(event({ nanoAiu: 0.5 * AIU }))
    await h.service.check(intent())

    const other = limit({ id: "other", limit: 100 * AIU })
    h.setConfig({ limits: [other] })
    await h.service.check(intent())
    h.setConfig({ limits: [limit({ id: "all" })] })
    await h.service.check(intent())

    // "all", then "other", then "all" again.
    expect(h.calls.spend).toHaveLength(3)
  })
})

describe("warning arithmetic", () => {
  test("the estimate counts toward the threshold", async () => {
    const h = harness([limit({ id: "all", warnAt: 0.5 })])
    h.emit(event({ nanoAiu: 0.3 * AIU }))

    const decision = await h.service.check(
      intent({ estimateNanoAiu: 0.3 * AIU }),
    )

    expect(decision.ok && decision.warnings).toEqual([
      {
        limitId: "all",
        used: 0.3 * AIU,
        limit: AIU,
        unit: "nano_aiu",
        resetsAtMs: MIDNIGHT,
      },
    ])
  })

  test("what other calls hold counts toward the threshold", async () => {
    const h = harness([limit({ id: "all", warnAt: 0.5 })])
    h.emit(event({ nanoAiu: 0.1 * AIU }))
    const holder = await h.service.reserve(
      intent({ estimateNanoAiu: 0.3 * AIU }),
    )
    expect(holder.ok && holder.warnings).toEqual([])

    const decision = await h.service.check(
      intent({ estimateNanoAiu: 0.25 * AIU }),
    )

    expect(decision.ok && decision.warnings.map((w) => w.limitId)).toEqual([
      "all",
    ])
  })

  test("a total exactly at the threshold warns; one nano-AIU under doesn't", async () => {
    const h = harness([limit({ id: "all", warnAt: 0.5 })])
    h.emit(event({ nanoAiu: 0.5 * AIU - 1 }))
    const under = await h.service.check(intent())
    expect(under.ok && under.warnings).toEqual([])

    h.emit(event({ nanoAiu: 1 }))
    const at = await h.service.check(intent())

    expect(at.ok && at.warnings).toHaveLength(1)
  })

  test("a new period warns again only for the limits whose period changed", async () => {
    const h = harness([
      limit({ id: "a-daily", action: "warn", warnAt: 0.5 }),
      limit({
        id: "b-never",
        action: "warn",
        warnAt: 0.5,
        limitReset: "never",
      }),
    ])
    h.emit(event({ nanoAiu: 0.6 * AIU }))
    await h.service.check(intent())
    expect(h.warnings.map((w) => w.limitId)).toEqual(["a-daily", "b-never"])

    h.setNow(MIDNIGHT + 60_000)
    h.emit(event({ createdAtMs: MIDNIGHT + 30_000, nanoAiu: 0.6 * AIU }))
    await h.service.check(intent())

    expect(h.warnings.map((w) => w.limitId)).toEqual([
      "a-daily",
      "b-never",
      "a-daily",
    ])
  })

  test("a limit that hasn't crossed its threshold isn't announced, now or later", async () => {
    const h = harness([
      limit({ id: "early", action: "warn", warnAt: 0.5 }),
      limit({ id: "late", action: "warn", warnAt: 0.9 }),
    ])
    h.emit(event({ nanoAiu: 0.6 * AIU }))
    await h.service.check(intent())
    expect(h.warnings.map((w) => w.limitId)).toEqual(["early"])

    h.emit(event({ nanoAiu: 0.4 * AIU }))
    await h.service.check(intent())

    expect(h.warnings.map((w) => w.limitId)).toEqual(["early", "late"])
  })

  test("a failing warning handler is logged and doesn't fail the call", async () => {
    const warn = quietWarn()
    try {
      const h = harness([limit({ id: "soft", action: "warn" })], {
        onWarning: "throws",
      })
      h.emit(event({ nanoAiu: AIU }))

      const decision = await h.service.reserve(intent())

      expect(decision.ok).toBe(true)
      expect(h.warnings).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith(
        "Budget: a warning handler failed",
        expect.any(Error),
      )
    } finally {
      warn.mockRestore()
    }
  })

  test("with no warning handler a warning is still returned, and nothing is logged", async () => {
    const warn = quietWarn()
    try {
      const h = harness([limit({ id: "soft", action: "warn" })], {
        onWarning: "none",
      })
      h.emit(event({ nanoAiu: AIU }))

      const decision = await h.service.reserve(intent())

      expect(decision.ok && decision.warnings).toHaveLength(1)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe("the ledger's edges", () => {
  const DAY_START = Date.UTC(2026, 10, 11)

  test("a recorded row counts from the start of the period up to, not including, its end", async () => {
    const h = harness([limit({ id: "all" })])
    await h.service.check(intent())

    h.emit(event({ createdAtMs: DAY_START - 1, nanoAiu: AIU / 2 }))
    h.emit(event({ createdAtMs: DAY_START, nanoAiu: AIU / 5 }))
    h.emit(event({ createdAtMs: MIDNIGHT - 1, nanoAiu: AIU / 10 }))
    h.emit(event({ createdAtMs: MIDNIGHT, nanoAiu: AIU / 4 }))
    h.emit(event({ createdAtMs: MIDNIGHT + 1, nanoAiu: AIU / 4 }))
    const decision = await h.service.check(intent({ estimateNanoAiu: 2 * AIU }))

    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.refusal.used).toBe((AIU * 3) / 10)
  })

  test("a lifetime limit counts every row recorded after it loads", async () => {
    const h = harness([limit({ id: "life", limitReset: "never" })])
    await h.service.check(intent())

    h.emit(event({ createdAtMs: 1, nanoAiu: AIU }))
    const decision = await h.service.check(intent())

    expect(decision.ok).toBe(false)
  })

  test("rows buffered during a load count only when their period and scope match", async () => {
    const h = harness([
      limit({ id: "codex", scope: { kind: "key", id: "codex" } }),
    ])
    const read = h.deferSpend()

    const pending = h.service.check(
      intent({ key: "codex", estimateNanoAiu: 2 * AIU }),
    )
    await read.started
    h.emit(
      event({ key: "codex", createdAtMs: DAY_START - 1, nanoAiu: AIU / 2 }),
    )
    h.emit(event({ key: "codex", createdAtMs: DAY_START, nanoAiu: AIU / 5 }))
    h.emit(event({ key: "codex", createdAtMs: MIDNIGHT, nanoAiu: AIU / 4 }))
    h.emit(event({ key: "claude-code", nanoAiu: AIU / 4 }))
    read.release()
    const decision = await pending

    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.refusal.used).toBe(AIU / 5)
  })

  test("a call waiting for a load waits on it instead of polling the config", async () => {
    const h = harness([limit({ id: "all" })])
    const read = h.deferSpend()

    const pending = h.service.reserve(intent())
    await read.started
    for (let i = 0; i < 20; i++) await Promise.resolve()
    const reads = h.calls.config
    for (let i = 0; i < 20; i++) await Promise.resolve()

    expect(h.calls.config).toBe(reads)
    read.release()
    expect((await pending).ok).toBe(true)
  })

  test("a store that can't be read is logged", async () => {
    const warn = quietWarn()
    try {
      const h = harness([limit({ id: "all" })], { spendFails: true })

      await h.service.check(intent())

      expect(warn).toHaveBeenCalledWith(
        "Budget: could not read spend; counting from now",
        expect.any(Error),
      )
    } finally {
      warn.mockRestore()
    }
  })
})

describe("the fields a stored hold carries", () => {
  test("a hold for a call with no plugin, provider or tool stores none of them", async () => {
    const h = harness([limit({ id: "all" })])

    const decision = await h.service.reserve({
      operation: "messages",
      key: "claude-code",
      estimateNanoAiu: AIU / 10,
      estimateInputTokens: 0,
      estimateOutputTokens: 0,
    })
    if (!decision.ok) throw new Error("expected admission")

    expect(h.calls.opened).toStrictEqual([
      {
        id: decision.hold.id,
        createdAtMs: NOON,
        operation: "messages",
        key: "claude-code",
        estimateNanoAiu: AIU / 10,
        estimateInputTokens: 0,
        estimateOutputTokens: 0,
      },
    ])
  })

  test("a hold stores the provider or the plugin only when the call has one", async () => {
    const h = harness([limit({ id: "all" })])

    await h.service.reserve({
      operation: "messages",
      key: "claude-code",
      provider: "copilot",
      estimateNanoAiu: AIU / 10,
      estimateInputTokens: 0,
      estimateOutputTokens: 0,
    })
    await h.service.reserve({
      operation: "images.edits",
      key: "claude-code",
      plugin: "images",
      estimateNanoAiu: AIU / 10,
      estimateInputTokens: 0,
      estimateOutputTokens: 0,
    })

    expect(h.calls.opened.map(({ id: _id, ...rest }) => rest)).toStrictEqual([
      {
        createdAtMs: NOON,
        operation: "messages",
        key: "claude-code",
        provider: "copilot",
        estimateNanoAiu: AIU / 10,
        estimateInputTokens: 0,
        estimateOutputTokens: 0,
      },
      {
        createdAtMs: NOON,
        operation: "images.edits",
        key: "claude-code",
        plugin: "images",
        estimateNanoAiu: AIU / 10,
        estimateInputTokens: 0,
        estimateOutputTokens: 0,
      },
    ])
  })

  test("a commit closes with the actual cost only when one is given", async () => {
    const h = harness([limit({ id: "all" })])
    const open = async () => {
      const decision = await h.service.reserve(
        intent({ estimateNanoAiu: AIU / 100 }),
      )
      if (!decision.ok) throw new Error("expected admission")
      return decision.hold
    }

    const bare = await open()
    await bare.commit()
    const empty = await open()
    await empty.commit({})
    const billed = await open()
    await billed.commit({ nanoAiu: AIU / 20 })
    const free = await open()
    await free.commit({ nanoAiu: 0 })

    expect(h.calls.closed).toStrictEqual([
      { id: bare.id, state: "committed", closedAtMs: NOON },
      { id: empty.id, state: "committed", closedAtMs: NOON },
      {
        id: billed.id,
        state: "committed",
        actualNanoAiu: AIU / 20,
        closedAtMs: NOON,
      },
      { id: free.id, state: "committed", actualNanoAiu: 0, closedAtMs: NOON },
    ])
  })
})
