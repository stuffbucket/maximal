import type {
  PluginLogger,
  ToolAnnotations,
  ToolCallContext,
  ToolProgress,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk"

import type { Upstream } from "../state"
import type { Clock, Random, Sleep } from "../util"
import type { UpstreamTool } from "./connection"
import type { RetryPolicy } from "./limits"

import {
  ConnectorError,
  errorText,
  isAbort,
  seconds,
  upstreamHttpError,
  type BusyDetails,
} from "../errors"
import { BatchState } from "./batch"
import {
  kindFromAnnotations,
  type BatchTool,
  type ResultThrottle,
  type ThrottleHooks,
  type ToolKind,
} from "./classify"
import {
  DEFAULT_LANE,
  LimiterRejection,
  type ConnectorLimiter,
  type Lease,
  type WaitInfo,
} from "./limiter"
import { backoffDelay, cooldownFor } from "./retry"

const THROTTLE_STATUSES = new Set([429, 503, 504])

/** Connection failures where the request certainly never reached the server. */
const NEVER_SENT =
  /ECONNREFUSED|ConnectionRefused|ENOTFOUND|EAI_AGAIN|FailedToOpenSocket|Unable to connect/i

export interface GuardedUpstreamOptions {
  /** Connector display name, for messages. */
  name: string
  /** The upstream session pool. */
  upstream: Upstream
  limiter: ConnectorLimiter
  hooks?: ThrottleHooks
  clock: Clock
  /** Backoff waits (default `clock.sleep`). */
  sleep?: Sleep
  random?: Random
  /** Classify a thrown failure (the connector's `toConnectorError`). */
  toError(error: unknown): ConnectorError
  logger?: Pick<PluginLogger, "debug" | "warn">
}

/** A whole-call throttle seen on one attempt. */
interface Throttle {
  status: number
  retryAfterMs: number | undefined
  /** `lane`: a throttled result for this call's data; `global`: the endpoint itself. */
  scope: "lane" | "global"
}

type Outcome =
  | { type: "ok"; result: ToolResult; partial?: ResultThrottle }
  | ({ type: "throttled" } & Throttle)
  | { type: "failed"; error: unknown; failure: ConnectorError }

/**
 * Progress notifications for one call: the kit's own "waiting" messages at
 * most once per interval, and upstream progress relayed, kept strictly
 * increasing across retries as MCP requires.
 */
class Progress {
  readonly #send: ((update: ToolProgress) => void) | undefined
  readonly #clock: Clock
  readonly #interval: number
  #last = 0
  #lastAt = Number.NEGATIVE_INFINITY

  constructor(call: ToolCallContext, clock: Clock, interval: number) {
    this.#send = call.progress?.bind(call)
    this.#clock = clock
    this.#interval = interval
  }

  get enabled(): boolean {
    return this.#send !== undefined
  }

  relay(update: ToolProgress): void {
    if (!this.#send) return
    if (update.progress > this.#last) {
      this.#last = update.progress
      this.#send(update)
      return
    }
    this.#last += 1
    this.#send({
      progress: this.#last,
      ...(update.message === undefined ? {} : { message: update.message }),
    })
  }

  waiting(message: string): void {
    if (!this.#send) return
    const now = this.#clock.now()
    if (now - this.#lastAt < this.#interval) return
    this.#lastAt = now
    this.#last += 1
    this.#send({ progress: this.#last, message })
  }
}

/** One tool call through the limiter and the retry policy. */
class CallRun {
  readonly #o: GuardedUpstreamOptions
  readonly #policy: RetryPolicy
  readonly #tool: string
  readonly #input: Record<string, unknown>
  readonly #call: ToolCallContext
  readonly #forwarded: ToolCallContext
  readonly #kind: ToolKind
  readonly #lane: string
  readonly #maxAttempts: number
  readonly #progress: Progress
  /**
   * Attempts of the current unit — the whole call, or one chunk or
   * re-issue round of a batch read — so a throttle late in a long batch
   * gets its own retries. The time budget (`#waitedMs`) is per call.
   */
  #attempts = 0
  #retries = 0
  #waitedMs = 0
  #networkRetried = false
  #serverRetried = false

  constructor(
    options: GuardedUpstreamOptions,
    call: {
      tool: string
      input: Record<string, unknown>
      context: ToolCallContext
      kind: ToolKind
      lane: string
      attempts: number
    },
  ) {
    this.#o = options
    this.#policy = options.limiter.limits.retry
    this.#tool = call.tool
    this.#input = call.input
    this.#call = call.context
    this.#kind = call.kind
    this.#lane = call.lane
    this.#maxAttempts = call.attempts
    this.#progress = new Progress(
      call.context,
      options.clock,
      Math.max(1, options.limiter.limits.progressIntervalMs),
    )
    const context = call.context
    this.#forwarded = {
      signal: context.signal,
      ...(context.sessionId === undefined ?
        {}
      : { sessionId: context.sessionId }),
      ...(context.elicit ? { elicit: context.elicit.bind(context) } : {}),
      ...(this.#progress.enabled ?
        { progress: (update: ToolProgress) => this.#progress.relay(update) }
      : {}),
    }
  }

  get #name(): string {
    return this.#o.name
  }

  /** Run until success or a final failure; batch-throttled results are returned for the batch logic. */
  async single(
    args: Record<string, unknown>,
  ): Promise<{ result: ToolResult; partial?: ResultThrottle }> {
    for (;;) {
      const outcome = await this.#once(args)
      switch (outcome.type) {
        case "ok": {
          return outcome
        }
        case "throttled": {
          await this.#afterThrottle(outcome)
          break
        }
        default: {
          this.#afterFailure(outcome)
        }
      }
    }
  }

  /**
   * A batch read: split long lists into chunks of `fetchBatchSize`, and
   * re-issue only the entries the service throttled, splicing the answers
   * back in order. Entries still throttled when the budget runs out keep
   * their throttled status, with a note for the caller.
   */
  async batch(
    spec: BatchTool,
    items: ReadonlyArray<string>,
  ): Promise<ToolResult> {
    const state = new BatchState(items.length, spec.results ?? "results")
    const configured = this.#o.limiter.limits.fetchBatchSize
    const size = configured > 0 ? configured : items.length
    let pending = items.map((_, index) => index)
    for (let round = 0; ; round++) {
      state.round()
      for (let start = 0; start < pending.length; start += size) {
        const chunk = pending.slice(start, start + size)
        const args = {
          ...this.#input,
          [spec.argument]: chunk.map((index) => items[index]),
        }
        // Every chunk starts from the attempts its items already had.
        this.#unit(round)
        const unsplit = await this.#chunk(state, chunk, args)
        if (unsplit && chunk.length === items.length) return unsplit
      }
      // Re-issuing is attempt `round + 2` for the throttled items.
      this.#unit(round + 1, round)
      if (!(await this.#nextRound(state))) break
      pending = state.throttled
    }
    const result = state.result(this.#name)
    if (!result) throw state.gaveUp ?? new Error("empty batch")
    return result
  }

  /** Start a unit of attempts (see `#attempts`). */
  #unit(attempts: number, retries = attempts): void {
    this.#attempts = attempts
    this.#retries = retries
    this.#networkRetried = false
    this.#serverRetried = false
  }

  /**
   * Read one chunk into `state`. Returns the raw result when it is not one
   * entry per item (only acceptable for an unsplit first call).
   */
  async #chunk(
    state: BatchState,
    chunk: Array<number>,
    args: Record<string, unknown>,
  ): Promise<ToolResult | undefined> {
    let answer: { result: ToolResult; partial?: ResultThrottle }
    try {
      answer = await this.single(args)
    } catch (error) {
      // A chunk never answered fails the call; a re-issue that cannot run
      // keeps the answers so far.
      if (!isBusy(error) || !state.answered(chunk)) throw error
      state.gaveUp = error
      state.throttled.push(...chunk)
      return undefined
    }
    if (state.record(chunk, answer)) return undefined
    if (state.calls === 1) return answer.result
    throw new ConnectorError(
      "upstream",
      `${this.#name} returned an unexpected result for part of a ${this.#tool} batch.`,
    )
  }

  /** Wait before re-issuing this round's throttled entries; `false` to stop. */
  async #nextRound(state: BatchState): Promise<boolean> {
    const signal = state.signal
    if (state.throttled.length === 0 || state.gaveUp || !signal) return false
    try {
      await this.#backoff(signal.status, signal.retryAfterMs, this.#lane)
      return true
    } catch (error) {
      if (!isBusy(error)) throw error
      state.gaveUp = error
      return false
    }
  }

  async #once(args: Record<string, unknown>): Promise<Outcome> {
    const lease = await this.#acquire()
    this.#attempts++
    let result: ToolResult
    try {
      result = await this.#o.upstream.callTool(
        this.#tool,
        args,
        this.#forwarded,
      )
    } catch (error) {
      if (isAbort(error, this.#call.signal)) {
        if (this.#kind !== "read")
          this.#o.logger?.warn(
            `${this.#name}: ${this.#tool} was cancelled while in flight; it may have been carried out.`,
          )
        throw error
      }
      const http = upstreamHttpError(error)
      if (http && THROTTLE_STATUSES.has(http.status))
        return {
          type: "throttled",
          status: http.status,
          retryAfterMs: http.retryAfterMs,
          scope: "global",
        }
      return { type: "failed", error, failure: this.#o.toError(error) }
    } finally {
      lease.release()
    }
    const throttle = this.#o.hooks?.inspect?.(result, {
      tool: this.#tool,
      args,
      now: this.#o.clock.now(),
    })
    if (throttle && !throttle.indexes)
      return {
        type: "throttled",
        status: throttle.status,
        retryAfterMs: throttle.retryAfterMs,
        scope: "lane",
      }
    if (!throttle?.indexes?.length) this.#o.limiter.succeeded(this.#lane)
    return { type: "ok", result, ...(throttle ? { partial: throttle } : {}) }
  }

  async #acquire(): Promise<Lease> {
    const { clock, limiter } = this.#o
    const started = clock.now()
    try {
      const lease = await limiter.acquire(this.#lane, {
        signal: this.#call.signal,
        ...(this.#call.sessionId === undefined ?
          {}
        : { sessionId: this.#call.sessionId }),
        maxWaitMs: Math.max(
          0,
          Math.min(
            this.#policy.maxWaitMs,
            this.#policy.budgetMs - this.#waitedMs,
          ),
        ),
        onWait: (info) => this.#progress.waiting(this.#waitMessage(info)),
      })
      this.#waitedMs += clock.now() - started
      return lease
    } catch (error) {
      this.#waitedMs += clock.now() - started
      if (error instanceof LimiterRejection) throw this.#refused(error)
      throw error
    }
  }

  #waitMessage(info: WaitInfo): string {
    return info.reason === "cooldown" && info.etaMs !== undefined ?
        `Waiting for ${this.#name}'s rate limit to lift: about ${seconds(info.etaMs)} s.`
      : `Waiting for a free ${this.#name} slot (${info.position} ahead).`
  }

  /** A whole-call throttle: retry when this kind of tool may be retried, else fail clearly. */
  async #afterThrottle(throttle: Throttle): Promise<void> {
    const lane = throttle.scope === "lane" ? this.#lane : undefined
    const definitive = throttle.status === 429
    const fallback = cooldownFor(this.#policy, this.#retries, undefined)
    if (
      this.#kind === "write"
      && (!definitive || !this.#policy.retryWritesOn429)
    ) {
      this.#o.limiter.penalize(lane, throttle.retryAfterMs ?? fallback)
      if (!definitive)
        throw this.#outcomeUnknown(
          `returned HTTP ${throttle.status}`,
          throttle.status,
        )
      throw this.#throttled(throttle.status, throttle.retryAfterMs)
    }
    if (this.#kind === "idempotent-write" && !definitive) {
      if (this.#serverRetried) {
        this.#o.limiter.penalize(lane, throttle.retryAfterMs ?? fallback)
        throw this.#throttled(throttle.status, throttle.retryAfterMs)
      }
      this.#serverRetried = true
    }
    await this.#backoff(throttle.status, throttle.retryAfterMs, lane)
  }

  /** A failure other than throttling: one quick retry for reads after a lost connection; writes report an unknown outcome. */
  #afterFailure(outcome: Extract<Outcome, { type: "failed" }>): void {
    const { failure, error } = outcome
    const transport = failure.code === "network" || failure.code === "timeout"
    if (transport) {
      if (
        this.#kind === "read"
        && !this.#networkRetried
        && this.#attempts < this.#maxAttempts
      ) {
        this.#networkRetried = true
        return
      }
      if (this.#kind !== "read" && !NEVER_SENT.test(errorText(error)))
        throw this.#outcomeUnknown(
          failure.code === "timeout" ?
            "did not answer in time"
          : "lost the connection",
          undefined,
          error,
        )
      throw error
    }
    if (
      this.#kind !== "read"
      && failure.status !== undefined
      && failure.status >= 500
    )
      throw this.#outcomeUnknown(
        `returned HTTP ${failure.status}`,
        failure.status,
        error,
      )
    throw error
  }

  /**
   * Open the cool-down and wait before the next attempt, or fail when the
   * attempts, the single-wait cap or the call's budget do not allow it.
   */
  async #backoff(
    status: number,
    hint: number | undefined,
    lane: string | undefined,
  ): Promise<void> {
    const { limiter, random } = this.#o
    const delay = backoffDelay(this.#policy, this.#retries, {
      hintMs: hint,
      random: random ?? Math.random,
    })
    limiter.penalize(lane, cooldownFor(this.#policy, this.#retries, hint))
    this.#o.logger?.debug(
      `${this.#name}: ${this.#tool} throttled (HTTP ${status}${hint === undefined ? "" : `, Retry-After ${seconds(hint)} s`}), attempt ${this.#attempts} of ${this.#maxAttempts}.`,
    )
    if (hint !== undefined && hint > this.#policy.maxWaitMs)
      throw this.#throttled(status, hint, true)
    if (
      this.#attempts >= this.#maxAttempts
      || this.#waitedMs + delay > this.#policy.budgetMs
    )
      throw this.#throttled(status, hint ?? delay)
    await this.#sleep(delay, status)
    this.#waitedMs += delay
    this.#retries++
  }

  async #sleep(delay: number, status: number): Promise<void> {
    const { clock } = this.#o
    const sleep = this.#o.sleep ?? clock.sleep
    const end = clock.now() + delay
    const interval = Math.max(1, this.#o.limiter.limits.progressIntervalMs)
    const say = () =>
      this.#progress.waiting(
        `${this.#name} is rate-limiting requests (HTTP ${status}); retrying in ${seconds(end - clock.now())} s.`,
      )
    const ticks = new AbortController()
    if (this.#progress.enabled && delay >= interval) {
      say()
      const tick = async () => {
        for (;;) {
          await clock.sleep(interval, ticks.signal)
          if (end - clock.now() > 0) say()
        }
      }
      tick().catch(() => {})
    }
    try {
      await sleep(delay, this.#call.signal)
    } finally {
      ticks.abort()
    }
  }

  #busy(
    message: string,
    details: BusyDetails,
    extra: { status?: number | undefined; cause?: unknown } = {},
  ): ConnectorError {
    return new ConnectorError("busy", message, {
      busy: { attempts: this.#attempts, waitedMs: this.#waitedMs, ...details },
      ...(extra.status === undefined ? {} : { status: extra.status }),
      ...(extra.cause === undefined ? {} : { cause: extra.cause }),
    })
  }

  #throttled(
    status: number,
    retryAfterMs: number | undefined,
    tooLong = false,
  ): ConnectorError {
    const again =
      retryAfterMs === undefined ?
        "Try again in a moment."
      : `Try again in about ${seconds(retryAfterMs)} s.`
    let what = ""
    if (tooLong && retryAfterMs !== undefined)
      what = ` and asked to wait ${seconds(retryAfterMs)} s`
    else if (this.#attempts > 1)
      what = `; tried ${this.#attempts} times over ${seconds(this.#waitedMs)} s`
    return this.#busy(
      `${this.#name} is rate-limiting requests (HTTP ${status})${what}. ${again}`,
      {
        reason: "throttled",
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
      { status },
    )
  }

  #outcomeUnknown(
    what: string,
    status: number | undefined,
    cause?: unknown,
  ): ConnectorError {
    return this.#busy(
      `The request may have been carried out: ${this.#name} ${what} for ${this.#tool}, which changes data. Check before retrying.`,
      { reason: "outcome-unknown" },
      { status, cause },
    )
  }

  #refused(rejection: LimiterRejection): ConnectorError {
    const name = this.#name
    const retryAfterMs = rejection.retryAfterMs
    const details: BusyDetails = {
      reason: rejection.reason,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    }
    switch (rejection.reason) {
      case "queue-full": {
        return this.#busy(
          `${name} has too many requests waiting (${rejection.queued}). Try again in a moment.`,
          details,
        )
      }
      case "queue-timeout": {
        return this.#busy(
          `${name} is busy: this request waited ${seconds(rejection.waitedMs)} s for a free slot. Try again in a moment.`,
          details,
        )
      }
      case "cooldown": {
        return this.#busy(
          `${name} is rate-limiting requests. Try again in about ${seconds(retryAfterMs ?? 0)} s.`,
          details,
        )
      }
      default: {
        return this.#busy(
          `${name} reconnected while this request was waiting. Try again.`,
          details,
        )
      }
    }
  }
}

/** A `busy` connector error (the limiter or the retry policy gave up). */
function isBusy(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError && error.code === "busy"
}

/**
 * The upstream as tool calls see it: every `tools/call` goes through the
 * connector's shared limiter (concurrency, lanes, fair queue, cool-down)
 * and one retry policy — the only place tool calls are retried. Reads are
 * retried on 429/503/504 (HTTP or inside the result); writes only when the
 * service refused them with 429. Batch reads are split and partly
 * re-issued. Waiting shows as progress notifications; everything stops
 * when the call is aborted.
 */
export class GuardedUpstream implements Upstream {
  readonly #options: GuardedUpstreamOptions
  readonly #annotations = new Map<string, ToolAnnotations | undefined>()

  constructor(options: GuardedUpstreamOptions) {
    this.#options = options
  }

  get limiter(): ConnectorLimiter {
    return this.#options.limiter
  }

  /** The upstream tool list (remembers annotations for classification). */
  async listTools(signal?: AbortSignal): Promise<Array<UpstreamTool>> {
    const tools = await this.#options.upstream.listTools(signal)
    this.#annotations.clear()
    for (const tool of tools) this.#annotations.set(tool.name, tool.annotations)
    return tools
  }

  async callTool(
    name: string,
    input: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    const { hooks, limiter } = this.#options
    const annotations = this.#annotations.get(name)
    const kind =
      hooks?.kind?.(name, input, annotations)
      ?? kindFromAnnotations(annotations)
    const policy = limiter.limits.retry.attempts
    const attempts = Math.max(
      1,
      Math.min(policy, hooks?.attempts?.(name, input) ?? policy),
    )
    const run = new CallRun(this.#options, {
      tool: name,
      input,
      context: call,
      kind,
      lane: hooks?.lane?.(name, input) ?? DEFAULT_LANE,
      attempts,
    })
    const batch = kind === "read" ? this.#batchOf(name, input) : undefined
    if (batch) return await run.batch(batch.spec, batch.items)
    return (await run.single(input)).result
  }

  /** Sign-out, new identity or reconnect: forget throttling state, refuse waiters, close sessions. */
  async closeAll(): Promise<void> {
    this.#options.limiter.reset()
    await this.#options.upstream.closeAll()
  }

  /** Unload: refuse everything waiting and every later call. */
  dispose(): void {
    this.#options.limiter.dispose()
  }

  #batchOf(
    name: string,
    input: Record<string, unknown>,
  ): { spec: BatchTool; items: Array<string> } | undefined {
    const spec = this.#options.hooks?.batch?.find((item) => item.tool === name)
    if (!spec) return undefined
    const items = input[spec.argument]
    if (
      !Array.isArray(items)
      || items.length === 0
      || !items.every((item) => typeof item === "string")
    )
      return undefined
    return { spec, items: items }
  }
}
