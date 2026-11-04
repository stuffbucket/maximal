import type { FetchLike } from "@modelcontextprotocol/client"

import { UpstreamHttpError } from "../errors"
import { sleep as defaultSleep, type Sleep } from "../util"

/** agent-kit policy: 5 attempts in total, waiting 2, 4, 8 and 16 s between them. */
export const DEFAULT_RETRY_DELAYS_MS: ReadonlyArray<number> = [
  2000, 4000, 8000, 16000,
]

/** Never wait longer than this for a server-provided `Retry-After`. */
export const MAX_RETRY_AFTER_MS = 60_000

const RETRYABLE = new Set([429, 503, 504])
/** Statuses surfaced as `UpstreamHttpError` (with body) instead of the MCP transport's generic error. */
const SURFACED = new Set([401, 403, 429, 503, 504])

export interface UpstreamFetchOptions {
  /** Fresh bearer token for every attempt (silent MSAL acquisition). */
  getToken(signal?: AbortSignal): Promise<string>
  retryDelaysMs?: ReadonlyArray<number>
  sleep?: Sleep
  baseFetch?: FetchLike
}

/** `Retry-After` as milliseconds (delta-seconds or HTTP date), if present and sane. */
export function retryAfterMs(
  header: string | null,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed))
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS)
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS)
}

/**
 * The `fetch` handed to the MCP Streamable HTTP transport: injects
 * `Authorization: Bearer <token>` on every request and retries throttling
 * (429/503/504) with backoff, honouring `Retry-After`. Abortable through the
 * request's signal. Final auth/throttling failures throw `UpstreamHttpError`
 * so callers can map them to clear messages.
 */
export function createUpstreamFetch(options: UpstreamFetchOptions): FetchLike {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const wait = options.sleep ?? defaultSleep
  const base = options.baseFetch ?? ((url, init) => fetch(url, init))

  return async (url, init) => {
    const signal = init?.signal ?? undefined
    for (let attempt = 0; ; attempt++) {
      const token = await options.getToken(signal)
      const headers = new Headers(init?.headers)
      headers.set("authorization", `Bearer ${token}`)
      const response = await base(url, { ...init, headers })
      if (response.ok || !SURFACED.has(response.status)) return response

      const retryable =
        RETRYABLE.has(response.status) && attempt < delays.length
      const delay =
        retryable ?
          (retryAfterMs(response.headers.get("retry-after"))
          ?? delays.at(attempt)
          ?? 0)
        : 0
      const body = await response.text().catch(() => "")
      if (!retryable) {
        throw new UpstreamHttpError(
          response.status,
          body,
          response.headers.get("www-authenticate") ?? undefined,
        )
      }
      await wait(delay, signal)
    }
  }
}
