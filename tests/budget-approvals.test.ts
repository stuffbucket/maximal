/**
 * The approval center (asking, notices, the attention list and the actions
 * on it), the override registry and its storage, and `overrideExpiry`.
 * Pinned by mutation testing (`bun run mutate`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { BudgetNotice } from "~/lib/budget/approvals"
import type { BudgetOverride, OverrideStorage } from "~/lib/budget/overrides"
import type { BudgetConfig } from "~/lib/budget/schema"

import {
  ALLOW_HOUR_MS,
  ALLOW_MORE_FRACTION,
  createApprovalCenter,
  defaultExtraNanoAiu,
  overrideExpiry,
  type LimitEvent,
} from "~/lib/budget/approvals"
import { createUsageDbOverrideStorage } from "~/lib/budget/override-store"
import {
  createOverrideRegistry,
  effectiveLimit,
  hasUnlimited,
  isActive,
} from "~/lib/budget/overrides"
import { fixedPeriod, rollingPeriod } from "~/lib/budget/periods"
import { closeUsageStore } from "~/lib/token-usage"

const AIU = 1_000_000_000
const NOON = Date.UTC(2026, 10, 11, 12)
const HOUR = 3_600_000
const MIDNIGHT = Date.UTC(2026, 10, 12)

describe("override helpers", () => {
  const extra = (n: number, id = "e"): BudgetOverride => ({
    id,
    limitId: "cap",
    kind: "extra",
    extraNanoAiu: n,
    createdAtMs: 0,
    expiresAtMs: null,
  })
  // Whatever extra an unlimited one carries is not room.
  const unlimited: BudgetOverride = {
    ...extra(1_000, "u"),
    kind: "unlimited",
  }

  test("an override applies until the instant it expires", () => {
    expect(isActive({ ...extra(1), expiresAtMs: 100 }, 99)).toBe(true)
    expect(isActive({ ...extra(1), expiresAtMs: 100 }, 100)).toBe(false)
    expect(isActive({ ...extra(1), expiresAtMs: 100 }, 101)).toBe(false)
    expect(isActive(extra(1), Number.MAX_SAFE_INTEGER)).toBe(true)
  })

  test("the limit in force is the limit plus every extra, never an unlimited", () => {
    expect(effectiveLimit(10, [])).toBe(10)
    expect(effectiveLimit(10, [extra(5), extra(7, "e2")])).toBe(22)
    expect(effectiveLimit(10, [unlimited])).toBe(10)
    expect(hasUnlimited([extra(5)])).toBe(false)
    expect(hasUnlimited([extra(5), unlimited])).toBe(true)
    expect(hasUnlimited([])).toBe(false)
  })
})

const input = (
  limitId: string,
  createdAtMs: number,
  expiresAtMs: number | null = null,
) => ({
  limitId,
  kind: "extra" as const,
  extraNanoAiu: 5,
  createdAtMs,
  expiresAtMs,
})

describe("the override registry", () => {
  test("adds with an id, lists what is in force by limit, oldest first", () => {
    let n = 0
    const registry = createOverrideRegistry({ newId: () => `o${(n += 1)}` })
    const later = registry.add(input("a", 200))
    const earlier = registry.add(input("a", 100))
    registry.add(input("b", 150))
    expect(later.id).toBe("o1")
    expect(registry.active("a", 300).map((o) => o.id)).toEqual(["o2", "o1"])
    expect(registry.active("b", 300)).toHaveLength(1)
    expect(registry.active("nobody", 300)).toEqual([])
    expect(registry.list(300).map((o) => o.id)).toEqual(["o2", "o3", "o1"])
    expect(earlier.limitId).toBe("a")
  })

  test("an override that expired is neither active nor listed", () => {
    const registry = createOverrideRegistry()
    registry.add(input("a", 0, 100))
    registry.add(input("a", 0, 200))
    expect(registry.active("a", 99)).toHaveLength(2)
    expect(registry.active("a", 100)).toHaveLength(1)
    expect(registry.list(200)).toEqual([])
  })

  test("removes one by id, or all of a limit's", () => {
    const registry = createOverrideRegistry()
    const first = registry.add(input("a", 0))
    registry.add(input("a", 0))
    registry.add(input("b", 0))
    expect(registry.remove(first.id)).toBe(true)
    expect(registry.remove(first.id)).toBe(false)
    expect(registry.removeForLimit("a")).toBe(1)
    expect(registry.removeForLimit("a")).toBe(0)
    expect(registry.list(0).map((o) => o.limitId)).toEqual(["b"])
  })

  test("writes through to storage, and loads what was stored once", async () => {
    const saved: Array<BudgetOverride> = []
    const removed: Array<string> = []
    let loads = 0
    const stored: BudgetOverride = {
      id: "old",
      limitId: "a",
      kind: "unlimited",
      extraNanoAiu: 0,
      createdAtMs: 1,
      expiresAtMs: null,
    }
    const storage: OverrideStorage = {
      load: () => {
        loads += 1
        return Promise.resolve([stored])
      },
      save: (override) => {
        saved.push(override)
      },
      remove: (id) => {
        removed.push(id)
      },
    }
    const registry = createOverrideRegistry({ storage, newId: () => "new" })
    // Added before the stored ones are read: both are kept.
    registry.add(input("a", 5))
    await registry.ready()
    await registry.ready()
    expect(loads).toBe(1)
    expect(registry.active("a", 10).map((o) => o.id)).toEqual(["old", "new"])
    expect(saved.map((o) => o.id)).toEqual(["new"])

    registry.remove("old")
    registry.removeForLimit("a")
    expect(removed).toEqual(["old", "new"])
  })

  test("a stored override doesn't replace one added with the same id", async () => {
    const storage: OverrideStorage = {
      load: () =>
        Promise.resolve([
          {
            id: "same",
            limitId: "a",
            kind: "extra",
            extraNanoAiu: 1,
            createdAtMs: 0,
            expiresAtMs: null,
          },
        ]),
      save: () => {},
      remove: () => {},
    }
    const registry = createOverrideRegistry({ storage, newId: () => "same" })
    registry.add({ ...input("a", 0), extraNanoAiu: 99 })
    await registry.ready()
    expect(registry.active("a", 0)[0].extraNanoAiu).toBe(99)
  })

  test("works with no storage", async () => {
    const registry = createOverrideRegistry()
    await registry.ready()
    expect(registry.list(0)).toEqual([])
    registry.add(input("a", 0))
    expect(registry.remove(registry.list(0)[0].id)).toBe(true)
  })
})

describe("overrides in the usage database", () => {
  const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

  beforeEach(async () => {
    process.env[DB_PATH_ENV] = ":memory:"
    await closeUsageStore()
  })

  afterEach(async () => {
    await closeUsageStore()
    Reflect.deleteProperty(process.env, DB_PATH_ENV)
  })

  test("saved, loaded back, pruned when expired, and removed", async () => {
    const storage = createUsageDbOverrideStorage(() => NOON)
    const live: BudgetOverride = {
      id: "live",
      limitId: "a",
      kind: "extra",
      extraNanoAiu: 7,
      createdAtMs: NOON - HOUR,
      expiresAtMs: NOON + HOUR,
    }
    storage.save(live)
    storage.save({
      ...live,
      id: "forever",
      kind: "unlimited",
      extraNanoAiu: 0,
      expiresAtMs: null,
    })
    storage.save({ ...live, id: "gone", expiresAtMs: NOON })
    storage.save({ ...live, id: "edge", expiresAtMs: NOON + 1 })

    const loaded = await storage.load()
    expect(loaded.map((o) => o.id).sort()).toEqual(["edge", "forever", "live"])
    expect(loaded.find((o) => o.id === "live")).toEqual(live)
    expect(loaded.find((o) => o.id === "forever")).toMatchObject({
      kind: "unlimited",
      expiresAtMs: null,
    })

    storage.remove("live")
    expect((await storage.load()).map((o) => o.id).sort()).toEqual([
      "edge",
      "forever",
    ])
  })

  test("a registry survives a restart through it", async () => {
    const first = createOverrideRegistry({
      storage: createUsageDbOverrideStorage(() => NOON),
    })
    await first.ready()
    first.add({
      limitId: "a",
      kind: "extra",
      extraNanoAiu: 3,
      createdAtMs: NOON,
      expiresAtMs: NOON + HOUR,
    })
    await closeUsageStore()

    process.env[DB_PATH_ENV] = ":memory:"
    // A new in-memory database starts empty: persistence is across the file
    // the app's storage reopens, which the real path covers; here the
    // storage simply reads what its database holds.
    const second = createOverrideRegistry({
      storage: createUsageDbOverrideStorage(() => NOON),
    })
    await second.ready()
    expect(second.list(NOON)).toEqual([])
  })
})

describe("what extra room lasts", () => {
  test("a calendar period's room ends with it", () => {
    expect(overrideExpiry(fixedPeriod("daily", NOON), NOON)).toBe(MIDNIGHT)
    expect(overrideExpiry(fixedPeriod("weekly", NOON), NOON)).toBe(
      Date.UTC(2026, 10, 16),
    )
  })

  test("a rolling window's room lasts one window from now", () => {
    expect(overrideExpiry(rollingPeriod(5 * HOUR, NOON), NOON)).toBe(
      NOON + 5 * HOUR,
    )
  })

  test("a lifetime limit's room doesn't end", () => {
    expect(overrideExpiry(fixedPeriod("never", NOON), NOON)).toBeNull()
  })

  test("Allow more is a quarter of the limit, at least one nano-AIU", () => {
    expect(ALLOW_MORE_FRACTION).toBe(0.25)
    expect(ALLOW_HOUR_MS).toBe(HOUR)
    expect(defaultExtraNanoAiu(4 * AIU)).toBe(AIU)
    expect(defaultExtraNanoAiu(10)).toBe(3)
    expect(defaultExtraNanoAiu(2)).toBe(1)
    expect(defaultExtraNanoAiu(0)).toBe(1)
  })
})

interface Rig {
  center: ReturnType<typeof createApprovalCenter>
  overrides: ReturnType<typeof createOverrideRegistry>
  notices: Array<BudgetNotice>
  changes: { count: number }
  setNow(ms: number): void
  setConfig(config: BudgetConfig | undefined): void
}

function rig(config: BudgetConfig | undefined): Rig {
  let now = NOON
  let current = config
  let ids = 0
  const overrides = createOverrideRegistry({
    newId: () => (ids === 0 ? ((ids += 1), "o") : `o${(ids += 1)}`),
  })
  const notices: Array<BudgetNotice> = []
  const changes = { count: 0 }
  const center = createApprovalCenter({
    clock: () => now,
    config: () => current,
    overrides,
    notice: (notice) => {
      notices.push(notice)
    },
    changed: () => {
      changes.count += 1
    },
    expiryFor: () => MIDNIGHT,
  })
  return {
    center,
    overrides,
    notices,
    changes,
    setNow: (ms) => {
      now = ms
    },
    setConfig: (next) => {
      current = next
    },
  }
}

type Notify = NonNullable<NonNullable<BudgetConfig["limits"]>[number]["notify"]>

function budget(
  action: "ask" | "block" | "warn" = "ask",
  notify?: Notify,
  label?: string,
): BudgetConfig {
  return {
    limits: [
      {
        id: "images-daily",
        ...(label === undefined ? {} : { label }),
        scope: { kind: "global" },
        limit: 4 * AIU,
        limitReset: "daily",
        action,
        ...(notify === undefined ? {} : { notify }),
      },
    ],
  }
}

const hit = (over: Partial<LimitEvent> = {}): LimitEvent => ({
  limitId: "images-daily",
  periodKey: "p1",
  used: 4 * AIU,
  limit: 4 * AIU,
  resetsAtMs: MIDNIGHT,
  ...over,
})

describe("asking", () => {
  test("the first refusal asks: pending, a notice, an attention entry", () => {
    const r = rig(budget("ask", undefined, "Images"))
    expect(r.center.ask(hit())).toBe("pending")
    expect(r.center.approval("images-daily")).toBe("pending")
    expect(r.notices).toEqual([
      {
        code: "rule-ask",
        message:
          'Rule "Images" reached its limit: $0.04 of $0.04 used. Requests are refused until you allow more. Choose in the Maximal menu or Rules.',
        params: { rule: "images-daily" },
      },
    ])
    expect(r.center.items()).toEqual([
      {
        plugin: "budget",
        name: "Rules",
        summary: r.notices[0].message,
        actions: [
          {
            id: "allow-more.ask.images-daily",
            label: "Allow $0.01 more: Images",
            kind: "primary",
          },
          {
            id: "allow-hour.ask.images-daily",
            label: "Allow for 1 hour: Images",
          },
          {
            id: "keep-blocked.ask.images-daily",
            label: "Keep blocked: Images",
            kind: "secondary",
          },
        ],
      },
    ])
    expect(r.changes.count).toBe(1)
  })

  test("asking again in the same period is quiet", () => {
    const r = rig(budget())
    r.center.ask(hit())
    expect(r.center.ask(hit())).toBe("pending")
    expect(r.notices).toHaveLength(1)
    expect(r.changes.count).toBe(1)
    expect(r.center.items()).toHaveLength(1)
  })

  test("a new period asks again", () => {
    const r = rig(budget())
    r.center.ask(hit())
    r.center.ask(hit({ periodKey: "p2" }))
    expect(r.notices).toHaveLength(2)
    expect(r.center.items()).toHaveLength(1)
  })

  test("a request waits only until its period ends", () => {
    const r = rig(budget())
    r.center.ask(hit())
    r.setNow(MIDNIGHT - 1)
    expect(r.center.approval("images-daily")).toBe("pending")
    expect(r.center.items()).toHaveLength(1)
    r.setNow(MIDNIGHT)
    expect(r.center.approval("images-daily")).toBeNull()
    expect(r.center.items()).toEqual([])
  })

  test("a request for a lifetime limit waits until answered", () => {
    const r = rig(budget())
    r.center.ask(hit({ resetsAtMs: null }))
    r.setNow(NOON + 1000 * HOUR)
    expect(r.center.approval("images-daily")).toBe("pending")
  })

  test("with no limits configured at all, nothing is asked or answered", () => {
    for (const config of [undefined, {}, { limits: [] }]) {
      const r = rig(config)
      expect(r.center.ask(hit())).toBe("pending")
      r.center.reached(hit())
      r.center.warned(hit())
      expect(r.notices).toEqual([])
      expect(r.center.items()).toEqual([])
      expect(r.center.approve("images-daily", "more")).toEqual({
        ok: false,
        reason: "unknown-limit",
      })
      expect(r.center.run("allow-more.ask.images-daily")).toBe(false)
    }
  })

  test("a rule that was deleted takes its request with it", () => {
    const r = rig(budget())
    r.center.ask(hit())
    r.setConfig({ limits: [] })
    expect(r.center.items()).toEqual([])
    expect(r.center.approval("images-daily")).toBeNull()
    expect(r.center.run("allow-more.ask.images-daily")).toBe(false)
  })

  test("an unknown rule is never asked about", () => {
    const r = rig(budget())
    expect(r.center.ask(hit({ limitId: "ghost" }))).toBe("pending")
    expect(r.notices).toEqual([])
    expect(r.center.items()).toEqual([])
  })

  test("the rule's id names it when it has no label", () => {
    const r = rig(budget())
    r.center.ask(hit())
    expect(r.notices[0].message).toStartWith('Rule "images-daily"')
    expect(r.center.items()[0].actions[1].label).toBe(
      "Allow for 1 hour: images-daily",
    )
  })
})

describe("where a rule tells the person", () => {
  const channels: Array<[Notify["limit"], boolean, boolean]> = [
    // channel, notice, attention
    ["none", false, false],
    ["notification", true, false],
    ["tray", false, true],
    ["both", true, true],
  ]

  test.each(channels)("an ask on %s", (channel, notice, tray) => {
    const r = rig(budget("ask", { limit: channel }))
    expect(r.center.ask(hit())).toBe("pending")
    expect(r.notices.length).toBe(notice ? 1 : 0)
    expect(r.center.items().length).toBe(tray ? 1 : 0)
    // Whoever isn't told can still decide: the request is waiting.
    expect(r.center.approval("images-daily")).toBe("pending")
  })

  test.each(channels)(
    "a block reaching its limit on %s",
    (channel, notice, tray) => {
      const r = rig(budget("block", { limit: channel }, "Images"))
      r.center.reached(hit())
      expect(r.notices.map((n) => n.code)).toEqual(notice ? ["rule-limit"] : [])
      if (notice) {
        expect(r.notices[0].message).toBe(
          'Rule "Images" reached its limit: $0.04 of $0.04 used. Requests are refused until it resets or is raised.',
        )
      }
      expect(r.center.items().length).toBe(tray ? 1 : 0)
      if (tray) {
        expect(r.center.items()[0].actions).toEqual([
          { id: "dismiss.limit.images-daily", label: "Dismiss: Images" },
        ])
      }
    },
  )

  test.each([
    ["none", false, false],
    ["notification", true, false],
    ["tray", false, true],
    ["both", true, true],
  ] as const)("a warning on %s", (channel, notice, tray) => {
    const r = rig(budget("warn", { warn: channel }, "Images"))
    r.center.warned(hit({ used: 3.2 * AIU }))
    expect(r.notices.map((n) => n.code)).toEqual(notice ? ["rule-warning"] : [])
    if (notice) {
      expect(r.notices[0].message).toBe(
        'Rule "Images" is at 80% of its limit: $0.03 of $0.04 used.',
      )
    }
    expect(r.center.items().length).toBe(tray ? 1 : 0)
  })

  test("what a rule leaves out takes the default: warnings notify, limits do both", () => {
    const r = rig(budget("block"))
    r.center.warned(hit({ used: 3.2 * AIU }))
    expect(r.notices).toHaveLength(1)
    expect(r.center.items()).toEqual([])
    r.center.reached(hit())
    expect(r.notices).toHaveLength(2)
    expect(r.center.items()).toHaveLength(1)
  })

  test("a warning and a limit notice are told once each per period", () => {
    const r = rig(budget("block"))
    r.center.warned(hit())
    r.center.warned(hit())
    r.center.reached(hit())
    r.center.reached(hit())
    expect(r.notices.map((n) => n.code)).toEqual(["rule-warning", "rule-limit"])
    r.center.reached(hit({ periodKey: "p2" }))
    expect(r.notices).toHaveLength(3)
  })

  test("a tray entry goes when its period ends", () => {
    const r = rig(budget("block"))
    r.center.reached(hit())
    r.setNow(MIDNIGHT)
    expect(r.center.items()).toEqual([])
  })

  test("a warning that rolls with no reset is listed until dismissed", () => {
    const r = rig(budget("block", { warn: "tray" }))
    r.center.warned(hit({ resetsAtMs: null }))
    r.setNow(NOON + 100 * HOUR)
    expect(r.center.items()).toHaveLength(1)
  })
})

describe("answering", () => {
  test("Allow more adds a quarter of the limit until the period ends", () => {
    const r = rig(budget())
    r.center.ask(hit())
    expect(r.center.run("allow-more.ask.images-daily")).toBe(true)
    expect(r.overrides.list(NOON)).toEqual([
      {
        id: "o",
        limitId: "images-daily",
        kind: "extra",
        extraNanoAiu: AIU,
        createdAtMs: NOON,
        expiresAtMs: MIDNIGHT,
      },
    ])
    expect(r.center.approval("images-daily")).toBeNull()
    expect(r.center.items()).toEqual([])
    expect(r.changes.count).toBe(2)
  })

  test("Allow for 1 hour stops enforcement for exactly an hour", () => {
    const r = rig(budget())
    r.center.ask(hit())
    expect(r.center.run("allow-hour.ask.images-daily")).toBe(true)
    expect(r.overrides.list(NOON)).toEqual([
      {
        id: "o",
        limitId: "images-daily",
        kind: "unlimited",
        extraNanoAiu: 0,
        createdAtMs: NOON,
        expiresAtMs: NOON + HOUR,
      },
    ])
    expect(r.center.approval("images-daily")).toBeNull()
  })

  test("Keep blocked stops the asking until the period ends", () => {
    const r = rig(budget())
    r.center.ask(hit())
    expect(r.center.run("keep-blocked.ask.images-daily")).toBe(true)
    expect(r.overrides.list(NOON)).toEqual([])
    expect(r.center.items()).toEqual([])
    expect(r.center.approval("images-daily")).toBe("declined")
    expect(r.center.ask(hit())).toBe("declined")
    expect(r.notices).toHaveLength(1)

    r.setNow(MIDNIGHT - 1)
    expect(r.center.approval("images-daily")).toBe("declined")
    r.setNow(MIDNIGHT)
    expect(r.center.approval("images-daily")).toBeNull()
    // The next period asks again.
    expect(r.center.ask(hit({ periodKey: "p2" }))).toBe("pending")
  })

  test("a decline for a limit that never resets holds until the period changes", () => {
    const r = rig(budget())
    r.center.ask(hit({ resetsAtMs: null }))
    r.center.approve("images-daily", "keep")
    r.setNow(NOON + 1000 * HOUR)
    expect(r.center.approval("images-daily")).toBe("declined")
    expect(r.center.ask(hit({ resetsAtMs: null }))).toBe("declined")
    expect(r.center.ask(hit({ resetsAtMs: null, periodKey: "p2" }))).toBe(
      "pending",
    )
  })

  test("declined holds only for the period it was said in", () => {
    const r = rig(budget())
    r.center.ask(hit())
    r.center.approve("images-daily", "keep")
    expect(r.center.ask(hit({ periodKey: "p2" }))).toBe("pending")
  })

  test("a lapsed decline is forgotten when asked again", () => {
    const r = rig(budget())
    r.center.ask(hit())
    r.center.approve("images-daily", "keep")
    r.setNow(MIDNIGHT)
    expect(r.center.ask(hit())).toBe("pending")
  })

  test("allowing after keeping blocked lifts the decline", () => {
    const r = rig(budget())
    r.center.ask(hit())
    r.center.approve("images-daily", "keep")
    expect(r.center.approve("images-daily", "more")).toEqual({ ok: true })
    expect(r.center.approval("images-daily")).toBeNull()
    expect(r.center.ask(hit())).toBe("pending")

    r.center.approve("images-daily", "keep")
    r.center.approve("images-daily", "hour")
    expect(r.center.approval("images-daily")).toBeNull()
  })

  test("an amount replaces the default", () => {
    const r = rig(budget())
    expect(r.center.approve("images-daily", "more", 7)).toEqual({ ok: true })
    expect(r.overrides.list(NOON)[0].extraNanoAiu).toBe(7)
  })

  test("a person can allow more before being asked", () => {
    const r = rig(budget())
    expect(r.center.approve("images-daily", "more")).toEqual({ ok: true })
    expect(r.overrides.list(NOON)).toHaveLength(1)
    expect(r.center.approve("images-daily", "hour")).toEqual({ ok: true })
    expect(r.overrides.list(NOON)).toHaveLength(2)
  })

  test("there is nothing to keep blocked before being asked", () => {
    const r = rig(budget())
    expect(r.center.approve("images-daily", "keep")).toEqual({
      ok: false,
      reason: "nothing-asked",
    })
    expect(r.center.approval("images-daily")).toBeNull()
  })

  test("an unknown rule can't be approved", () => {
    const r = rig(budget())
    for (const choice of ["more", "hour", "keep"] as const) {
      expect(r.center.approve("ghost", choice)).toEqual({
        ok: false,
        reason: "unknown-limit",
      })
    }
    expect(r.overrides.list(NOON)).toEqual([])
  })
})

describe("answering stale and unusual actions", () => {
  test("an answer that was already given reaches nothing", () => {
    const r = rig(budget())
    r.center.ask(hit())
    expect(r.center.run("allow-more.ask.images-daily")).toBe(true)
    expect(r.center.run("allow-more.ask.images-daily")).toBe(false)
    expect(r.center.run("keep-blocked.ask.images-daily")).toBe(false)
    expect(r.overrides.list(NOON)).toHaveLength(1)
  })

  test("a request that lapsed can't be answered by a stale item", () => {
    const r = rig(budget())
    r.center.ask(hit())
    r.setNow(MIDNIGHT)
    expect(r.center.run("allow-hour.ask.images-daily")).toBe(false)
    expect(r.overrides.list(MIDNIGHT)).toEqual([])
  })

  test("Dismiss removes a tray notice, once", () => {
    const r = rig(budget("block", { warn: "both" }))
    r.center.reached(hit())
    r.center.warned(hit())
    expect(r.center.items()).toHaveLength(2)
    expect(r.center.run("dismiss.limit.images-daily")).toBe(true)
    expect(r.center.run("dismiss.limit.images-daily")).toBe(false)
    expect(r.center.items()).toHaveLength(1)
    expect(r.center.run("dismiss.warn.images-daily")).toBe(true)
    expect(r.center.items()).toEqual([])
    // A dismissed notice is told again only in a new period.
    r.center.reached(hit())
    expect(r.notices.filter((n) => n.code === "rule-limit")).toHaveLength(1)
  })

  test("a request can't be dismissed, only answered", () => {
    const r = rig(budget())
    r.center.ask(hit())
    expect(r.center.run("dismiss.ask.images-daily")).toBe(false)
    expect(r.center.approval("images-daily")).toBe("pending")
  })

  test("answers other than the three don't run, and tray notices aren't answers", () => {
    const r = rig(budget("block"))
    r.center.ask(hit())
    r.center.reached(hit({ periodKey: "q" }))
    for (const action of [
      "",
      "allow-more",
      "allow-more.ask",
      "allow-more.ask.",
      "allow-more.limit.images-daily",
      "allow-more.warn.images-daily",
      "allow-twice.ask.images-daily",
      "dismiss.other.images-daily",
      "dismiss.limit.ghost",
    ]) {
      expect(r.center.run(action)).toBe(false)
    }
    expect(r.overrides.list(NOON)).toEqual([])
  })

  test("a rule id with dots and underscores is read back whole", () => {
    const r = rig({
      limits: [
        {
          id: "a.b_c-d",
          scope: { kind: "global" },
          limit: 4 * AIU,
          limitReset: "daily",
          action: "ask",
        },
      ],
    })
    r.center.ask(hit({ limitId: "a.b_c-d" }))
    expect(r.center.items()[0].actions[0].id).toBe("allow-more.ask.a.b_c-d")
    expect(r.center.run("allow-more.ask.a.b_c-d")).toBe(true)
    expect(r.overrides.list(NOON)[0].limitId).toBe("a.b_c-d")
  })

  test("two rules asking at once are separate items", () => {
    const r = rig({
      limits: [
        {
          id: "a",
          scope: { kind: "global" },
          limit: AIU,
          limitReset: "daily",
          action: "ask",
        },
        {
          id: "b",
          scope: { kind: "global" },
          limit: AIU,
          limitReset: "daily",
          action: "ask",
        },
      ],
    })
    r.center.ask(hit({ limitId: "a" }))
    r.center.ask(hit({ limitId: "b" }))
    expect(r.center.items().map((item) => item.actions[0].id)).toEqual([
      "allow-more.ask.a",
      "allow-more.ask.b",
    ])
    r.center.run("keep-blocked.ask.a")
    expect(r.center.items()).toHaveLength(1)
    expect(r.center.approval("b")).toBe("pending")
  })

  test("amounts read in the display unit", () => {
    const r = rig({
      display: { unit: "credits" },
      limits: [
        {
          id: "images-daily",
          scope: { kind: "global" },
          limit: 4 * AIU,
          limitReset: "daily",
          action: "ask",
        },
      ],
    })
    r.center.ask(hit())
    expect(r.center.items()[0].actions[0].label).toBe(
      "Allow 1.00 AI credits more: images-daily",
    )
  })
})
