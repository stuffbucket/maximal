import { describe, expect, test } from "bun:test"

import {
  type RemoteUsage,
  USAGE_RETRY_DELAYS_MS,
  USAGE_STALE_AFTER_MS,
  createTrafficWatch,
  createUsageRefresher,
  usageRefreshDue,
  usageRetryDelayMs,
} from "../shell/src/dashboard/usage-refresh"

interface Data {
  login: string
}

const signedOutError = Object.assign(new Error("401"), {
  status: 401,
  code: "not_authenticated",
})
const timeoutError = new Error(
  "Request failed with status 504: GitHub didn't respond in time.",
)

/** A refresher on a fake clock and timer, answering /usage from `replies`
 *  in order (a function result is awaited, an Error is thrown). */
function harness(options: { active?: boolean } = {}) {
  let clock = 1_000_000
  let active = options.active ?? true
  const replies: Array<Data | Error> = []
  let fetches = 0
  let renders = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  let nextTimer = 1

  const refresher = createUsageRefresher<Data>({
    fetchUsage: () => {
      fetches += 1
      const reply = replies.shift()
      if (reply === undefined) throw new Error("no reply queued")
      return reply instanceof Error ?
          Promise.reject(reply)
        : Promise.resolve(reply)
    },
    isSignedOut: (error) => error === signedOutError,
    describeError: (error) => (error as Error).message,
    isActive: () => active,
    periodEnded: () => false,
    onChange: () => {
      renders += 1
    },
    now: () => clock,
    setTimer: (run, ms) => {
      const id = nextTimer++
      timers.set(id, { at: clock + ms, run })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (handle) => {
      timers.delete(handle as unknown as number)
    },
  })

  return {
    refresher,
    reply: (...next: Array<Data | Error>) => replies.push(...next),
    get fetches() {
      return fetches
    },
    get renders() {
      return renders
    },
    /** When the pending retry timer fires, relative to now; null if none. */
    get timerIn(): number | null {
      const pending = [...timers.values()]
      if (pending.length === 0) return null
      return Math.min(...pending.map((t) => t.at)) - clock
    },
    setActive(next: boolean) {
      active = next
      refresher.activityChanged()
    },
    /** Move the clock on, firing (and awaiting) any timer that comes due. */
    async advance(ms: number) {
      const until = clock + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)
          .at(0)
        if (!due) break
        timers.delete(due[0])
        clock = due[1].at
        due[1].run()
        await settle()
      }
      clock = until
    },
  }
}

/** Let the refresher's promise chain run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

const status = (usage: RemoteUsage<Data>): string => usage.status

describe("usageRefreshDue", () => {
  const ready: RemoteUsage<Data> = {
    status: "ready",
    snapshot: { data: { login: "a" }, fetchedAt: 0 },
  }
  const unavailable: RemoteUsage<Data> = {
    status: "unavailable",
    snapshot: null,
  }

  test("showing the Dashboard revalidates in any state once 15 s have passed", () => {
    for (const usage of [
      ready,
      unavailable,
      { status: "signed-out" } as const,
    ]) {
      expect(
        usageRefreshDue("shown", usage, {
          now: 15_000,
          lastAttemptAt: 0,
          periodEnded: false,
        }),
      ).toBe(true)
      expect(
        usageRefreshDue("shown", usage, {
          now: 14_999,
          lastAttemptAt: 0,
          periodEnded: false,
        }),
      ).toBe(false)
    }
  })

  test("traffic re-reads quotas that aren't ready or are stale, at most every 30 s", () => {
    const context = { now: 30_000, lastAttemptAt: 0, periodEnded: false }
    expect(usageRefreshDue("traffic", unavailable, context)).toBe(true)
    expect(usageRefreshDue("traffic", { status: "signed-out" }, context)).toBe(
      true,
    )
    // A fresh snapshot needs nothing.
    expect(usageRefreshDue("traffic", ready, context)).toBe(false)
    // A stale one does.
    expect(
      usageRefreshDue("traffic", ready, {
        ...context,
        now: USAGE_STALE_AFTER_MS + 1,
      }),
    ).toBe(true)
    expect(
      usageRefreshDue("traffic", unavailable, { ...context, now: 29_999 }),
    ).toBe(false)
  })

  test("the retry timer only fetches while the quotas are unavailable", () => {
    const context = { now: 1, lastAttemptAt: 0, periodEnded: false }
    expect(usageRefreshDue("retry", unavailable, context)).toBe(true)
    expect(usageRefreshDue("retry", ready, context)).toBe(false)
    expect(usageRefreshDue("retry", { status: "signed-out" }, context)).toBe(
      false,
    )
  })

  test("an ended quota period re-reads a ready snapshot", () => {
    const context = { now: 60_000, lastAttemptAt: 0, periodEnded: true }
    expect(usageRefreshDue("period-ended", ready, context)).toBe(true)
    expect(usageRefreshDue("visible", ready, context)).toBe(true)
    expect(
      usageRefreshDue("period-ended", ready, {
        ...context,
        periodEnded: false,
      }),
    ).toBe(false)
  })
})

describe("usageRetryDelayMs", () => {
  test("backs off 30 s, 1 min, 2 min, then holds at 5 min", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => usageRetryDelayMs(n))).toEqual([
      30_000, 60_000, 120_000, 300_000, 300_000, 300_000,
    ])
    expect(USAGE_RETRY_DELAYS_MS.at(-1)).toBe(300_000)
  })
})

describe("createUsageRefresher", () => {
  test("the first read shows the waiting state, then the quotas", async () => {
    const h = harness()
    h.reply({ login: "a" })
    const loading = h.refresher.request("load")
    expect(h.refresher.usage).toEqual({ status: "unavailable", snapshot: null })
    await loading
    expect(status(h.refresher.usage)).toBe("ready")
    expect(h.timerIn).toBeNull()
  })

  test("a failure keeps the previous snapshot and reports why", async () => {
    const h = harness()
    h.reply({ login: "a" }, timeoutError)
    await h.refresher.request("load")
    await h.advance(20_000)
    await h.refresher.request("shown")
    const usage = h.refresher.usage
    expect(usage.status).toBe("unavailable")
    if (usage.status !== "unavailable") throw new Error("unreachable")
    expect(usage.snapshot?.data).toEqual({ login: "a" })
    expect(usage.reason).toBe(timeoutError.message)
  })

  test("a surface switch retries from the error state", async () => {
    const h = harness()
    h.reply(timeoutError)
    await h.refresher.request("load")
    expect(status(h.refresher.usage)).toBe("unavailable")

    // Within the 15 s floor nothing is fetched.
    await h.advance(5_000)
    await h.refresher.request("shown")
    expect(h.fetches).toBe(1)

    await h.advance(10_000)
    h.reply({ login: "a" })
    await h.refresher.request("shown")
    expect(h.fetches).toBe(2)
    expect(status(h.refresher.usage)).toBe("ready")
    expect(h.timerIn).toBeNull()
  })

  test("traffic waits out its 30 s floor and does nothing once ready", async () => {
    const h = harness()
    h.reply(timeoutError)
    await h.refresher.request("load")
    await h.advance(30_000 - 1)
    // The backoff timer (30 s) hasn't fired yet; traffic is still too soon.
    await h.refresher.request("traffic")
    expect(h.fetches).toBe(1)

    h.reply({ login: "a" })
    await h.advance(1)
    // The timer fired at 30 s and succeeded; traffic now has nothing to do.
    expect(h.fetches).toBe(2)
    expect(status(h.refresher.usage)).toBe("ready")
    await h.advance(30_000)
    await h.refresher.request("traffic")
    expect(h.fetches).toBe(2)
  })

  test("a traffic signal retries when not ready, ahead of a long backoff step", async () => {
    const h = harness()
    h.reply(timeoutError, timeoutError, timeoutError)
    await h.refresher.request("load")
    await h.advance(30_000)
    await h.advance(60_000)
    expect(h.fetches).toBe(3)
    // Third failure: the next timer is two minutes out.
    expect(h.timerIn).toBe(120_000)

    await h.advance(30_000)
    h.reply({ login: "a" })
    await h.refresher.request("traffic")
    expect(h.fetches).toBe(4)
    expect(status(h.refresher.usage)).toBe("ready")
    expect(h.timerIn).toBeNull()
  })

  test("the backoff schedule grows to 5 min and resets after a success", async () => {
    const h = harness()
    h.reply(timeoutError)
    await h.refresher.request("load")
    const waits: Array<number | null> = []
    for (let i = 0; i < 5; i += 1) {
      waits.push(h.timerIn)
      h.reply(timeoutError)
      await h.advance(h.timerIn ?? 0)
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 300_000, 300_000])

    // Success clears the timer and the failure count…
    h.reply({ login: "a" })
    await h.advance(h.timerIn ?? 0)
    expect(status(h.refresher.usage)).toBe("ready")
    expect(h.timerIn).toBeNull()

    // …so the next failure starts again at 30 s.
    await h.advance(15_000)
    h.reply(timeoutError)
    await h.refresher.request("shown")
    expect(h.timerIn).toBe(30_000)
  })

  test("the retry timer stops while the Dashboard isn't active and resumes after", async () => {
    const h = harness()
    h.reply(timeoutError)
    await h.refresher.request("load")
    expect(h.timerIn).toBe(30_000)

    h.setActive(false)
    expect(h.timerIn).toBeNull()
    await h.advance(10 * 60_000)
    expect(h.fetches).toBe(1)

    // Back in view: the step is long overdue, so it fires at once.
    h.setActive(true)
    expect(h.timerIn).toBe(0)
  })

  test("a failure while inactive schedules nothing", async () => {
    const h = harness({ active: false })
    h.reply(timeoutError)
    await h.refresher.request("load")
    expect(h.timerIn).toBeNull()
  })

  test("an account-switch-like sequence recovers (ready → 401 → signed-out → ready)", async () => {
    const h = harness()
    h.reply({ login: "old" })
    await h.refresher.request("load")
    expect(status(h.refresher.usage)).toBe("ready")

    // Signed out in Settings, then the Dashboard is shown again.
    await h.advance(20_000)
    h.reply(signedOutError)
    await h.refresher.request("shown")
    expect(h.refresher.usage).toEqual({ status: "signed-out" })
    // Signing in is the person's to do; no timer polls meanwhile.
    expect(h.timerIn).toBeNull()

    // Signed in to another account; the next switch back picks it up.
    await h.advance(20_000)
    h.reply({ login: "new" })
    await h.refresher.request("shown")
    const usage = h.refresher.usage
    expect(usage.status).toBe("ready")
    if (usage.status !== "ready") throw new Error("unreachable")
    expect(usage.snapshot.data).toEqual({ login: "new" })
  })

  test("concurrent triggers share one request", async () => {
    const h = harness()
    h.reply({ login: "a" })
    await Promise.all([
      h.refresher.request("load"),
      h.refresher.request("shown"),
      h.refresher.request("traffic"),
    ])
    expect(h.fetches).toBe(1)
    expect(h.renders).toBe(2)
  })
})

describe("createTrafficWatch", () => {
  test("only a rising request count in the same period is new traffic", () => {
    const saw = createTrafficWatch()
    expect(saw("day", 4)).toBe(false) // baseline
    expect(saw("day", 4)).toBe(false)
    expect(saw("day", 5)).toBe(true)
    expect(saw("week", 40)).toBe(false) // new period, new baseline
    expect(saw("week", 39)).toBe(false) // the rolling window dropped one
    expect(saw("week", 41)).toBe(true)
    expect(saw("week", undefined)).toBe(false)
  })
})
