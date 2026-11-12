/**
 * Ask limits and overrides in the service: what refuses, what an override
 * changes at the boundary, who is told, and that a failing handler never
 * fails a call. Pinned by mutation testing (`bun run mutate`).
 */

import { describe, expect, spyOn, test } from "bun:test"
import consola from "consola"

import type { LimitEvent } from "~/lib/budget/approvals"
import type { BudgetOverride } from "~/lib/budget/overrides"

import { createOverrideRegistry } from "~/lib/budget/overrides"

import {
  AIU,
  NOON,
  event,
  harness,
  intent,
  limit,
} from "./helpers/budget-service-harness"

const HOUR = 3_600_000

function setup(
  action: "ask" | "block" | "warn" = "ask",
  extra: Partial<Parameters<typeof limit>[0]> = {},
) {
  const overrides = createOverrideRegistry({ newId: () => "o1" })
  const asked: Array<LimitEvent> = []
  const reached: Array<LimitEvent> = []
  const h = harness([limit({ id: "cap", action, ...extra })], {
    approvals: {
      overrides,
      onAsk: (e) => {
        asked.push(e)
        return "pending"
      },
      onLimitReached: (e) => {
        reached.push(e)
      },
    },
  })
  return { h, overrides, asked, reached }
}

function grant(
  overrides: ReturnType<typeof createOverrideRegistry>,
  input: Partial<Omit<BudgetOverride, "id">> = {},
): void {
  overrides.add({
    limitId: "cap",
    kind: "extra",
    extraNanoAiu: AIU,
    createdAtMs: NOON,
    expiresAtMs: null,
    ...input,
  })
}

describe("an ask limit", () => {
  test("refuses like block, and the refusal says approval is pending", async () => {
    const { h, asked } = setup()
    h.emit(event({ nanoAiu: AIU }))

    const decision = await h.service.check(intent())

    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.refusal.approval).toBe("pending")
      expect(decision.refusal.limitId).toBe("cap")
      expect(decision.refusal.message).toContain("blocked this request")
      expect(decision.refusal.message).toEndWith(
        "Approval was requested in Maximal: allow more in the menu-bar list or the Rules window, then retry.",
      )
    }
    expect(asked).toHaveLength(1)
    const [first] = asked
    expect(first.periodKey.startsWith("global|")).toBe(true)
    expect({ ...first, periodKey: "" }).toEqual({
      limitId: "cap",
      periodKey: "",
      unit: "nano_aiu",
      used: AIU,
      limit: AIU,
      resetsAtMs: Date.UTC(2026, 10, 12),
    })
  })

  test("a declined ask is still a refusal, with no hint", async () => {
    const h = harness([limit({ id: "cap", action: "ask" })], {
      approvals: { onAsk: () => "declined" },
    })
    h.emit(event({ nanoAiu: AIU }))
    const decision = await h.service.check(intent())
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.refusal.approval).toBe("declined")
      expect(decision.refusal.message).not.toContain("Approval was requested")
    }
  })

  test("with nobody to ask, it is a plain block, and says nothing about approval", async () => {
    const warn = spyOn(consola, "warn").mockImplementation(
      Object.assign(() => {}, { raw: () => {} }),
    )
    try {
      const h = harness([limit({ id: "cap", action: "ask" })])
      h.emit(event({ nanoAiu: AIU }))
      const decision = await h.service.check(intent())
      expect(decision.ok).toBe(false)
      if (!decision.ok) {
        expect(decision.refusal).not.toHaveProperty("approval")
        expect(decision.refusal.message).not.toContain("Approval")
      }
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test("a block limit with nobody to tell is quiet", async () => {
    const warn = spyOn(consola, "warn").mockImplementation(
      Object.assign(() => {}, { raw: () => {} }),
    )
    try {
      const h = harness([limit({ id: "cap" })])
      h.emit(event({ nanoAiu: AIU }))
      expect((await h.service.check(intent())).ok).toBe(false)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test("room under the limit is admitted, and asks nobody", async () => {
    const { h, asked, reached } = setup()
    h.emit(event({ nanoAiu: 0.5 * AIU }))
    expect((await h.service.check(intent())).ok).toBe(true)
    expect(
      (await h.service.reserve(intent({ estimateNanoAiu: 0.5 * AIU }))).ok,
    ).toBe(true)
    expect(asked).toEqual([])
    expect(reached).toEqual([])
  })

  test("calls in flight holding the room are not the limit being reached", async () => {
    const { h, asked } = setup()
    const first = await h.service.reserve(intent({ estimateNanoAiu: AIU }))
    expect(first.ok).toBe(true)
    const second = await h.service.reserve(intent({ estimateNanoAiu: 1 }))
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.refusal.inFlight).toBe(true)
      expect(second.refusal.approval).toBeUndefined()
    }
    expect(asked).toEqual([])
  })

  test("asks on every refusal (the person's answer is remembered elsewhere)", async () => {
    const { h, asked } = setup()
    h.emit(event({ nanoAiu: AIU }))
    await h.service.check(intent())
    await h.service.check(intent())
    expect(asked).toHaveLength(2)
  })

  test("a handler that throws never fails the call", async () => {
    const warn = spyOn(consola, "warn").mockImplementation(
      Object.assign(() => {}, { raw: () => {} }),
    )
    try {
      const h = harness([limit({ id: "cap", action: "ask" })], {
        approvals: {
          onAsk: () => {
            throw new Error("handler failed")
          },
        },
      })
      h.emit(event({ nanoAiu: AIU }))
      const decision = await h.service.check(intent())
      expect(decision.ok).toBe(false)
      expect(warn.mock.calls[0][0]).toBe("Budget: a limit handler failed")
    } finally {
      warn.mockRestore()
    }
  })

  test("a warn limit never refuses or asks", async () => {
    const { h, asked, reached } = setup("warn")
    h.emit(event({ nanoAiu: 5 * AIU }))
    expect((await h.service.check(intent())).ok).toBe(true)
    expect(asked).toEqual([])
    expect(reached).toEqual([])
  })
})

describe("a block limit reaching its limit", () => {
  test("tells onLimitReached once per period, with the period it belongs to", async () => {
    const { h, reached, asked } = setup("block")
    h.emit(event({ nanoAiu: AIU }))
    await h.service.check(intent())
    await h.service.check(intent())
    expect(reached).toHaveLength(1)
    expect(reached[0]).toMatchObject({
      limitId: "cap",
      used: AIU,
      limit: AIU,
      resetsAtMs: Date.UTC(2026, 10, 12),
    })
    expect(asked).toEqual([])

    // Tomorrow is another period.
    h.setNow(Date.UTC(2026, 10, 12, 1))
    h.emit(event({ nanoAiu: AIU, createdAtMs: Date.UTC(2026, 10, 12, 0, 30) }))
    await h.service.check(intent())
    expect(reached).toHaveLength(2)
  })

  test("is told again after the limit has had room", async () => {
    const { h, reached } = setup("block", {
      limitReset: { every: { hours: 5 } },
    })
    h.emit(event({ nanoAiu: AIU, createdAtMs: NOON - HOUR }))
    await h.service.check(intent())
    expect(reached).toHaveLength(1)

    // The spend ages out: a call fits, which re-arms the notice.
    h.setNow(NOON + 5 * HOUR)
    expect((await h.service.check(intent())).ok).toBe(true)
    h.emit(event({ nanoAiu: AIU, createdAtMs: NOON + 5 * HOUR }))
    await h.service.check(intent())
    expect(reached).toHaveLength(2)
  })

  test("calls in flight don't count as reaching it", async () => {
    const { h, reached } = setup("block")
    await h.service.reserve(intent({ estimateNanoAiu: AIU }))
    await h.service.reserve(intent({ estimateNanoAiu: 1 }))
    expect(reached).toEqual([])
  })

  test("a handler that throws never fails the call", async () => {
    const warn = spyOn(consola, "warn").mockImplementation(
      Object.assign(() => {}, { raw: () => {} }),
    )
    try {
      const h = harness([limit({ id: "cap" })], {
        approvals: {
          onLimitReached: () => {
            throw new Error("handler failed")
          },
        },
      })
      h.emit(event({ nanoAiu: AIU }))
      expect((await h.service.check(intent())).ok).toBe(false)
      expect(warn.mock.calls[0][0]).toBe("Budget: a limit handler failed")
    } finally {
      warn.mockRestore()
    }
  })
})

describe("extra room", () => {
  test("raises the limit by exactly the extra, at the boundary", async () => {
    const { h, overrides } = setup("block")
    grant(overrides, { extraNanoAiu: AIU })
    h.emit(event({ nanoAiu: AIU }))

    // 2 AIU is the cap: 1 used, so 1 fits and one more nano-AIU doesn't.
    expect((await h.service.check(intent({ estimateNanoAiu: AIU }))).ok).toBe(
      true,
    )
    const over = await h.service.check(intent({ estimateNanoAiu: AIU + 1 }))
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.refusal.limit).toBe(2 * AIU)

    h.emit(event({ nanoAiu: AIU }))
    const spent = await h.service.check(intent())
    expect(spent.ok).toBe(false)
    if (!spent.ok) {
      expect(spent.refusal.limit).toBe(2 * AIU)
      expect(spent.refusal.message).toContain("$0.02 of $0.02 used")
    }
  })

  test("extras add up, and another limit's don't count", async () => {
    const overrides = createOverrideRegistry()
    const h = harness([limit({ id: "cap" }), limit({ id: "other" })], {
      approvals: { overrides },
    })
    overrides.add({
      limitId: "cap",
      kind: "extra",
      extraNanoAiu: AIU,
      createdAtMs: NOON,
      expiresAtMs: null,
    })
    overrides.add({
      limitId: "cap",
      kind: "extra",
      extraNanoAiu: AIU,
      createdAtMs: NOON,
      expiresAtMs: null,
    })
    overrides.add({
      limitId: "elsewhere",
      kind: "extra",
      extraNanoAiu: 9 * AIU,
      createdAtMs: NOON,
      expiresAtMs: null,
    })
    h.emit(event({ nanoAiu: 0.9 * AIU }))
    // `other` still stops at 1 AIU; `cap` would allow 3.
    const decision = await h.service.check(
      intent({ estimateNanoAiu: 0.2 * AIU }),
    )
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.refusal.limitId).toBe("other")
  })

  test("stops applying exactly when it expires", async () => {
    const { h, overrides } = setup("block")
    grant(overrides, { expiresAtMs: NOON + HOUR })
    h.emit(event({ nanoAiu: AIU }))
    expect((await h.service.check(intent())).ok).toBe(true)

    h.setNow(NOON + HOUR - 1)
    expect((await h.service.check(intent())).ok).toBe(true)
    h.setNow(NOON + HOUR)
    expect((await h.service.check(intent())).ok).toBe(false)
  })

  test("the warning threshold moves with the limit", async () => {
    const { h, overrides } = setup("block")
    grant(overrides, { extraNanoAiu: AIU })
    // 1.5 AIU is under 80% of the 2 AIU in force.
    h.emit(event({ nanoAiu: 1.5 * AIU }))
    await h.service.check(intent())
    expect(h.warnings).toEqual([])

    h.emit(event({ nanoAiu: 0.1 * AIU }))
    await h.service.check(intent())
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0].limit).toBe(2 * AIU)
  })

  test("the decision log carries the limit in force", async () => {
    const { h, overrides } = setup("block")
    grant(overrides, { extraNanoAiu: AIU })
    h.emit(event({ nanoAiu: 2 * AIU }))
    await h.service.check(intent())
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({
      kind: "refused",
      limitId: "cap",
      usedNanoAiu: 2 * AIU,
      limitNanoAiu: 2 * AIU,
    })
    // Without the override the same limit logs its own amount.
    const plain = harness([limit({ id: "cap" })])
    plain.emit(event({ nanoAiu: 2 * AIU }))
    await plain.service.check(intent())
    expect(plain.events[0].limitNanoAiu).toBe(AIU)
  })
})

describe("an hour's allowance", () => {
  test("a limit that is allowed isn't enforced or warned about", async () => {
    const { h, overrides, asked, reached } = setup("ask")
    grant(overrides, {
      kind: "unlimited",
      extraNanoAiu: 0,
      expiresAtMs: NOON + HOUR,
    })
    h.emit(event({ nanoAiu: 5 * AIU }))

    expect((await h.service.check(intent())).ok).toBe(true)
    expect((await h.service.reserve(intent({ estimateNanoAiu: AIU }))).ok).toBe(
      true,
    )
    expect(h.warnings).toEqual([])
    expect(asked).toEqual([])
    expect(reached).toEqual([])
  })

  test("it is enforced again the moment it expires", async () => {
    const { h, overrides } = setup("block")
    grant(overrides, {
      kind: "unlimited",
      extraNanoAiu: 0,
      expiresAtMs: NOON + HOUR,
    })
    h.emit(event({ nanoAiu: 5 * AIU }))
    h.setNow(NOON + HOUR - 1)
    expect((await h.service.check(intent())).ok).toBe(true)
    h.setNow(NOON + HOUR)
    expect((await h.service.check(intent())).ok).toBe(false)
  })

  test("it covers only its own limit", async () => {
    const overrides = createOverrideRegistry()
    const h = harness([limit({ id: "cap" }), limit({ id: "other" })], {
      approvals: { overrides },
    })
    overrides.add({
      limitId: "cap",
      kind: "unlimited",
      extraNanoAiu: 0,
      createdAtMs: NOON,
      expiresAtMs: null,
    })
    h.emit(event({ nanoAiu: 5 * AIU }))
    const decision = await h.service.check(intent())
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.refusal.limitId).toBe("other")
  })
})

describe("overrides that only answer", () => {
  test("a service whose overrides have no loading step still checks", async () => {
    const h = harness([limit({ id: "cap" })], {
      approvals: {
        overrides: {
          active: () => [
            {
              id: "o",
              limitId: "cap",
              kind: "extra",
              extraNanoAiu: AIU,
              createdAtMs: NOON,
              expiresAtMs: null,
            },
          ],
        },
      },
    })
    h.emit(event({ nanoAiu: AIU }))
    expect((await h.service.check(intent())).ok).toBe(true)
  })

  test("held room is counted with no config at all", () => {
    const h = harness([limit({ id: "cap" })])
    h.setConfig(undefined)
    expect(h.service.heldNanoAiu({ kind: "global" })).toBe(0)
    expect(h.service.heldNanoAiu({ kind: "filter", id: "x" })).toBe(0)
  })
})

describe("overrides load before the first check", () => {
  test("the service waits for the stored overrides", async () => {
    const order: Array<string> = []
    const h = harness([limit({ id: "cap" })], {
      approvals: {
        overrides: {
          ready: async () => {
            await Promise.resolve()
            order.push("ready")
          },
          active: () => {
            order.push("active")
            return []
          },
        },
      },
    })
    h.emit(event({ nanoAiu: 0 }))
    await h.service.check(intent())
    expect(order[0]).toBe("ready")
    expect(order).toContain("active")
  })
})
