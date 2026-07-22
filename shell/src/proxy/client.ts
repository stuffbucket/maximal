import type {
  AccountsListResponse,
  ApiKeyEntry,
  ApiKeysListResponse,
  AuthStatus,
  DiagnosticsResponse,
  ModelsListResponse,
  UpdateStatusResponse,
} from "../../../src/lib/config/settings-types"
// The active-clients wire contract is owned by the shared feed contract
// (single source of truth for the WS + this fetch client). See feed-types.ts.
import type { ActiveApiClientsResponse } from "../../../src/lib/ws/feed-types"

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
import { getShellApiKey } from "../tauri/shell"
import { readInlineState } from "./inline-state-client"

// Re-export so existing shell call sites that pull the type from
// "./api" keep working. AuthStatus is owned by src/lib/settings-types
// (ADR-0005/0006) — the shell does NOT redeclare it.

const TIMEOUT_MS = 5000

interface AuthSignOutResponse {
  ok: true
}

/** Local GitHub CLI status — mirrors GhCliStatus in src/services/gh-cli.ts
 *  (mirror by name, not import; see the note below). */
export interface GhCliStatus {
  installed: boolean
  version: string | null
  accounts: Array<{
    login: string
    host: string
    active: boolean
    scopes: Array<string>
  }>
}

interface GhUseResponse {
  ok: true
  login: string
  host: string
}

interface AccountSwitchResponse {
  ok: true
  key: string
}

interface AccountRemoveResponse {
  ok: true
  key: string
  was_active: boolean
}

/**
 * Apps integrations (Claude Code, Claude Desktop, Copilot CLI). Contract
 * is jointly owned with `/settings/api/apps` on the proxy side; if the
 * server-side route ships under a different shape, update both ends.
 * Kept LOCAL to this file on purpose — the backend's new `src/`
 * settings-types are not present in this worktree, so importing them
 * would break the typecheck. Mirror by name, not by import.
 */
export type AppId = "claude-code" | "claude-desktop" | "copilot-cli"
export type AppKind = "config" | "coming-soon"
export type AppStatus = "ready" | "not-installed" | "coming-soon"

/** Why enabling was refused. The app's config already carries a routing
 *  setting we don't own, so we backed off rather than clobber it. */
export type AppConflict = "foreign-base-url" | "foreign-api-key-helper"

export interface AppInstall {
  path: string
  version: string | null
  source: string
}

export interface AppInstallHint {
  method: "curl"
  command: string
}

export interface AppEntry {
  id: AppId
  name: string
  kind: AppKind
  enabled: boolean
  status: AppStatus
  installs: Array<AppInstall>
  /** Non-null only when claude-code has no installs (offer to install). */
  install: AppInstallHint | null
  /** Non-null when the last enable attempt was refused. The card surfaces this
   *  so the user knows why the toggle didn't take and how to resolve it. */
  conflict: AppConflict | null
}

interface AppsListResponse {
  apps: Array<AppEntry>
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
      kind: "update-status"
      method: "GET"
      path: "/settings/api/update-status"
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
      kind: "auth-cancel"
      method: "POST"
      path: "/settings/api/auth/github/cancel"
    }
  | {
      kind: "auth-rearm"
      method: "POST"
      path: "/settings/api/auth/github/rearm"
    }
  | {
      kind: "gh-status"
      method: "GET"
      path: "/settings/api/gh/status"
    }
  | {
      kind: "gh-use"
      method: "POST"
      path: "/settings/api/gh/use"
      body: { login: string; host: string }
    }
  | {
      kind: "accounts-list"
      method: "GET"
      path: "/settings/api/accounts"
    }
  | {
      kind: "accounts-switch"
      method: "POST"
      path: "/settings/api/accounts/switch"
      body: { key: string }
    }
  | {
      kind: "accounts-remove"
      method: "POST"
      path: "/settings/api/accounts/remove"
      body: { key: string }
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
  | {
      kind: "apps-list"
      method: "GET"
      path: "/settings/api/apps"
    }
  | {
      kind: "models-list"
      method: "GET"
      path: "/settings/api/models"
    }
  | {
      kind: "models-refresh"
      method: "POST"
      path: "/settings/api/models/refresh"
    }
  | {
      kind: "claude-code-toggle"
      method: "POST"
      path: "/settings/api/apps/claude-code/toggle"
      body: { enabled: boolean }
    }
  | {
      kind: "claude-desktop-toggle"
      method: "POST"
      path: "/settings/api/apps/claude-desktop/toggle"
      body: { enabled: boolean }
    }

type EndpointKind = Endpoint["kind"]

interface ResponseFor {
  diagnostics: DiagnosticsResponse
  "update-status": UpdateStatusResponse
  "auth-status": AuthStatus
  "auth-start": AuthStatus
  "auth-sign-out": AuthSignOutResponse
  "auth-cancel": AuthStatus
  "auth-rearm": {
    outcome: "online" | "auth_fatal" | "offline"
    status: AuthStatus
  }
  "gh-status": GhCliStatus
  "gh-use": GhUseResponse
  "accounts-list": AccountsListResponse
  "accounts-switch": AccountSwitchResponse
  "accounts-remove": AccountRemoveResponse
  "api-keys-list": ApiKeysListResponse
  "api-keys-create": ApiKeyEntry
  "api-keys-update": ApiKeyEntry
  "api-keys-delete": { ok: true }
  "api-keys-enforce": ApiKeysListResponse
  "active-clients": ActiveApiClientsResponse
  "apps-list": AppsListResponse
  "claude-code-toggle": AppEntry
  "claude-desktop-toggle": AppEntry
  "models-list": ModelsListResponse
  "models-refresh": ModelsListResponse
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
  // The settings + dashboard UIs are always served by the sidecar itself
  // (at /ui/*), in dev and prod alike, so the webview's origin *is* the
  // proxy. A relative path therefore resolves to the right place with no
  // build-time env injection. (Pre-Bun-unification this branched on Vite's
  // import.meta.env.DEV to target a separate :1420 dev server; there is no
  // separate dev server anymore.)
  return ""
}

// Shell-internal key cache. Populated by the first apiCall and reused
// for the lifetime of the webview. A reload re-enters this module and
// re-fetches — that's fine; the Rust shell holds the key in process
// memory and serves it on demand.

async function resolveApiKey(override?: string): Promise<string | undefined> {
  if (override) return override
  // Browser-tab delivery (§6.5): the sidecar mints a per-load session token into
  // the served HTML as `window.__STATE__.sessionToken` — a plain browser tab has
  // no Tauri IPC to fetch a key over. Prefer it when present. The `typeof window`
  // guard keeps this safe under the DOM-less test runner.
  const inlined =
    typeof globalThis.window === "undefined" ?
      null
    : readInlineState(globalThis)
  if (inlined?.sessionToken) return inlined.sessionToken
  // Tauri delivery: the shell injects a per-launch key into the sidecar and
  // serves it to the webview on demand.
  const shellKey = await getShellApiKey()
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

export {
  type AuthStatus,
  type UpstreamRejection,
} from "../../../src/lib/config/settings-types"
export { type ActiveApiClient } from "../../../src/lib/ws/feed-types"
