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

import { invoke } from "@tauri-apps/api/core"

import type {
  ApiKeyEntry,
  ApiKeysListResponse,
  DiagnosticsResponse,
} from "../../src/lib/settings-types"

const TIMEOUT_MS = 5000

/**
 * GitHub device-flow auth status. Mirrors the contract owned by
 * the proxy's `/settings/api/auth/github/*` endpoints. Kept in
 * sync by name — if the backend renames a field, this breaks.
 */
export interface AuthStatus {
  state:
    | "unauthenticated"
    | "device_code_issued"
    | "polling"
    | "authenticated"
    | "error"
  user_code?: string
  verification_uri?: string
  expires_at?: string
  account_login?: string
  error?: string
  /** Set on `error` state when GHCP pointed at a recovery page in its
   *  401/403 body (TOS acceptance, Copilot settings). The UI renders
   *  it as a clickable link below the error message. */
  remediation_url?: string
}

interface AuthSignOutResponse {
  ok: true
}

/**
 * Active API clients (last-seen within a recency window). Contract is
 * jointly owned with `/settings/api/clients` on the proxy side; if the
 * server-side route ships under a different shape, update both ends.
 */
export interface ActiveApiClient {
  key: string
  label: string
  userAgent: string
  ageSeconds: number
}

interface ActiveApiClientsResponse {
  clients: Array<ActiveApiClient>
  total: number
}

/** Endpoint catalog — adding a new call means adding a member here
 *  plus a `ResponseFor` mapping. Splitting the request shape from
 *  the response type keeps call sites free of an awkward `response`
 *  field while still threading the precise response type through
 *  the generic. Phase 4 (Providers writes) will add `body` here. */
type Endpoint =
  | {
      kind: "diagnostics"
      method: "GET"
      path: "/settings/api/diagnostics"
    }
  | {
      kind: "auth-status"
      method: "GET"
      path: "/settings/api/auth/github/status"
    }
  | {
      kind: "auth-start"
      method: "POST"
      path: "/settings/api/auth/github/start"
    }
  | {
      kind: "auth-sign-out"
      method: "POST"
      path: "/settings/api/auth/github/sign-out"
    }
  | {
      kind: "api-keys-list"
      method: "GET"
      path: "/settings/api/api-keys"
    }
  | {
      kind: "api-keys-create"
      method: "POST"
      path: "/settings/api/api-keys"
      body: { label: string; key?: string; enabled?: boolean }
    }
  | {
      kind: "api-keys-update"
      method: "PATCH"
      path: `/settings/api/api-keys/${string}`
      body: { label?: string; key?: string; enabled?: boolean }
    }
  | {
      kind: "api-keys-delete"
      method: "DELETE"
      path: `/settings/api/api-keys/${string}`
    }
  | {
      kind: "api-keys-enforce"
      method: "PATCH"
      path: "/settings/api/api-keys/enforce"
      body: { enforce: boolean }
    }
  | {
      kind: "active-clients"
      method: "GET"
      path: `/settings/api/clients?maxAgeSeconds=${number}`
    }

type EndpointKind = Endpoint["kind"]

interface ResponseFor {
  diagnostics: DiagnosticsResponse
  "auth-status": AuthStatus
  "auth-start": AuthStatus
  "auth-sign-out": AuthSignOutResponse
  "api-keys-list": ApiKeysListResponse
  "api-keys-create": ApiKeyEntry
  "api-keys-update": ApiKeyEntry
  "api-keys-delete": { ok: true }
  "api-keys-enforce": ApiKeysListResponse
  "active-clients": ActiveApiClientsResponse
}

interface ApiOptions {
  /** Optional override (tests). Defaults to AbortController + 5s. */
  signal?: AbortSignal
  /** Override the API key resolver (tests). */
  apiKey?: string
}

type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }

function baseUrl(): string {
  // Vite injects import.meta.env.DEV at build time. In production
  // the shell loads from the proxy's own origin via the Tauri
  // window URL (http://localhost:4141/...), so a relative path
  // resolves to the same origin. In dev, the Vite server is on a
  // different port, so we have to absolute-prefix.
  if (import.meta.env.DEV) {
    return "http://localhost:4141"
  }
  return ""
}

// Shell-internal key cache. Populated by the first apiCall and reused
// for the lifetime of the webview. A reload re-enters this module and
// re-fetches — that's fine; the Rust shell holds the key in process
// memory and serves it on demand.
let shellKeyCache: string | null = null
let shellKeyFetched = false

async function resolveShellApiKey(): Promise<string | null> {
  if (shellKeyFetched) return shellKeyCache
  try {
    shellKeyCache = await invoke<string>("get_shell_api_key")
  } catch {
    // Not running inside Tauri (e.g. `bun run dev` opens the UI in a
    // plain browser at :1420), or the command isn't registered. Leave
    // the cache null; downstream falls back to VITE_API_KEY or no key.
    shellKeyCache = null
  }
  shellKeyFetched = true
  return shellKeyCache
}

async function resolveApiKey(override?: string): Promise<string | undefined> {
  if (override) return override
  // Dev (Vite at :1420 in a plain browser) reads VITE_API_KEY first
  // so a developer can pin a specific key. Otherwise we ask the Tauri
  // shell for the per-launch key it injected into the sidecar.
  const envKey = import.meta.env.VITE_API_KEY
  if (typeof envKey === "string" && envKey.length > 0) return envKey
  const shellKey = await resolveShellApiKey()
  return shellKey ?? undefined
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
  const apiKey = await resolveApiKey(options.apiKey)
  if (apiKey) headers["x-api-key"] = apiKey

  // Discriminated-union members carry an optional `body` field on
  // mutating endpoints. JSON-encode it and set the content-type. We
  // can't widen the function signature to take a `body` second arg
  // without making non-body endpoints awkward, so the body travels
  // on the endpoint descriptor itself.
  let bodyText: string | undefined
  const maybeBody = (endpoint as { body?: unknown }).body
  if (maybeBody !== undefined) {
    bodyText = JSON.stringify(maybeBody)
    headers["content-type"] = "application/json"
  }

  try {
    const res = await fetch(`${baseUrl()}${endpoint.path}`, {
      method: endpoint.method,
      headers,
      body: bodyText,
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
    // 204 No Content (delete) — no JSON to parse. The endpoint catalog
    // declares its response type as `{ ok: true }` so the call site
    // can treat success uniformly.
    if (res.status === 204) {
      return { ok: true, data: { ok: true } as ResponseFor[K] }
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
