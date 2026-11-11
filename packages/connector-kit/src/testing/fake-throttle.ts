/**
 * Throttling for the fake remote MCP server: one-off injected throttles
 * (`throttle()`) and a token-bucket `rateLimit`, answered either at the
 * HTTP level or inside a normal tool result the way Work IQ reports
 * Microsoft Graph throttling (`{ statusCode: 429, error }` per entry).
 */
import type { CallToolResult } from "@modelcontextprotocol/server"

/** Throttling injected by `throttle()`. */
export interface FakeThrottle {
  /**
   * `http` (default): the MCP endpoint answers with `status`. `result`: a
   * normal tool result carrying a Graph-style throttled status, as Work IQ
   * reports Microsoft Graph throttling.
   */
  mode?: "http" | "result"
  /** Default 429. */
  status?: 429 | 503 | 504
  /** `Retry-After` value (delta-seconds or HTTP-date). */
  retryAfter?: string
  /**
   * Result mode: where `Retry-After` goes — `headers` (default,
   * `headers["retry-after"]`), `error` (`error.retryAfter`) or `message`
   * (inside `error.message`).
   */
  where?: "headers" | "error" | "message"
  /** Only calls of this tool (default any). */
  tool?: string
  /** HTTP mode: only this JSON-RPC method (default `tools/call`). */
  rpc?: string
  /**
   * Result mode, batch calls (`entityUrls`): throttle only the entries
   * whose path matches; the others are answered normally. Default: all.
   */
  paths?: (path: string) => boolean
  /** Matching requests to throttle (default 1; `Infinity` for all). */
  times?: number
}

/** A token bucket over `tools/call`: beyond it, calls are throttled. */
export interface FakeRateLimit {
  /** Sustained calls per second. */
  perSecond: number
  /** Bucket size (default `perSecond`). */
  burst?: number
  mode?: "http" | "result"
  status?: 429 | 503 | 504
  /** `Retry-After`; default the seconds until a token is free, `null` for none. */
  retryAfter?: string | null
  /** Only calls of this tool (default any). */
  tool?: string
}

const GRAPH_CODES: Record<number, string> = {
  429: "TooManyRequests",
  503: "ServiceUnavailable",
  504: "GatewayTimeout",
}

/** A Graph-style throttled entry (`{ statusCode, data, error }`) as Work IQ reports it. */
export function throttledEntry(
  status: number,
  retryAfter: string | undefined,
  where: FakeThrottle["where"] = "headers",
): Record<string, unknown> {
  const base =
    status === 429 ? "Too many requests." : (
      "The service is temporarily unavailable."
    )
  const error: Record<string, unknown> = {
    code: GRAPH_CODES[status] ?? "ServiceError",
    message:
      where === "message" && retryAfter ?
        `${base} Retry after ${retryAfter} seconds.`
      : base,
  }
  if (where === "error" && retryAfter) error.retryAfter = retryAfter
  return {
    statusCode: status,
    data: null,
    error,
    ...(where === "headers" && retryAfter ?
      { headers: { "retry-after": retryAfter } }
    : {}),
  }
}

function jsonResult(
  value: Record<string, unknown>,
  isError: boolean,
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  }
}

function batchPaths(args: Record<string, unknown>): Array<string> | undefined {
  const urls = args.entityUrls
  return Array.isArray(urls) && urls.every((url) => typeof url === "string") ?
      urls
    : undefined
}

/** Throttle a whole call, or (batch calls) the matching entries of its normal answer. */
export async function throttledResult(
  spec: FakeThrottle,
  args: Record<string, unknown>,
  answer: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const status = spec.status ?? 429
  const paths = batchPaths(args)
  if (!paths)
    return jsonResult(throttledEntry(status, spec.retryAfter, spec.where), true)
  const normal = await answer()
  const list = (normal.structuredContent as { results?: unknown } | undefined)
    ?.results
  const results = paths.map((path, index) => {
    if (!spec.paths || spec.paths(path))
      return throttledEntry(status, spec.retryAfter, spec.where)
    return Array.isArray(list) && list.length === paths.length ?
        (list[index] as unknown)
      : { statusCode: 200, data: { path }, error: null }
  })
  return jsonResult({ results }, true)
}

interface PendingThrottle {
  spec: FakeThrottle
  remaining: number
}

/** What a throttle is matched against. */
interface ThrottledRequest {
  rpc?: string | undefined
  tool?: string | undefined
  args?: Record<string, unknown>
}

/** Pending throttles, the token bucket, and how many throttled answers were sent. */
export class ThrottleState {
  readonly #now: () => number
  readonly #rateLimit: FakeRateLimit | undefined
  #pending: Array<PendingThrottle> = []
  #bucket: { tokens: number; at: number } | undefined
  #count = 0

  constructor(now: () => number, rateLimit: FakeRateLimit | undefined) {
    this.#now = now
    this.#rateLimit = rateLimit
  }

  get count(): number {
    return this.#count
  }

  add(spec: FakeThrottle): void {
    this.#pending.push({ spec, remaining: spec.times ?? 1 })
  }

  /** The throttle to answer this request with, if any (consumed). */
  take(
    mode: "http" | "result",
    request: ThrottledRequest,
  ): FakeThrottle | undefined {
    const spec =
      this.#takePending(mode, request)
      ?? (mode === "result" || request.rpc === "tools/call" ?
        this.#rateLimited(mode, request.tool)
      : undefined)
    if (spec) this.#count++
    return spec
  }

  #matches(
    spec: FakeThrottle,
    mode: "http" | "result",
    request: ThrottledRequest,
  ): boolean {
    if ((spec.mode ?? "http") !== mode) return false
    if (spec.tool !== undefined && spec.tool !== request.tool) return false
    if (mode === "http") return (spec.rpc ?? "tools/call") === request.rpc
    if (!spec.paths) return true
    const paths = batchPaths(request.args ?? {})
    return paths?.some((path) => spec.paths?.(path)) ?? false
  }

  #takePending(
    mode: "http" | "result",
    request: ThrottledRequest,
  ): FakeThrottle | undefined {
    const index = this.#pending.findIndex(({ spec }) =>
      this.#matches(spec, mode, request),
    )
    const pending = index === -1 ? undefined : this.#pending[index]
    if (!pending) return undefined
    if (--pending.remaining <= 0) this.#pending.splice(index, 1)
    return pending.spec
  }

  /** A throttle when the token bucket is empty. */
  #rateLimited(
    mode: "http" | "result",
    tool: string | undefined,
  ): FakeThrottle | undefined {
    const limit = this.#rateLimit
    if (!limit || (limit.mode ?? "http") !== mode) return undefined
    if (limit.tool !== undefined && limit.tool !== tool) return undefined
    const now = this.#now()
    const burst = limit.burst ?? limit.perSecond
    const bucket = (this.#bucket ??= { tokens: burst, at: now })
    bucket.tokens = Math.min(
      burst,
      bucket.tokens + ((now - bucket.at) / 1000) * limit.perSecond,
    )
    bucket.at = now
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return undefined
    }
    const waitMs = ((1 - bucket.tokens) / limit.perSecond) * 1000
    const retryAfter =
      limit.retryAfter === null ?
        undefined
      : (limit.retryAfter ?? String(Math.max(1, Math.ceil(waitMs / 1000))))
    return {
      status: limit.status ?? 429,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    }
  }
}
