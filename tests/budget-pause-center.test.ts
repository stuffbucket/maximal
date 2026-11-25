/**
 * Pause rules: what the service says (a refusal that may be held), and what
 * the approval center tells the person about held requests.
 */

import { describe, expect, test } from "bun:test"

import type { BudgetNotice, LimitEvent } from "~/lib/budget/approvals"
import type { BudgetConfig } from "~/lib/budget/schema"

import { createApprovalCenter } from "~/lib/budget/approvals"
import { createOverrideRegistry } from "~/lib/budget/overrides"
import { BudgetConfigSchema } from "~/lib/budget/schema"
import {
  BudgetApproveRequest,
  BudgetLimitPutRequest,
} from "~/lib/config/settings-types"

import {
  AIU,
  NOON,
  event,
  harness,
  intent,
  limit,
} from "./helpers/budget-service-harness"

describe("a pause rule in the service", () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping
  const paused = (extra: Partial<Parameters<typeof limit>[0]> = {}) =>
    limit({ id: "cap", action: "pause", ...extra })

  test("its refusal may be held", async () => {
    const h = harness([paused()])
    h.emit(event({ nanoAiu: AIU }))
    const decision = await h.service.check(intent())
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.refusal.pause).toBe(true)
      expect(decision.refusal.limitId).toBe("cap")
    }
  })

  test("a block rule's refusal may not", async () => {
    const h = harness([limit({ id: "cap" })])
    h.emit(event({ nanoAiu: AIU }))
    const decision = await h.service.check(intent())
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.refusal).not.toHaveProperty("pause")
  })

  test("a call is held only if every rule that refuses it only pauses", async () => {
    const both = harness([paused(), limit({ id: "block" })])
    both.emit(event({ nanoAiu: AIU }))
    const refused = await both.service.check(intent())
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.refusal).not.toHaveProperty("pause")

    const two = harness([paused(), paused({ id: "other" })])
    two.emit(event({ nanoAiu: AIU }))
    const held = await two.service.check(intent())
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.refusal.pause).toBe(true)
  })

  test("room taken by calls in flight is retried, not held", async () => {
    const h = harness([paused()])
    const first = await h.service.reserve(intent({ estimateNanoAiu: AIU }))
    expect(first.ok).toBe(true)
    const second = await h.service.reserve(intent({ estimateNanoAiu: 1 }))
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.refusal.inFlight).toBe(true)
      expect(second.refusal).not.toHaveProperty("pause")
    }
  })

  test("is told to nobody as 'reached': the held request is what tells the person", async () => {
    const reached: Array<LimitEvent> = []
    const h = harness([paused()], {
      approvals: {
        onLimitReached: (e) => {
          reached.push(e)
        },
      },
    })
    h.emit(event({ nanoAiu: AIU }))
    await h.service.check(intent())
    expect(reached).toEqual([])
  })

  test("a token or request cap can pause too", async () => {
    const h = harness([paused({ unit: "tokens", limit: 100, maxRequests: 2 })])
    h.emit(event({ inputTokens: 50 }))
    h.emit(event({ inputTokens: 50 }))
    const decision = await h.service.check(intent())
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.refusal.pause).toBe(true)
  })
})

interface Rig {
  center: ReturnType<typeof createApprovalCenter>
  overrides: ReturnType<typeof createOverrideRegistry>
  notices: Array<BudgetNotice>
  held: Map<string, number>
  calls: Array<string>
}

function rig(config: BudgetConfig | undefined = pauseBudget()): Rig {
  const overrides = createOverrideRegistry()
  const notices: Array<BudgetNotice> = []
  const held = new Map<string, number>()
  const calls: Array<string> = []
  const center = createApprovalCenter({
    clock: () => NOON,
    config: () => config,
    overrides,
    notice: (notice) => {
      notices.push(notice)
    },
    changed: () => {
      calls.push("changed")
    },
    heldCount: (id) => held.get(id) ?? 0,
    wake: (id) => {
      calls.push(`wake ${id}`)
    },
    resumeHeld: (id) => {
      calls.push(`resume ${id}`)
      return held.get(id) ?? 0
    },
    cancelHeld: (id) => {
      calls.push(`cancel ${id}`)
      return held.get(id) ?? 0
    },
    expiryFor: () => NOON + 5 * 3_600_000,
  })
  return { center, overrides, notices, held, calls }
}

function pauseBudget(
  notify?: NonNullable<BudgetConfig["limits"]>[number]["notify"],
): BudgetConfig {
  return {
    limits: [
      {
        id: "agents",
        label: "Agents",
        scope: { kind: "global" },
        limit: 4 * AIU,
        limitReset: "daily",
        action: "pause",
        ...(notify === undefined ? {} : { notify }),
      },
    ],
  }
}

const hit: LimitEvent = {
  limitId: "agents",
  periodKey: "p",
  unit: "nano_aiu",
  used: 4 * AIU,
  limit: 4 * AIU,
  resetsAtMs: NOON + 3_600_000,
}

describe("telling the person about held requests", () => {
  test("the first held request raises a notice and an entry with the four choices", () => {
    const r = rig()
    r.held.set("agents", 3)
    r.center.paused(hit)
    expect(r.notices).toEqual([
      {
        code: "rule-paused",
        message:
          'Paused 3 requests: rule "Agents" reached its limit ($0.04 of $0.04 used). Resume, allow more or cancel them from the Maximal menu or Rules.',
        params: { rule: "agents" },
      },
    ])
    const [item] = r.center.items()
    expect(item.summary).toBe(r.notices[0].message)
    expect(item.actions).toEqual([
      {
        id: "resume-once.pause.agents",
        label: "Resume once: Agents",
        kind: "primary",
      },
      { id: "allow-more.pause.agents", label: "Allow $0.01 more: Agents" },
      { id: "resume-reset.pause.agents", label: "Resume until reset: Agents" },
      {
        id: "cancel.pause.agents",
        label: "Cancel paused requests: Agents",
        kind: "destructive",
      },
    ])
  })

  test("one request is worded as one", () => {
    const r = rig()
    r.held.set("agents", 1)
    r.center.paused(hit)
    expect(r.notices[0].message).toStartWith('Paused 1 request: rule "Agents"')
  })

  test("the summary counts what is held now", () => {
    const r = rig()
    r.held.set("agents", 1)
    r.center.paused(hit)
    r.held.set("agents", 7)
    expect(r.center.items()[0].summary).toStartWith("Paused 7 requests:")
  })

  test("more held requests in the same episode are not told again", () => {
    const r = rig()
    r.held.set("agents", 1)
    r.center.paused(hit)
    r.held.set("agents", 2)
    r.center.paused(hit)
    expect(r.notices).toHaveLength(1)
  })

  test("when none are left the entry goes, and the next one starts a new episode", () => {
    const r = rig()
    r.held.set("agents", 1)
    r.center.paused(hit)
    r.held.set("agents", 0)
    r.center.heldChanged()
    expect(r.center.items()).toEqual([])
    r.held.set("agents", 1)
    r.center.paused(hit)
    expect(r.notices).toHaveLength(2)
    expect(r.center.items()).toHaveLength(1)
  })

  test("an entry whose requests left is not listed even before the change arrives", () => {
    const r = rig()
    r.held.set("agents", 1)
    r.center.paused(hit)
    r.held.set("agents", 0)
    // Listed only while something is held.
    expect(r.center.items()).toEqual([])
  })

  test("a held-count change tells the shell", () => {
    const r = rig()
    r.center.heldChanged()
    expect(r.calls).toEqual(["changed"])
  })

  test("notify.limit routes the notice and the entry", () => {
    for (const [channel, notice, entry] of [
      ["none", 0, 0],
      ["notification", 1, 0],
      ["tray", 0, 1],
      ["both", 1, 1],
    ] as const) {
      const r = rig(pauseBudget({ limit: channel }))
      r.held.set("agents", 2)
      r.center.paused(hit)
      expect(r.notices).toHaveLength(notice)
      expect(r.center.items()).toHaveLength(entry)
    }
  })

  test("a request cap offers no more room, since room can't lift it", () => {
    const r = rig()
    r.held.set("agents", 2)
    r.center.paused({ ...hit, unit: "requests", used: 100, limit: 100 })
    expect(r.center.items()[0].actions.map((action) => action.id)).toEqual([
      "resume-once.pause.agents",
      "resume-reset.pause.agents",
      "cancel.pause.agents",
    ])
    expect(r.center.run("allow-more.pause.agents")).toBe(false)
  })

  test("an unknown rule is never told about", () => {
    const r = rig()
    r.held.set("ghost", 1)
    r.center.paused({ ...hit, limitId: "ghost" })
    expect(r.notices).toEqual([])
    expect(r.center.items()).toEqual([])
  })
})

describe("answering for held requests", () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping
  function held(): Rig {
    const r = rig()
    r.held.set("agents", 2)
    r.center.paused(hit)
    r.calls.length = 0
    return r
  }

  test("Resume once lets them through and changes nothing about the rule", () => {
    const r = held()
    expect(r.center.run("resume-once.pause.agents")).toBe(true)
    expect(r.calls).toEqual(["resume agents", "changed"])
    expect(r.overrides.list(NOON)).toEqual([])
  })

  test("Allow more records extra room and wakes the requests to look again", () => {
    const r = held()
    expect(r.center.run("allow-more.pause.agents")).toBe(true)
    expect(r.overrides.list(NOON)).toMatchObject([
      { limitId: "agents", kind: "extra", extraNanoAiu: AIU },
    ])
    expect(r.calls).toEqual(["wake agents", "changed"])
  })

  test("Resume until reset lifts the rule until its period resets, and wakes them", () => {
    const r = held()
    expect(r.center.run("resume-reset.pause.agents")).toBe(true)
    expect(r.overrides.list(NOON)).toMatchObject([
      {
        limitId: "agents",
        kind: "unlimited",
        extraNanoAiu: 0,
        expiresAtMs: NOON + 5 * 3_600_000,
      },
    ])
    expect(r.calls).toEqual(["wake agents", "changed"])
  })

  test("until reset falls back to an hour for a limit that never resets", () => {
    const overrides = createOverrideRegistry()
    const center = createApprovalCenter({
      clock: () => NOON,
      config: () => pauseBudget(),
      overrides,
      notice: () => {},
      changed: () => {},
      expiryFor: () => null,
    })
    expect(center.approve("agents", "reset")).toEqual({ ok: true })
    expect(overrides.list(NOON)[0].expiresAtMs).toBe(NOON + 3_600_000)
  })

  test("Cancel fails them, and says so only if there were some", () => {
    const r = held()
    expect(r.center.run("cancel.pause.agents")).toBe(true)
    expect(r.calls).toEqual(["cancel agents"])
    r.held.set("agents", 0)
    r.center.heldChanged()
    expect(r.center.run("cancel.pause.agents")).toBe(false)
  })

  test("resume through the API's choice needs something held", () => {
    const r = rig()
    expect(r.center.approve("agents", "resume")).toEqual({
      ok: false,
      reason: "nothing-paused",
    })
    r.held.set("agents", 1)
    expect(r.center.approve("agents", "resume")).toEqual({ ok: true })
    expect(r.center.approve("ghost", "resume")).toEqual({
      ok: false,
      reason: "unknown-limit",
    })
  })

  test("an answer for an episode that ended reaches nothing", () => {
    const r = held()
    r.held.set("agents", 0)
    r.center.heldChanged()
    for (const action of [
      "resume-once.pause.agents",
      "allow-more.pause.agents",
      "resume-reset.pause.agents",
      "cancel.pause.agents",
      "keep-blocked.pause.agents",
      "allow-hour.pause.agents",
      "frobnicate.pause.agents",
    ]) {
      expect(r.center.run(action)).toBe(false)
    }
  })

  test("verbs that belong to another kind don't cross over", () => {
    const r = held()
    for (const action of [
      "keep-blocked.pause.agents",
      "allow-hour.pause.agents",
      "frobnicate.pause.agents",
      "resume-once.ask.agents",
      "cancel.limit.agents",
    ]) {
      expect(r.center.run(action)).toBe(false)
    }
  })

  test("allowing or lifting an ask rule also wakes anything held", () => {
    const r = rig()
    r.center.approve("agents", "more")
    r.center.approve("agents", "hour")
    expect(r.calls.filter((call) => call === "wake agents")).toHaveLength(2)
    r.calls.length = 0
    r.center.approve("agents", "keep")
    expect(r.calls).toEqual([])
  })
})

describe("the pause rule's settings and wire shapes", () => {
  const base = {
    id: "p",
    scope: { kind: "global" },
    limit: 1,
    limitReset: "daily",
    action: "pause",
  }

  test("a rule may pause; how long and how many are bounded", () => {
    const parses = (pause: unknown) =>
      BudgetConfigSchema.safeParse({ limits: [base], pause }).success
    expect(parses(undefined)).toBe(true)
    expect(parses({})).toBe(true)
    expect(parses({ maxWaitSeconds: 1, maxHeld: 1 })).toBe(true)
    expect(parses({ maxWaitSeconds: 3600, maxHeld: 1000 })).toBe(true)
    expect(parses({ maxWaitSeconds: 0 })).toBe(false)
    expect(parses({ maxWaitSeconds: 3601 })).toBe(false)
    expect(parses({ maxWaitSeconds: 1.5 })).toBe(false)
    expect(parses({ maxHeld: 0 })).toBe(false)
    expect(parses({ maxHeld: 1001 })).toBe(false)
    expect(BudgetConfigSchema.safeParse({ limits: [base] }).success).toBe(true)
  })

  test("a PUT may say pause, and an approval may say reset or resume", () => {
    expect(
      BudgetLimitPutRequest.safeParse({
        scope: { kind: "global" },
        limit: 1,
        limit_reset: "daily",
        action: "pause",
      }).success,
    ).toBe(true)
    for (const choice of ["more", "hour", "keep", "reset", "resume"]) {
      expect(BudgetApproveRequest.safeParse({ choice }).success).toBe(true)
    }
    expect(
      BudgetApproveRequest.safeParse({ choice: "reset", extra: 1 }).success,
    ).toBe(false)
    expect(
      BudgetApproveRequest.safeParse({ choice: "resume", amount: 1 }).success,
    ).toBe(false)
    expect(BudgetApproveRequest.safeParse({ choice: "cancel" }).success).toBe(
      false,
    )
  })
})
