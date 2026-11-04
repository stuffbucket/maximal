import { describe, expect, test } from "bun:test"

import { ConnectorError } from "../src/errors"
import {
  deferred,
  failure,
  guardHarness,
  httpError,
  ok,
  progressLog,
  seeded,
  throttledResult,
  type RecordedCall,
} from "./guard-harness"

const busy = (error: Error) => {
  expect(error).toBeInstanceOf(ConnectorError)
  expect((error as ConnectorError).code).toBe("busy")
  return (error as ConnectorError).busy
}

describe("retry policy", () => {
  test("a throttled read is retried 2/4/8/16 s, then reported with attempts and time", async () => {
    const h = await guardHarness({ respond: () => throttledResult(429) })
    const error = await failure(h.clock.run(h.call("read")))
    expect(h.backoffs).toEqual([2000, 4000, 8000, 16_000])
    expect(
      h.upstream.calls.map((call) => call.at - h.upstream.calls[0].at),
    ).toEqual([0, 2000, 6000, 14_000, 30_000])
    expect(busy(error)).toEqual({
      reason: "throttled",
      retryAfterMs: 16_000,
      attempts: 5,
      waitedMs: 30_000,
    })
    expect(error.message).toBe(
      "Example is rate-limiting requests (HTTP 429); tried 5 times over 30 s. Try again in about 16 s.",
    )
  })

  test("Retry-After sets the first wait (3 s, not the 2 s fallback)", async () => {
    const h = await guardHarness({
      respond: (_call, index) =>
        index === 0 ? throttledResult(429, "3") : ok(),
    })
    expect(await h.clock.run(h.call("read"))).toEqual(ok())
    expect(h.backoffs).toEqual([3000])
  })

  test("a Retry-After beyond maxWaitMs fails fast and keeps the cool-down open for everyone", async () => {
    const h = await guardHarness({ respond: () => throttledResult(429, "120") })
    const error = await failure(h.clock.run(h.call("read")))
    expect(h.backoffs).toEqual([])
    expect(h.upstream.calls).toHaveLength(1)
    expect(busy(error)).toMatchObject({
      reason: "throttled",
      retryAfterMs: 120_000,
    })
    expect(error.message).toBe(
      "Example is rate-limiting requests (HTTP 429) and asked to wait 120 s. Try again in about 120 s.",
    )
    expect(h.limiter.cooldownMs("default")).toBe(120_000)
    // Another session fails at once, without an upstream request.
    const other = await failure(h.call("read", {}, { sessionId: "b" }))
    expect(busy(other)).toMatchObject({
      reason: "cooldown",
      retryAfterMs: 120_000,
    })
    expect(other.message).toBe(
      "Example is rate-limiting requests. Try again in about 120 s.",
    )
    expect(h.upstream.calls).toHaveLength(1)
  })

  test("the call budget bounds queueing plus backoff", async () => {
    const h = await guardHarness({
      limits: { retry: { budgetMs: 5000 } },
      respond: () => throttledResult(503),
    })
    const error = await failure(h.clock.run(h.call("read")))
    expect(h.backoffs).toEqual([2000])
    expect(h.upstream.calls).toHaveLength(2)
    expect(busy(error)).toMatchObject({ reason: "throttled", attempts: 2 })
  })

  test("callers throttled together retry at distinct times (jitter), after the shared cool-down", async () => {
    const seen = new Map<number, number>()
    const h = await guardHarness({
      random: seeded(7),
      respond: (call) => {
        const id = call.args.id as number
        const count = (seen.get(id) ?? 0) + 1
        seen.set(id, count)
        return count === 1 ? Promise.reject(httpError(429)) : ok()
      },
    })
    await h.clock.run(
      Promise.all(
        [0, 1, 2, 3].map((id) =>
          h.call("read", { id }, { sessionId: `s${id}` }),
        ),
      ),
    )
    const retries = h.upstream.calls
      .slice(4)
      .map((call) => call.at - h.upstream.calls[0].at)
    expect(new Set(retries).size).toBe(4)
    for (const at of retries) {
      expect(at).toBeGreaterThanOrEqual(1500)
      expect(at).toBeLessThanOrEqual(2500)
    }
  })
})

describe("tool kinds", () => {
  test("a write refused with 429 is retried; a write answered 5xx is not (outcome unknown)", async () => {
    const h = await guardHarness({
      respond: (_call, index) =>
        index === 0 ? throttledResult(429) : ok("created"),
    })
    expect(await h.clock.run(h.call("create"))).toEqual(ok("created"))
    expect(h.upstream.calls).toHaveLength(2)

    for (const answer of [
      () => Promise.reject(httpError(504)),
      () => throttledResult(504),
      () => Promise.reject(httpError(500)),
    ]) {
      const w = await guardHarness({ respond: answer })
      const error = await failure(w.clock.run(w.call("create")))
      expect(w.upstream.calls).toHaveLength(1)
      expect(busy(error)).toMatchObject({
        reason: "outcome-unknown",
        attempts: 1,
      })
      expect(error.message).toMatch(
        /^The request may have been carried out: Example returned HTTP 50[04] for create, which changes data\. Check before retrying\.$/,
      )
    }
  })

  test("retryWritesOn429: false reports a refused write without retrying", async () => {
    const h = await guardHarness({
      limits: { retry: { retryWritesOn429: false } },
      respond: () => Promise.reject(httpError(429, 4)),
    })
    const error = await failure(h.clock.run(h.call("create")))
    expect(h.upstream.calls).toHaveLength(1)
    expect(busy(error)).toMatchObject({
      reason: "throttled",
      retryAfterMs: 4000,
    })
  })

  test("an idempotent write is retried once on 503; a read is retried on 503/504", async () => {
    const put = await guardHarness({
      respond: () => Promise.reject(httpError(503)),
    })
    const error = await failure(put.clock.run(put.call("put")))
    expect(put.upstream.calls).toHaveLength(2)
    expect(busy(error)).toMatchObject({ reason: "throttled", attempts: 2 })

    const read = await guardHarness({
      respond: (_call, index) =>
        index < 2 ? throttledResult(index === 0 ? 503 : 504) : ok(),
    })
    expect(await read.clock.run(read.call("read"))).toEqual(ok())
    expect(read.upstream.calls).toHaveLength(3)
  })

  test("a lost connection: reads retry once at once; writes report an unknown outcome unless never sent", async () => {
    const reset = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    })
    const read = await guardHarness({
      respond: (_call, index) => (index === 0 ? Promise.reject(reset) : ok()),
    })
    expect(await read.clock.run(read.call("read"))).toEqual(ok())
    expect(read.backoffs).toEqual([])

    const write = await guardHarness({ respond: () => Promise.reject(reset) })
    const unknown = await failure(write.clock.run(write.call("create")))
    expect(busy(unknown)).toMatchObject({ reason: "outcome-unknown" })
    expect(unknown.message).toBe(
      "The request may have been carried out: Example lost the connection for create, which changes data. Check before retrying.",
    )

    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    })
    const never = await guardHarness({ respond: () => Promise.reject(refused) })
    expect(await failure(never.clock.run(never.call("create")))).toBe(refused)
  })

  test("HTTP 500/502 on a read is not retried", async () => {
    const h = await guardHarness({
      respond: () => Promise.reject(httpError(502)),
    })
    const error = await failure(h.clock.run(h.call("read")))
    expect(error).toBeInstanceOf(Error)
    expect(h.upstream.calls).toHaveLength(1)
  })
})

describe("shared limiter", () => {
  test("one session's throttle holds every session off until the cool-down ends", async () => {
    const h = await guardHarness({
      respond: (call, index) =>
        index === 0 ? Promise.reject(httpError(429, 5)) : ok(call.session),
    })
    const start = h.clock.now()
    const a = h.call("read", {}, { sessionId: "A" })
    await h.clock.advance(1000)
    const b = h.call("read", {}, { sessionId: "B" })
    await h.clock.advance(3999)
    expect(h.upstream.calls.map((call) => call.session)).toEqual(["A"])
    await h.clock.advance(1)
    await Promise.all([a, b])
    expect(
      h.upstream.calls.map((call) => [call.session, call.at - start]),
    ).toEqual([
      ["A", 0],
      ["B", 5000],
      ["A", 5000],
    ])
  })

  test("caps concurrency globally and per lane", async () => {
    const h = await guardHarness({
      limits: { maxConcurrency: 4, lanes: { teams: { maxConcurrency: 2 } } },
    })
    const hold = deferred()
    h.upstream.respond = async () => {
      await hold.promise
      return ok()
    }
    const outlook = h.call("read", { lane: "outlook" }, { sessionId: "o" })
    const teams = [0, 1, 2].map((i) =>
      h.call("read", { lane: "teams" }, { sessionId: `t${i}` }),
    )
    await h.clock.advance(0)
    expect(h.upstream.inFlight).toBe(3)
    expect(h.limiter.snapshot()).toMatchObject({
      inFlight: 3,
      queued: 1,
      lanes: { teams: { inFlight: 2 }, outlook: { inFlight: 1 } },
    })
    const more = Array.from({ length: 6 }, (_, i) =>
      h.call("read", {}, { sessionId: `d${i}` }),
    )
    await h.clock.advance(0)
    expect(h.upstream.inFlight).toBe(4)
    hold.resolve()
    await Promise.all([outlook, ...teams, ...more])
    expect(h.upstream.maxInFlight).toBe(4)
    expect(h.limiter.snapshot()).toMatchObject({ inFlight: 0, queued: 0 })
  })

  test("AIMD: a throttle halves concurrency, 8 successes add one back, a quiet minute restores it", async () => {
    const h = await guardHarness({
      respond: (_call, index) =>
        index === 0 ? Promise.reject(httpError(429)) : ok(),
    })
    await h.clock.run(h.call("read"))
    expect(h.limiter.snapshot().concurrency).toBe(2)
    for (let i = 0; i < 6; i++) await h.call("read")
    expect(h.limiter.snapshot().concurrency).toBe(2)
    await h.call("read")
    expect(h.limiter.snapshot().concurrency).toBe(3)
    h.limiter.penalize(undefined, 0)
    h.limiter.penalize(undefined, 0)
    h.limiter.penalize(undefined, 0)
    expect(h.limiter.snapshot().concurrency).toBe(1)
    await h.clock.advance(60_000)
    expect(h.limiter.snapshot().concurrency).toBe(4)
    // A throttle inside a lane's result halves that lane only.
    h.upstream.respond = (_call, index) =>
      index === 9 ? throttledResult(429) : ok()
    await h.clock.run(h.call("read", { lane: "teams" }))
    expect(h.limiter.snapshot()).toMatchObject({
      concurrency: 4,
      lanes: { teams: { concurrency: 2 } },
    })
  })

  test("a full queue fails at once; a waiter past queueTimeoutMs gives up", async () => {
    const h = await guardHarness({
      limits: { maxConcurrency: 1, maxQueue: 2, queueTimeoutMs: 5000 },
    })
    const hold = deferred()
    h.upstream.respond = async () => {
      await hold.promise
      return ok()
    }
    const first = h.call("read")
    const queued = [failure(h.call("read")), failure(h.call("read"))]
    const full = await failure(h.call("read"))
    expect(busy(full)).toMatchObject({ reason: "queue-full" })
    expect(full.message).toBe(
      "Example has too many requests waiting (2). Try again in a moment.",
    )
    await h.clock.advance(5000)
    for (const error of await Promise.all(queued)) {
      expect(busy(error)).toMatchObject({
        reason: "queue-timeout",
        waitedMs: 5000,
      })
      expect(error.message).toBe(
        "Example is busy: this request waited 5 s for a free slot. Try again in a moment.",
      )
    }
    expect(h.upstream.calls).toHaveLength(1)
    hold.resolve()
    await first
  })

  test("serves sessions round robin, FIFO within one", async () => {
    const h = await guardHarness({ limits: { maxConcurrency: 1 } })
    const hold = deferred()
    h.upstream.respond = async (_call, index) => {
      if (index === 0) await hold.promise
      return ok()
    }
    const calls = [h.call("read", { n: 0 }, { sessionId: "A" })]
    for (let n = 1; n < 10; n++)
      calls.push(h.call("read", { n }, { sessionId: "A" }))
    calls.push(h.call("read", {}, { sessionId: "B" }))
    hold.resolve()
    await Promise.all(calls)
    const order = h.upstream.calls.map((call: RecordedCall) => call.session)
    expect(order.indexOf("B")).toBe(2)
    expect(
      h.upstream.calls
        .filter((call) => call.session === "A")
        .map((call) => call.args.n),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test("a Teams-style burst against a 5 rps bucket: everything succeeds, few 429s", async () => {
    let tokens = 5
    let refilled = 0
    let throttled = 0
    const h = await guardHarness({
      respond: (call) => {
        tokens = Math.min(5, tokens + ((call.at - refilled) / 1000) * 5)
        refilled = call.at
        if (tokens < 1) {
          throttled++
          return Promise.reject(httpError(429, 1))
        }
        tokens -= 1
        return ok()
      },
    })
    const start = h.clock.now()
    const results = await h.clock.run(
      Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          h.call("read", {}, { sessionId: `s${i % 4}` }),
        ),
      ),
    )
    expect(results.every((result) => !result.isError)).toBe(true)
    // Without a shared cool-down all 15 over-limit calls retry together
    // each second: 15 + 10 + 5 = 30 throttles. Here only the calls already
    // in flight when a window closes are throttled.
    expect(throttled).toBeLessThanOrEqual(12)
    expect(h.clock.now() - start).toBeLessThan(15_000)
  })
})

describe("abort, progress and reset", () => {
  test("aborting while queued frees the place; while backing off, stops; in flight, never retries", async () => {
    const h = await guardHarness({ limits: { maxConcurrency: 1 } })
    const hold = deferred()
    h.upstream.respond = async (_call, index) => {
      if (index === 0) await hold.promise
      return ok()
    }
    const first = h.call("read")
    const controller = new AbortController()
    const waiting = h.call("read", {}, { signal: controller.signal })
    await h.clock.advance(0)
    controller.abort()
    expect((await failure(waiting)).name).toBe("AbortError")
    expect(h.limiter.snapshot().queued).toBe(0)
    hold.resolve()
    await first
    expect(await h.call("read")).toEqual(ok())
    expect(h.limiter.snapshot()).toMatchObject({ inFlight: 0, queued: 0 })

    const backing = await guardHarness({ respond: () => throttledResult(429) })
    const stop = new AbortController()
    const call = backing.call("read", {}, { signal: stop.signal })
    await backing.clock.advance(500)
    stop.abort()
    expect((await failure(call)).name).toBe("AbortError")
    await backing.clock.advance(60_000)
    expect(backing.upstream.calls).toHaveLength(1)

    const inflight = await guardHarness()
    const never = deferred<never>()
    inflight.upstream.respond = () => never.promise
    const cancel = new AbortController()
    const write = inflight.call("create", {}, { signal: cancel.signal })
    await inflight.clock.advance(0)
    cancel.abort()
    expect((await failure(write)).name).toBe("AbortError")
    await inflight.clock.advance(60_000)
    expect(inflight.upstream.calls).toHaveLength(1)
    expect(inflight.limiter.snapshot()).toMatchObject({
      inFlight: 0,
      queued: 0,
    })
  })

  test("progress while backing off: at most once a second, with the remaining time", async () => {
    const h = await guardHarness({
      respond: (_call, index) =>
        index === 0 ? throttledResult(429, "8") : ok(),
    })
    const log = progressLog(h.clock)
    const start = h.clock.now()
    await h.clock.run(h.call("read", {}, { progress: log.progress }))
    expect(log.updates.map((update) => update.at - start)).toEqual([
      0, 1000, 2000, 3000, 4000, 5000, 6000, 7000,
    ])
    expect(log.updates[0].message).toBe(
      "Example is rate-limiting requests (HTTP 429); retrying in 8 s.",
    )
    expect(log.updates[7].message).toBe(
      "Example is rate-limiting requests (HTTP 429); retrying in 1 s.",
    )
    expect(log.updates.map((update) => update.progress)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ])

    // No waiting, no progress.
    const quiet = progressLog(h.clock)
    await h.call("read", {}, { progress: quiet.progress })
    expect(quiet.updates).toEqual([])
  })

  test("progress while queued names the place in line", async () => {
    const h = await guardHarness({ limits: { maxConcurrency: 1 } })
    const hold = deferred()
    h.upstream.respond = async (_call, index) => {
      if (index === 0) await hold.promise
      return ok()
    }
    const first = h.call("read")
    const log = progressLog(h.clock)
    const second = h.call("read", {}, { progress: log.progress })
    await h.clock.advance(2500)
    expect(log.updates.map((update) => update.message)).toEqual([
      "Waiting for a free Example slot (0 ahead).",
      "Waiting for a free Example slot (0 ahead).",
    ])
    hold.resolve()
    await Promise.all([first, second])
  })

  test("closeAll forgets cool-downs and refuses waiters; dispose refuses everything", async () => {
    const h = await guardHarness({ limits: { maxConcurrency: 1 } })
    h.limiter.penalize(undefined, 10_000)
    const waiting = h.call("read")
    await h.clock.advance(0)
    await h.guarded.closeAll()
    const error = await failure(waiting)
    expect(busy(error)).toMatchObject({ reason: "reset" })
    expect(error.message).toBe(
      "Example reconnected while this request was waiting. Try again.",
    )
    expect(h.limiter.snapshot()).toMatchObject({
      cooldownMs: 0,
      concurrency: 1,
      queued: 0,
    })
    expect(await h.call("read")).toEqual(ok())
    h.guarded.dispose()
    expect(busy(await failure(h.call("read")))).toMatchObject({
      reason: "reset",
    })
  })
})
