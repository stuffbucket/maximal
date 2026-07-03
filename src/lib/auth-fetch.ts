/**
 * The single authenticated-HTTP chokepoint.
 *
 * The proxy reads its own 0o600 GitHub/Copilot token from disk (at boot, into
 * `state`) and forwards it upstream as an `Authorization` header — the same
 * posture as `gh` / `aws` / `kubectl`, and the proxy's reason to exist. CodeQL
 * traces that file→HTTP dataflow and flags `js/file-access-to-http` at every
 * authenticated `fetch`. Rather than annotate each sink (fragile: the set
 * drifts as endpoints are added, and any of them can be newly flagged by a
 * heuristic shift), every authenticated request funnels through `authFetch`, so
 * the by-design suppression lives in exactly ONE place.
 *
 * Callers still build their own headers and resolve their own base URL — this
 * wrapper deliberately does NOT inspect or construct either, so the Copilot
 * host precedence and opencode-oauth header branches in `api-config.ts` are
 * untouched. It only owns the `fetch` sink and an optional timeout.
 */

import { HTTPError } from "~/lib/error"

export interface AuthFetchInit extends RequestInit {
  /**
   * When set, abort the request after this many ms via `AbortSignal.timeout`.
   * Omit to leave the request unbounded (streaming completions, embeddings).
   * An explicit `signal` always wins over `timeoutMs`.
   */
  timeoutMs?: number
}

/**
 * Perform an authenticated upstream request. Returns the raw `Response` so
 * callers keep full control of streaming, status handling, and error mapping.
 */
export async function authFetch(
  url: string,
  init: AuthFetchInit = {},
): Promise<Response> {
  const { timeoutMs, signal, ...rest } = init
  return fetch(url, {
    // codeql[js/file-access-to-http] -- by design, the SINGLE chokepoint: the
    // proxy reads its own 0o600 GitHub/Copilot token from disk and forwards it
    // upstream as Authorization. Same posture as gh/aws/kubectl. Every
    // authenticated fetch funnels here, so this is the only suppression. See ADR-0001.
    ...rest,
    signal:
      signal
      ?? (timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)),
  })
}

/**
 * Convenience for the common auth/discovery shape: bounded (or unbounded) read,
 * an `ok` check that throws `HTTPError`, and a JSON parse. Callers with bespoke
 * non-OK handling (strict auth-fatal, 200-with-error bodies, error logging)
 * should use `authFetch` directly.
 */
export async function authFetchJson<T>(
  url: string,
  init: AuthFetchInit & { errorMessage: string },
): Promise<T> {
  const { errorMessage, ...rest } = init
  const response = await authFetch(url, rest)
  if (!response.ok) throw new HTTPError(errorMessage, response)
  return (await response.json()) as T
}
