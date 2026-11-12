/**
 * The pause gate: counting held requests, the cap, and what a parked request
 * wakes up to (a look again, a resume, a cancel, the deadline, the client
 * going away). Real timers, a few milliseconds long. Pinned by mutation
 * testing (`bun run mutate`).
 */

import { describe, expect, test } from "bun:test"

import {
  DEFAULT_MAX_HELD,
  DEFAULT_RECHECK_MS,
  createPauseGate,
  type HeldRequest,
} from "~/lib/budget/pause"

const FAR = () => Date.now() + 60_000

function entered(
  gate: ReturnType<typeof createPauseGate>,
  limitId = "cap",
): HeldRequest {
  const held = gate.enter(limitId)
  if (!held) throw new Error("the gate was full")
  return held
}

describe("holding requests", () => {
  test("counts held requests, per limit and in all, until each is released", () => {
    const gate = createPauseGate()
    const a = entered(gate, "a")
    entered(gate, "a")
    const b = entered(gate, "b")
    expect(gate.heldCount()).toBe(3)
    expect(gate.heldCount("a")).toBe(2)
    expect(gate.heldCount("b")).toBe(1)
    expect(gate.heldCount("nobody")).toBe(0)
    expect(gate.heldLimits().sort()).toEqual(["a", "b"])

    a.release()
    b.release()
    expect(gate.heldCount()).toBe(1)
    expect(gate.heldLimits()).toEqual(["a"])
  })

  test("releasing twice frees one slot, not two", () => {
    const changes: Array<number> = []
    const gate = createPauseGate({ onChange: () => changes.push(1) })
    const a = entered(gate)
    entered(gate)
    a.release()
    a.release()
    expect(gate.heldCount()).toBe(1)
    // Two entered, one released.
    expect(changes).toHaveLength(3)
  })

  test("holds up to the cap and no more; a release makes room", () => {
    const gate = createPauseGate({ maxHeld: () => 2 })
    const first = entered(gate)
    entered(gate)
    expect(gate.enter("cap")).toBeUndefined()
    first.release()
    expect(gate.enter("cap")).toBeDefined()
  })

  test("the cap is read each time, so changing it applies at once", () => {
    let max = 1
    const gate = createPauseGate({ maxHeld: () => max })
    entered(gate)
    expect(gate.enter("cap")).toBeUndefined()
    max = 2
    expect(gate.enter("cap")).toBeDefined()
  })

  test("defaults: fifty held, a look every two seconds", () => {
    expect(DEFAULT_MAX_HELD).toBe(50)
    expect(DEFAULT_RECHECK_MS).toBe(2000)
    const gate = createPauseGate()
    for (let n = 0; n < 50; n += 1) entered(gate)
    expect(gate.enter("cap")).toBeUndefined()
  })
})

describe("waiting", () => {
  test("looks again after the recheck interval", async () => {
    const gate = createPauseGate({ recheckMs: 5 })
    const started = Date.now()
    expect(await entered(gate).park({ deadlineMs: FAR() })).toBe("recheck")
    expect(Date.now() - started).toBeGreaterThanOrEqual(4)
  })

  test("never waits past the deadline, and says so", async () => {
    const gate = createPauseGate({ recheckMs: 1000 })
    const held = entered(gate)
    const started = Date.now()
    expect(await held.park({ deadlineMs: started + 15 })).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(500)
  })

  test("a deadline already past is a timeout without waiting", async () => {
    const gate = createPauseGate({ recheckMs: 1000 })
    expect(await entered(gate).park({ deadlineMs: Date.now() - 1 })).toBe(
      "timeout",
    )
    expect(await entered(gate).park({ deadlineMs: Date.now() })).toBe("timeout")
  })

  test("the deadline is read with the clock it is given", async () => {
    const gate = createPauseGate({ recheckMs: 5 })
    let now = 1000
    const held = entered(gate)
    expect(await held.park({ deadlineMs: 1010, now: () => now })).toBe(
      "recheck",
    )
    now = 1010
    expect(await held.park({ deadlineMs: 1010, now: () => now })).toBe(
      "timeout",
    )
  })

  test("the client going away ends the wait at once, before or during", async () => {
    const gate = createPauseGate({ recheckMs: 1000 })
    const gone = new AbortController()
    gone.abort()
    expect(
      await entered(gate).park({ deadlineMs: FAR(), signal: gone.signal }),
    ).toBe("aborted")

    const later = new AbortController()
    const waiting = entered(gate).park({
      deadlineMs: FAR(),
      signal: later.signal,
    })
    later.abort()
    expect(await waiting).toBe("aborted")
  })

  test("a finished wait takes its abort listener with it", async () => {
    const gate = createPauseGate({ recheckMs: 2 })
    const controller = new AbortController()
    const held = entered(gate)
    expect(
      await held.park({ deadlineMs: FAR(), signal: controller.signal }),
    ).toBe("recheck")
    // Aborting now has nothing to wake; the next wait is its own.
    controller.abort()
    expect(
      await held.park({ deadlineMs: FAR(), signal: controller.signal }),
    ).toBe("aborted")
  })
})

describe("waking", () => {
  test("recheck, resume and cancel wake a waiting request, and count it", async () => {
    for (const [action, outcome] of [
      ["recheck", "recheck"],
      ["resume", "resumed"],
      ["cancel", "cancelled"],
    ] as const) {
      const gate = createPauseGate({ recheckMs: 1000 })
      const waiting = entered(gate).park({ deadlineMs: FAR() })
      expect(gate[action]()).toBe(1)
      expect(await waiting).toBe(outcome)
    }
  })

  test("only the limit named is woken", async () => {
    const gate = createPauseGate({ recheckMs: 20 })
    const a = entered(gate, "a").park({ deadlineMs: FAR() })
    const b = entered(gate, "b").park({ deadlineMs: FAR() })
    expect(gate.resume("a")).toBe(1)
    expect(await a).toBe("resumed")
    // `b` was left to its own interval.
    expect(await b).toBe("recheck")
  })

  test("with no limit named, every held request is reached", async () => {
    const gate = createPauseGate({ recheckMs: 1000 })
    const waits = [
      entered(gate, "a").park({ deadlineMs: FAR() }),
      entered(gate, "b").park({ deadlineMs: FAR() }),
    ]
    expect(gate.cancel()).toBe(2)
    expect(await Promise.all(waits)).toEqual(["cancelled", "cancelled"])
    expect(gate.cancel()).toBe(2)
  })

  test("a wake between two waits is delivered to the next one, once", async () => {
    const gate = createPauseGate({ recheckMs: 1000 })
    const held = entered(gate)
    expect(gate.resume()).toBe(1)
    expect(await held.park({ deadlineMs: FAR() })).toBe("resumed")
    // Delivered: the next wait is a fresh one.
    expect(await held.park({ deadlineMs: Date.now() + 5 })).toBe("timeout")
  })

  test("a resume or cancel outranks a look again that came before it", async () => {
    const gate = createPauseGate({ recheckMs: 1000 })
    const held = entered(gate)
    gate.recheck()
    gate.cancel()
    expect(await held.park({ deadlineMs: FAR() })).toBe("cancelled")

    const other = entered(gate)
    gate.resume()
    gate.recheck()
    // A look again doesn't replace the answer that was already waiting.
    expect(await other.park({ deadlineMs: FAR() })).toBe("resumed")
  })

  test("a look again waiting for the next wait is kept, and delivered at once", async () => {
    const gate = createPauseGate({ recheckMs: 1000 })
    const held = entered(gate)
    gate.recheck()
    gate.recheck()
    const started = Date.now()
    expect(await held.park({ deadlineMs: FAR() })).toBe("recheck")
    expect(Date.now() - started).toBeLessThan(200)
  })

  test("listens for the client going away once, and stops when the wait ends", async () => {
    const added: Array<[string, unknown]> = []
    const removed: Array<string> = []
    const signal = {
      aborted: false,
      addEventListener: (
        type: string,
        _listener: unknown,
        options: unknown,
      ) => {
        added.push([type, options])
      },
      removeEventListener: (type: string) => {
        removed.push(type)
      },
    } as unknown as AbortSignal
    const gate = createPauseGate({ recheckMs: 1000 })
    const waiting = entered(gate).park({ deadlineMs: FAR(), signal })
    gate.resume()
    await waiting
    expect(added).toEqual([["abort", { once: true }]])
    expect(removed).toEqual(["abort"])
  })

  test("a released request is out of reach", () => {
    const gate = createPauseGate()
    const held = entered(gate)
    held.release()
    expect(gate.resume()).toBe(0)
    expect(gate.cancel("cap")).toBe(0)
  })

  test("a woken wait doesn't fire its timer later", async () => {
    const gate = createPauseGate({ recheckMs: 10 })
    const held = entered(gate)
    const waiting = held.park({ deadlineMs: FAR() })
    gate.resume()
    expect(await waiting).toBe("resumed")
    await Bun.sleep(25)
    // The next wait is not already satisfied by the old timer.
    expect(await held.park({ deadlineMs: Date.now() + 5 })).toBe("timeout")
  })
})
