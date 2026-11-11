/**
 * A virtual clock for rate-limiting tests: `now()` only moves when the test
 * advances it, and `sleep` timers fire in time order as it does. No real
 * timers are involved, so cool-downs, backoff and queue timeouts are exact.
 */
import type { Clock, Sleep } from "../util"

import { abortReason } from "../util"

interface Timer {
  at: number
  seq: number
  fire(): void
}

/** Let pending promise callbacks and I/O callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++)
    await new Promise<void>((resolve) => setImmediate(resolve))
}

export class FakeClock implements Clock {
  #now: number
  #seq = 0
  #timers: Array<Timer> = []

  /** Starts at `start` (default 2025-01-01T00:00:00Z, so HTTP-dates work). */
  constructor(start = Date.UTC(2025, 0, 1)) {
    this.#now = start
  }

  readonly now = (): number => this.#now

  readonly sleep: Sleep = (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal))
        return
      }
      const onAbort = () => {
        this.#timers = this.#timers.filter((item) => item !== timer)
        reject(abortReason(signal as AbortSignal))
      }
      const timer: Timer = {
        at: this.#now + Math.max(0, ms),
        seq: ++this.#seq,
        fire: () => {
          signal?.removeEventListener("abort", onAbort)
          resolve()
        },
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.#timers.push(timer)
    })

  /** Timers waiting to fire. */
  get pending(): number {
    return this.#timers.length
  }

  /** Move time forward by `ms`, firing every timer that falls due, in order. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms
    for (;;) {
      await flush()
      const timer = this.#earliest()
      if (!timer || timer.at > target) break
      this.#fire(timer)
    }
    this.#now = target
    await flush()
  }

  /** Jump to the earliest timer and fire it; `false` when none is pending. */
  async next(): Promise<boolean> {
    await flush()
    const timer = this.#earliest()
    if (!timer) return false
    this.#fire(timer)
    await flush()
    return true
  }

  /**
   * Drive `promise` to completion: fire timers whenever nothing else is
   * happening, and wait in real time while there are none (I/O in flight).
   * For flows with one thing in flight at a time.
   */
  async run<T>(promise: Promise<T>, limitMs = 60 * 60_000): Promise<T> {
    const state = { settled: false }
    promise.then(
      () => (state.settled = true),
      () => (state.settled = true),
    )
    const start = this.#now
    for (;;) {
      await flush()
      if (state.settled) return await promise
      if (this.#timers.length > 0) {
        if (this.#now - start > limitMs)
          throw new Error(`FakeClock.run: still pending after ${limitMs} ms`)
        await this.next()
      } else {
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    }
  }

  #earliest(): Timer | undefined {
    let best: Timer | undefined
    for (const timer of this.#timers)
      if (
        !best
        || timer.at < best.at
        || (timer.at === best.at && timer.seq < best.seq)
      )
        best = timer
    return best
  }

  #fire(timer: Timer): void {
    this.#timers = this.#timers.filter((item) => item !== timer)
    this.#now = Math.max(this.#now, timer.at)
    timer.fire()
  }
}
