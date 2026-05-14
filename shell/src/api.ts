/**
 * Typed fetch client for the proxy's `/settings/api/*` surface.
 *
 * - All data endpoints are auth-gated (see src/routes/settings/api.ts).
 *   The shell pulls its API key from the same Tauri-managed config
 *   the sidecar uses; for now we read it from a global injected by
 *   the Tauri Rust shell (TODO: wire via @tauri-apps/api in a later
 *   phase). In dev (Vite on :1420) the user supplies a key via the
 *   `VITE_API_KEY` env.
 * - 5s timeout per call via AbortController.
 * - Zero retries for v1. If retry logic is needed later, layer it
 *   here so call sites stay flat — do NOT scatter retry into each
 *   feature module.
 * - Response shape is `Result<T>` style; on any failure (network,
 *   non-2xx, JSON parse) returns `{ ok: false }` with a message.
 *   Never throws.
 *
 * Forward-looking: Phase 4 Providers will need PATCH with a typed
 * body. The Endpoint union below carries a `method`; we extend it
 * with optional `body` payload generics when that lands. The shape
 * is sized for that — `apiCall<TReq, TRes>(endpoint, { body? })` —
 * so we don't need to refactor call sites then.
 */

import type { DiagnosticsResponse } from "../../src/lib/settings-types"

const TIMEOUT_MS = 5000

/** Endpoint catalog — adding a new call means adding a member here
 *  plus a `ResponseFor` mapping. Splitting the request shape from
 *  the response type keeps call sites free of an awkward `response`
 *  field while still threading the precise response type through
 *  the generic. Phase 4 (Providers writes) will add `body` here. */
export type Endpoint = {
  kind: "diagnostics"
  method: "GET"
  path: "/settings/api/diagnostics"
}

export type EndpointKind = Endpoint["kind"]

export interface ResponseFor {
  diagnostics: DiagnosticsResponse
}

export interface ApiOptions {
  /** Optional override (tests). Defaults to AbortController + 5s. */
  signal?: AbortSignal
  /** Override the API key resolver (tests). */
  apiKey?: string
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }

function baseUrl(): string {
  // Vite injects import.meta.env.DEV at build time. In production
  // the shell loads from the proxy's own origin via the Tauri
  // window URL (http://localhost:4142/...), so a relative path
  // resolves to the same origin. In dev, the Vite server is on a
  // different port, so we have to absolute-prefix.
  if (import.meta.env.DEV) {
    return "http://localhost:4142"
  }
  return ""
}

function resolveApiKey(override?: string): string | undefined {
  if (override) return override
  // Dev: VITE_API_KEY in .env.local. Prod: TODO wire via Tauri.
  const key = import.meta.env.VITE_API_KEY
  return typeof key === "string" && key.length > 0 ? key : undefined
}

export async function apiCall<K extends EndpointKind>(
  endpoint: Extract<Endpoint, { kind: K }>,
  options: ApiOptions = {},
): Promise<ApiResult<ResponseFor[K]>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const signal = options.signal ?? controller.signal

  const headers: Record<string, string> = {
    accept: "application/json",
  }
  const apiKey = resolveApiKey(options.apiKey)
  if (apiKey) headers["x-api-key"] = apiKey

  try {
    const res = await fetch(`${baseUrl()}${endpoint.path}`, {
      method: endpoint.method,
      headers,
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return {
        ok: false,
        status: res.status,
        error: text || `HTTP ${res.status}`,
      }
    }
    const data = (await res.json()) as ResponseFor[K]
    return { ok: true, data }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    const isAbort = err instanceof DOMException && err.name === "AbortError"
    return {
      ok: false,
      status: 0,
      error: isAbort ? `Request timed out after ${TIMEOUT_MS}ms` : message,
    }
  } finally {
    clearTimeout(timer)
  }
}
