import type { FetchLike } from "@modelcontextprotocol/client"

import { UpstreamHttpError } from "../errors"
import { sleep as defaultSleep, type Sleep } from "../util"
import { DEFAULT_LIMITS, DEFAULT_RETRY_DELAYS_MS } from "./limits"
import { parseRetryAfter } from "./retry-after"

const RETRYABLE = new Set([429, 503, 504])
/** Statuses surfaced as `UpstreamHttpError` (with body) instead of the MCP transport's generic error. */
const SURFACED = new Set([401, 403, 429, 503, 504])

export interface UpstreamFetchOptions {
  /** Fresh bearer token for every attempt (silent acquisition); `undefined` sends none. */
  getToken(signal?: AbortSignal): Promise<string | undefined>
  /** The token was rejected (401): `true` when a retry may get a fresh one. */
  onUnauthorized?(): Promise<boolean>
  /** Waits between throttled protocol requests (default 2/4/8/16 s). */
  retryDelaysMs?: ReadonlyArray<number>
  /** A protocol request's `Retry-After` longer than this fails instead of waiting (default 30 s). */
  maxWaitMs?: number
  sleep?: Sleep
  now?: () => number
  baseFetch?: FetchLike
  /**
   * A protocol request (not `tools/call`) was throttled: open the shared
   * cool-down so tool calls hold off too.
   */
  onThrottle?(status: number, retryAfterMs: number | undefined): void
}

/** JSON-RPC method of a POST body (the first message of a batch). */
function rpcMethod(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined
  try {
    const parsed = JSON.parse(body) as unknown
    const first: unknown = Array.isArray(parsed) ? parsed[0] : parsed
    const method =
      first !== null && typeof first === "object" ?
        (first as { method?: unknown }).method
      : undefined
    return typeof method === "string" ? method : undefined
  } catch {
    return undefined
  }
}

/**
 * The `fetch` handed to the MCP Streamable HTTP transport: injects
 * `Authorization: Bearer <token>` on every request and retries once with a
 * fresh token after a 401 when the token provider can refresh.
 *
 * Throttling (429/503/504) of protocol requests (`initialize`,
 * `server/discover`, `tools/list`, notifications, …) is retried here with
 * backoff, honouring `Retry-After`, and reported through `onThrottle`. A
 * throttled `tools/call` is **not** retried here: it throws
 * `UpstreamHttpError` (with `retryAfterMs`) so the guarded upstream — the
 * single owner of tool-call retries — decides, and never replays a write
 * the server may have carried out. Abortable through the request's signal.
 */
export function createUpstreamFetch(options: UpstreamFetchOptions): FetchLike {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_LIMITS.retry.maxWaitMs
  const wait = options.sleep ?? defaultSleep
  const now = options.now ?? (() => Date.now())
  const base = options.baseFetch ?? ((url, init) => fetch(url, init))

  /** Wait before the next attempt, or `undefined` when the response is final. */
  const retryDelay = (
    status: number,
    hint: number | undefined,
    attempt: number,
  ): number | undefined => {
    if (!RETRYABLE.has(status) || attempt >= delays.length) return undefined
    if (hint !== undefined && hint > maxWaitMs) return undefined
    return Math.max(hint ?? 0, delays.at(attempt) ?? 0)
  }

  /** The wait before retrying a failed response, or the `UpstreamHttpError` to throw. */
  const nextStep = async (
    response: Response,
    request: { toolCall: boolean; attempt: number; reauthorized: boolean },
  ): Promise<number> => {
    const hint = parseRetryAfter(response.headers.get("retry-after"), now())
    if (RETRYABLE.has(response.status) && !request.toolCall)
      options.onThrottle?.(response.status, hint)
    const delay =
      request.toolCall ? undefined : (
        retryDelay(response.status, hint, request.attempt)
      )
    const body = await response.text().catch(() => "")
    if (delay !== undefined) return delay
    const wwwAuthenticate = response.headers.get("www-authenticate")
    throw new UpstreamHttpError(response.status, body, {
      ...(wwwAuthenticate ? { wwwAuthenticate } : {}),
      refreshed: request.reauthorized,
      ...(hint === undefined ? {} : { retryAfterMs: hint }),
    })
  }

  return async (url, init) => {
    const signal = init?.signal ?? undefined
    const toolCall = rpcMethod(init?.body) === "tools/call"
    let reauthorized = false
    for (let attempt = 0; ; ) {
      const token = await options.getToken(signal)
      const headers = new Headers(init?.headers)
      if (token) headers.set("authorization", `Bearer ${token}`)
      const response = await base(url, { ...init, headers })
      if (response.ok || !SURFACED.has(response.status)) return response
      // One retry with a refreshed token after a 401 (not counted as an attempt).
      if (
        response.status === 401
        && token
        && !reauthorized
        && (await options.onUnauthorized?.())
      ) {
        reauthorized = true
        await response.body?.cancel().catch(() => {})
        continue
      }
      const delay = await nextStep(response, {
        toolCall,
        attempt,
        reauthorized,
      })
      await wait(delay, signal)
      attempt++
    }
  }
}
