import type { Clock } from "../util"
import type { ResolvedLimits } from "./limits"

import { abortReason } from "../util"

/** Lane used when a connector does not assign one. */
export const DEFAULT_LANE = "default"

/** After this long without a throttle, concurrency is back to its cap. */
const QUIET_RESET_MS = 60_000
/** Successes in a row that raise a reduced concurrency by one. */
const INCREASE_AFTER = 8

/** Why the limiter turned a call away. */
export type LimiterReason =
  | "queue-full"
  | "queue-timeout"
  | "cooldown"
  | "reset"

/** The limiter refused (or stopped waiting for) a slot. */
export class LimiterRejection extends Error {
  readonly reason: LimiterReason
  /** How long until a retry could be admitted, when known. */
  readonly retryAfterMs: number | undefined
  /** Waiters queued when the call was refused. */
  readonly queued: number
  /** How long the call waited before it was refused. */
  readonly waitedMs: number

  constructor(
    reason: LimiterReason,
    details: { retryAfterMs?: number; queued: number; waitedMs?: number },
  ) {
    super(`Upstream limiter: ${reason}`)
    this.name = "LimiterRejection"
    this.reason = reason
    this.retryAfterMs = details.retryAfterMs
    this.queued = details.queued
    this.waitedMs = details.waitedMs ?? 0
  }
}

/** What a waiting caller is told (once per progress interval). */
export interface WaitInfo {
  reason: "queued" | "cooldown"
  /** Calls ahead of this one. */
  position: number
  /** Time until the cool-down ends, when that is what the call waits for. */
  etaMs?: number
}

export interface AcquireOptions {
  /** Downstream session; waiters are served round robin across sessions. */
  sessionId?: string
  signal?: AbortSignal
  /** Longest this call may wait (also bounded by `queueTimeoutMs`). */
  maxWaitMs?: number
  onWait?(info: WaitInfo): void
}

/** An admitted call; `release` exactly once when the upstream call ends. */
export interface Lease {
  readonly lane: string
  release(): void
}

/** Snapshot for logs and tests. */
export interface LimiterSnapshot {
  inFlight: number
  queued: number
  concurrency: number
  cooldownMs: number
  lanes: Record<
    string,
    { inFlight: number; concurrency: number; cooldownMs: number }
  >
}

/**
 * Concurrency, spacing and cool-down for one scope (the whole connector or
 * one lane), with AIMD: a throttle halves the concurrency (at most once per
 * cool-down window), successes raise it again one at a time, and a quiet
 * minute restores the cap.
 */
class Gate {
  readonly cap: number
  readonly floor: number
  readonly minIntervalMs: number
  effective: number
  inFlight = 0
  cooldownUntil = 0
  lastStart = Number.NEGATIVE_INFINITY
  #streak = 0
  #lastPenalty = Number.NEGATIVE_INFINITY
  #noHalveUntil = Number.NEGATIVE_INFINITY

  constructor(cap: number, floor: number, minIntervalMs = 0) {
    this.cap = cap
    this.floor = Math.min(floor, cap)
    this.minIntervalMs = minIntervalMs
    this.effective = cap
  }

  limit(now: number): number {
    if (this.effective < this.cap && now - this.#lastPenalty >= QUIET_RESET_MS)
      this.effective = this.cap
    return this.effective
  }

  /** When a call could start here, ignoring the concurrency limit. */
  readyAt(): number {
    return Math.max(this.cooldownUntil, this.lastStart + this.minIntervalMs)
  }

  penalize(now: number, ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, now + ms)
    this.#lastPenalty = now
    this.#streak = 0
    if (now >= this.#noHalveUntil) {
      this.effective = Math.max(this.floor, Math.floor(this.effective / 2))
      this.#noHalveUntil = this.cooldownUntil
    }
  }

  succeeded(): void {
    if (this.effective >= this.cap) return
    if (++this.#streak >= INCREASE_AFTER) {
      this.effective++
      this.#streak = 0
    }
  }

  reset(): void {
    this.effective = this.cap
    this.cooldownUntil = 0
    this.lastStart = Number.NEGATIVE_INFINITY
    this.#streak = 0
    this.#lastPenalty = Number.NEGATIVE_INFINITY
    this.#noHalveUntil = Number.NEGATIVE_INFINITY
  }
}

interface Waiter {
  readonly seq: number
  readonly lane: string
  readonly session: string
  readonly since: number
  readonly onWait: ((info: WaitInfo) => void) | undefined
  /** Cancels this waiter's timers. */
  readonly timers: AbortController
  admit(lease: Lease): void
  reject(error: Error): void
}

const NO_SESSION = "\0none"

/**
 * Admission control for one connector, shared by every downstream session:
 * a global concurrency cap, per-lane caps and spacing, a shared cool-down
 * opened by any throttle, and a bounded queue served round robin across
 * sessions (FIFO within one). Waiting is abortable and bounded; a call that
 * cannot be admitted in time is refused with a `LimiterRejection`.
 */
export class ConnectorLimiter {
  readonly #limits: ResolvedLimits
  readonly #clock: Clock
  readonly #global: Gate
  readonly #lanes = new Map<string, Gate>()
  /** Waiting calls per session, in arrival order. */
  readonly #queues = new Map<string, Array<Waiter>>()
  /** Sessions with waiters, in round-robin order. */
  #order: Array<string> = []
  #next = 0
  #queued = 0
  #seq = 0
  #wake: { at: number; timer: AbortController } | undefined
  #disposed = false

  constructor(limits: ResolvedLimits, clock: Clock) {
    this.#limits = limits
    this.#clock = clock
    this.#global = new Gate(limits.maxConcurrency, limits.minConcurrency)
  }

  get limits(): ResolvedLimits {
    return this.#limits
  }

  /** Wait for a slot in `lane` (and globally), then hold it until `release`. */
  async acquire(lane: string, options: AcquireOptions = {}): Promise<Lease> {
    const { signal } = options
    if (signal?.aborted) throw abortReason(signal)
    if (this.#disposed)
      throw new LimiterRejection("reset", { queued: this.#queued })
    const now = this.#clock.now()
    const gate = this.#lane(lane)
    if (this.#queued === 0 && this.#canStart(gate, now))
      return this.#start(lane, gate, now)

    const limit = Math.min(
      this.#limits.queueTimeoutMs,
      options.maxWaitMs ?? Number.POSITIVE_INFINITY,
    )
    const cooldown = this.#cooldownLeft(gate, now)
    if (cooldown > limit)
      throw new LimiterRejection("cooldown", {
        retryAfterMs: cooldown,
        queued: this.#queued,
      })
    if (this.#queued >= this.#limits.maxQueue)
      throw new LimiterRejection("queue-full", { queued: this.#queued })
    return await this.#enqueue(lane, { ...options, maxWaitMs: limit }, now)
  }

  /** A call in `lane` was throttled: open the cool-down for the lane, or for everything when `lane` is undefined. */
  penalize(lane: string | undefined, retryAfterMs: number): void {
    const gate = lane === undefined ? this.#global : this.#lane(lane)
    gate.penalize(this.#clock.now(), Math.max(0, retryAfterMs))
    this.#pump()
  }

  /** A call in `lane` succeeded (raises a reduced concurrency). */
  succeeded(lane: string): void {
    this.#global.succeeded()
    this.#lane(lane).succeeded()
    this.#pump()
  }

  /** Time until a call in `lane` could start for cool-down reasons (0 when open). */
  cooldownMs(lane: string): number {
    return this.#cooldownLeft(this.#lane(lane), this.#clock.now())
  }

  /**
   * Forget cool-downs and reduced concurrency (sign-out, new identity,
   * reconnect) and refuse everything waiting. Calls in flight keep their
   * slots until they release them.
   */
  reset(): void {
    this.#rejectAll()
    this.#global.reset()
    for (const gate of this.#lanes.values()) gate.reset()
  }

  /** Refuse everything waiting and every later call (unload). */
  dispose(): void {
    this.#disposed = true
    this.#rejectAll()
  }

  snapshot(): LimiterSnapshot {
    const now = this.#clock.now()
    const lanes: LimiterSnapshot["lanes"] = {}
    for (const [name, gate] of this.#lanes)
      lanes[name] = {
        inFlight: gate.inFlight,
        concurrency: gate.limit(now),
        cooldownMs: Math.max(0, gate.cooldownUntil - now),
      }
    return {
      inFlight: this.#global.inFlight,
      queued: this.#queued,
      concurrency: this.#global.limit(now),
      cooldownMs: Math.max(0, this.#global.cooldownUntil - now),
      lanes,
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  #lane(name: string): Gate {
    let gate = this.#lanes.get(name)
    if (!gate) {
      const limits = this.#limits.lanes[name] ?? {}
      const cap = Math.max(
        1,
        Math.floor(limits.maxConcurrency ?? this.#limits.maxConcurrency),
      )
      gate = new Gate(cap, this.#limits.minConcurrency, limits.minIntervalMs)
      this.#lanes.set(name, gate)
    }
    return gate
  }

  #cooldownLeft(gate: Gate, now: number): number {
    return Math.max(
      0,
      Math.max(this.#global.cooldownUntil, gate.cooldownUntil) - now,
    )
  }

  #canStart(gate: Gate, now: number): boolean {
    return (
      this.#global.inFlight < this.#global.limit(now)
      && gate.inFlight < gate.limit(now)
      && now >= this.#global.readyAt()
      && now >= gate.readyAt()
    )
  }

  #start(lane: string, gate: Gate, now: number): Lease {
    this.#global.inFlight++
    gate.inFlight++
    this.#global.lastStart = now
    gate.lastStart = now
    let released = false
    return {
      lane,
      release: () => {
        if (released) return
        released = true
        this.#global.inFlight--
        gate.inFlight--
        this.#pump()
      },
    }
  }

  /** Queue a call; `options.maxWaitMs` is its resolved wait limit. */
  async #enqueue(
    lane: string,
    options: AcquireOptions & { maxWaitMs: number },
    now: number,
  ): Promise<Lease> {
    const { signal, maxWaitMs: limit } = options
    const session = options.sessionId ?? NO_SESSION
    return await new Promise<Lease>((resolve, reject) => {
      const timers = new AbortController()
      const onAbort = () => {
        if (this.#remove(waiter))
          waiter.reject(abortReason(signal as AbortSignal))
      }
      const waiter: Waiter = {
        seq: ++this.#seq,
        lane,
        session,
        since: now,
        onWait:
          options.onWait ?
            (info: WaitInfo) => options.onWait?.(info)
          : undefined,
        timers,
        admit: (lease) => {
          signal?.removeEventListener("abort", onAbort)
          timers.abort()
          resolve(lease)
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort)
          timers.abort()
          reject(error)
        },
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      let queue = this.#queues.get(session)
      if (!queue) {
        queue = []
        this.#queues.set(session, queue)
        this.#order.push(session)
      }
      queue.push(waiter)
      this.#queued++
      this.#timeout(waiter, limit)
      if (waiter.onWait) this.#ticker(waiter)
      this.#pump()
    })
  }

  /** Refuse `waiter` once it has waited `limit`. */
  #timeout(waiter: Waiter, limit: number): void {
    if (!Number.isFinite(limit)) return
    this.#clock.sleep(limit, waiter.timers.signal).then(
      () => {
        if (!this.#remove(waiter)) return
        const now = this.#clock.now()
        const cooldown = this.#cooldownLeft(this.#lane(waiter.lane), now)
        waiter.reject(
          new LimiterRejection(cooldown > 0 ? "cooldown" : "queue-timeout", {
            ...(cooldown > 0 ? { retryAfterMs: cooldown } : {}),
            queued: this.#queued,
            waitedMs: now - waiter.since,
          }),
        )
      },
      () => {},
    )
  }

  /** Tell a waiting caller where it stands, once per progress interval. */
  #ticker(waiter: Waiter): void {
    const interval = Math.max(1, this.#limits.progressIntervalMs)
    const tick = async () => {
      for (;;) {
        await this.#clock.sleep(interval, waiter.timers.signal)
        const now = this.#clock.now()
        const cooldown = this.#cooldownLeft(this.#lane(waiter.lane), now)
        waiter.onWait?.(
          cooldown > 0 ?
            {
              reason: "cooldown",
              position: this.#ahead(waiter),
              etaMs: cooldown,
            }
          : { reason: "queued", position: this.#ahead(waiter) },
        )
      }
    }
    tick().catch(() => {})
  }

  #ahead(waiter: Waiter): number {
    let ahead = 0
    for (const queue of this.#queues.values())
      for (const other of queue) if (other.seq < waiter.seq) ahead++
    return ahead
  }

  /** Take `waiter` out of the queue; `false` when it already left. */
  #remove(waiter: Waiter, pump = true): boolean {
    const queue = this.#queues.get(waiter.session)
    const index = queue?.indexOf(waiter) ?? -1
    if (!queue || index === -1) return false
    queue.splice(index, 1)
    this.#queued--
    if (queue.length === 0) {
      this.#queues.delete(waiter.session)
      const position = this.#order.indexOf(waiter.session)
      this.#order.splice(position, 1)
      if (position < this.#next) this.#next--
      if (this.#next >= this.#order.length) this.#next = 0
    }
    if (pump) this.#pump()
    return true
  }

  #rejectAll(): void {
    const waiting = [...this.#queues.values()].flat()
    this.#queues.clear()
    this.#order = []
    this.#next = 0
    this.#queued = 0
    this.#wake?.timer.abort()
    this.#wake = undefined
    for (const waiter of waiting)
      waiter.reject(new LimiterRejection("reset", { queued: 0 }))
  }

  /** Admit waiters while slots allow, round robin across sessions; schedule a wake-up for time-blocked ones. */
  #pump(): void {
    if (this.#queued === 0) return
    const now = this.#clock.now()
    let admitted = true
    while (admitted && this.#order.length > 0) {
      admitted = false
      for (let i = 0; i < this.#order.length; i++) {
        const index = (this.#next + i) % this.#order.length
        const session = this.#order[index]
        const head = this.#queues.get(session)?.[0]
        if (!head) continue
        const gate = this.#lane(head.lane)
        if (!this.#canStart(gate, now)) continue
        // Round robin: the next scan starts after this session.
        this.#next = index + 1
        this.#remove(head, false)
        head.admit(this.#start(head.lane, gate, now))
        admitted = true
        break
      }
    }
    this.#scheduleWake(now)
  }

  /** Wake up when the earliest time-blocked head could start. */
  #scheduleWake(now: number): void {
    let at = Number.POSITIVE_INFINITY
    for (const queue of this.#queues.values()) {
      const head = queue.at(0)
      if (!head) continue
      const ready = Math.max(
        this.#global.readyAt(),
        this.#lane(head.lane).readyAt(),
      )
      if (ready > now) at = Math.min(at, ready)
    }
    if (!Number.isFinite(at)) return
    if (this.#wake && this.#wake.at <= at && this.#wake.at > now) return
    this.#wake?.timer.abort()
    const timer = new AbortController()
    this.#wake = { at, timer }
    this.#clock.sleep(at - now, timer.signal).then(
      () => {
        if (this.#wake?.timer === timer) this.#wake = undefined
        this.#pump()
      },
      () => {},
    )
  }
}
