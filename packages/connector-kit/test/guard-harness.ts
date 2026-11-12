/**
 * An in-memory upstream for limiter and retry tests: no HTTP, so the fake
 * clock alone decides when things happen. Each call is answered by
 * `respond` (which may wait on a test-controlled hold).
 */
import type {
  ConnectorLimits,
  ToolCallContext,
  ToolProgress,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk"

import type { Upstream } from "../src/state"
import type { UpstreamTool } from "../src/upstream/connection"

import { toConnectorError, UpstreamHttpError } from "../src/errors"
import { FakeClock } from "../src/testing/clock"
import {
  resultBody,
  type ResultThrottle,
  type ThrottleHooks,
} from "../src/upstream/classify"
import { GuardedUpstream } from "../src/upstream/guarded"
import { ConnectorLimiter } from "../src/upstream/limiter"
import { resolveLimits } from "../src/upstream/limits"
import { parseRetryAfter } from "../src/upstream/retry-after"
import { abortable } from "../src/util"

export interface RecordedCall {
  tool: string
  args: Record<string, unknown>
  session: string | undefined
  at: number
}

export type Responder = (
  call: RecordedCall,
  index: number,
) => ToolResult | Promise<ToolResult>

export const TOOLS: Array<UpstreamTool> = [
  {
    name: "read",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "put",
    inputSchema: { type: "object" },
    annotations: { idempotentHint: true },
  },
  { name: "create", inputSchema: { type: "object" } },
  {
    name: "fetch",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
]

export const ok = (text = "ok"): ToolResult => ({
  content: [{ type: "text", text }],
})

/** A Graph-style throttled result (`{ statusCode, error }`). */
export function throttledResult(status = 429, retryAfter?: string): ToolResult {
  const body = {
    statusCode: status,
    error: { code: "TooManyRequests" },
    ...(retryAfter ? { retryAfter } : {}),
  }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  }
}

export const httpError = (status: number, retryAfterSeconds?: number) =>
  new UpstreamHttpError(
    status,
    "",
    retryAfterSeconds === undefined ?
      {}
    : { retryAfterMs: retryAfterSeconds * 1000 },
  )

const isThrottled = (status: unknown): status is number =>
  status === 429 || status === 503 || status === 504

/** Throttled entries of a batch body (`results[i].statusCode`, `retryAfter` seconds). */
function batchThrottle(
  results: Array<{ statusCode?: unknown; retryAfter?: string }>,
  now: number,
): ResultThrottle | undefined {
  const indexes: Array<number> = []
  let status = 0
  let retryAfterMs: number | undefined
  for (const [index, entry] of results.entries()) {
    if (!isThrottled(entry.statusCode)) continue
    indexes.push(index)
    status = status === 429 ? 429 : entry.statusCode
    retryAfterMs = parseRetryAfter(entry.retryAfter, now) ?? retryAfterMs
  }
  if (indexes.length === 0) return undefined
  return {
    status,
    indexes,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }
}

/** Generic hooks: top-level `statusCode` and batch `results[i].statusCode`. */
export const HOOKS: ThrottleHooks = {
  inspect(result, { now }) {
    const body = resultBody(result)
    const results = body?.results
    if (Array.isArray(results))
      return batchThrottle(
        results as Array<{ statusCode?: unknown; retryAfter?: string }>,
        now,
      )
    const status = body?.statusCode
    if (!isThrottled(status)) return undefined
    const retryAfterMs = parseRetryAfter(
      body?.retryAfter as string | undefined,
      now,
    )
    return { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
  },
  lane: (_tool, args) =>
    typeof args.lane === "string" ? args.lane : undefined,
  batch: [{ tool: "fetch", argument: "paths" }],
}

export class MemoryUpstream implements Upstream {
  readonly calls: Array<RecordedCall> = []
  inFlight = 0
  maxInFlight = 0
  respond: Responder = () => ok()
  readonly #clock: FakeClock

  constructor(clock: FakeClock) {
    this.#clock = clock
  }

  listTools(): Promise<Array<UpstreamTool>> {
    return Promise.resolve(TOOLS)
  }

  async callTool(
    tool: string,
    args: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    const recorded = {
      tool,
      args,
      session: call.sessionId,
      at: this.#clock.now(),
    }
    this.calls.push(recorded)
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      return await abortable(
        Promise.resolve(this.respond(recorded, this.calls.length - 1)),
        call.signal,
      )
    } finally {
      this.inFlight--
    }
  }

  closeAll(): Promise<void> {
    return Promise.resolve()
  }
}

/** A promise the test settles. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A seeded uniform random (LCG), for distinct-but-repeatable jitter. */
export function seeded(seed = 42): () => number {
  let state = seed
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 2 ** 32
    return state / 2 ** 32
  }
}

export interface GuardHarness {
  clock: FakeClock
  upstream: MemoryUpstream
  limiter: ConnectorLimiter
  guarded: GuardedUpstream
  /** Backoff waits requested (ms). */
  backoffs: Array<number>
  call(
    tool: string,
    args?: Record<string, unknown>,
    context?: Partial<ToolCallContext>,
  ): Promise<ToolResult>
}

export async function guardHarness(
  options: {
    limits?: ConnectorLimits
    hooks?: ThrottleHooks
    random?: () => number
    respond?: Responder
  } = {},
): Promise<GuardHarness> {
  const clock = new FakeClock()
  const upstream = new MemoryUpstream(clock)
  if (options.respond) upstream.respond = options.respond
  const limiter = new ConnectorLimiter(resolveLimits([options.limits]), clock)
  const backoffs: Array<number> = []
  const guarded = new GuardedUpstream({
    name: "Example",
    upstream,
    limiter,
    clock,
    hooks: options.hooks ?? HOOKS,
    sleep: (ms, signal) => {
      backoffs.push(ms)
      return clock.sleep(ms, signal)
    },
    random: options.random ?? (() => 0.5),
    toError: (error) => toConnectorError(error, { name: "Example" }),
  })
  await guarded.listTools()
  return {
    clock,
    upstream,
    limiter,
    guarded,
    backoffs,
    call: (tool, args = {}, context = {}) =>
      guarded.callTool(tool, args, {
        signal: new AbortController().signal,
        ...context,
      }),
  }
}

/** Collect progress updates. */
export function progressLog(clock: FakeClock) {
  const updates: Array<ToolProgress & { at: number }> = []
  return {
    updates,
    progress: (update: ToolProgress) =>
      void updates.push({ ...update, at: clock.now() }),
  }
}

/** The settled error of a promise (fails the test if it resolves). */
export async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected a rejection")
}
