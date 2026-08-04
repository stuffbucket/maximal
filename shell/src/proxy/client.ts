import {
  AccountsListResponse,
  ApiKeyEntry,
  ApiKeysListResponse,
  AppEntry,
  AppsListResponse,
  AuthStatus,
  DiagnosticsResponse,
  ModelsListResponse,
  UpdateStatusResponse,
} from "@stuffbucket/maximal-core/settings-types"
import { z } from "zod"

// The active-clients wire contract is owned by the shared feed contract
// (single source of truth for the WS + this fetch client). See feed-types.ts.
import type { ActiveApiClientsResponse } from "./feed-types"

/**
 * Typed fetch client for the proxy's `/control/*` surface.
 *
 * - All data endpoints are auth-gated (see src/routes/control.ts).
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

/** Minimal `{ ok: true }` acknowledgement (sign-out, key delete). */
const AckResponse = z.object({ ok: z.literal(true) })

/** Local GitHub CLI status — mirrors GhCliStatus in src/services/gh-cli.ts
 *  (mirror by name; the proxy has no zod schema for it to share). */
export const GhCliStatus = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  accounts: z.array(
    z.object({
      login: z.string(),
      host: z.string(),
      active: z.boolean(),
      scopes: z.array(z.string()),
    }),
  ),
})
export type GhCliStatus = z.infer<typeof GhCliStatus>

const GhUseResponse = z.object({
  ok: z.literal(true),
  login: z.string(),
  host: z.string(),
})

const AccountSwitchResponse = z.object({
  ok: z.literal(true),
  key: z.string(),
})

const AccountRemoveResponse = z.object({
  ok: z.literal(true),
  key: z.string(),
  was_active: z.boolean(),
})

/** `/control/auth/rearm` — re-arm outcome plus the fresh status. */
const AuthRearmResponse = z.object({
  outcome: z.enum(["online", "auth_fatal", "offline"]),
  status: AuthStatus,
})

/** `/control/clients` — inline `{ clients, total }` snapshot. The wire
 *  type is owned by feed-types (no zod schema there yet); this mirrors it so
 *  the fetch path validates the same shape the WS feed delivers. */
const ActiveApiClientsResponseSchema = z.object({
  clients: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      userAgent: z.string(),
      ageSeconds: z.number(),
    }),
  ),
  total: z.number(),
})

// Apps integrations (Claude Code, Claude Desktop, Copilot CLI) reuse the
// authoritative, backend-validated schemas from settings-types — the same
// schemas the proxy's /control/apps route validates its responses
// against — so there is a single source of truth, not a hand-kept mirror.
export type AppId = AppEntry["id"]
export type AppKind = AppEntry["kind"]
export type AppStatus = AppEntry["status"]
export type AppConflict = NonNullable<AppEntry["conflict"]>

/** Endpoint catalog — adding a new call means adding a member here
 *  plus a `ResponseFor` mapping. Splitting the request shape from
 *  the response type keeps call sites free of an awkward `response`
 *  field while still threading the precise response type through
 *  the generic. Phase 4 (Providers writes) will add `body` here. */
type Endpoint =
  | {
      kind: "diagnostics"
      method: "GET"
      path: "/control/diagnostics"
    }
  | {
      kind: "update-status"
      method: "GET"
      path: "/control/update-status"
    }
  | {
      kind: "auth-status"
      method: "GET"
      path: "/control/auth"
    }
  | {
      kind: "auth-start"
      method: "POST"
      path: "/control/auth/start"
    }
  | {
      kind: "auth-sign-out"
      method: "POST"
      path: "/control/auth/sign-out"
    }
  | {
      kind: "auth-cancel"
      method: "POST"
      path: "/control/auth/cancel"
    }
  | {
      kind: "auth-rearm"
      method: "POST"
      path: "/control/auth/rearm"
    }
  | {
      kind: "gh-status"
      method: "GET"
      path: "/control/gh/status"
    }
  | {
      kind: "gh-use"
      method: "POST"
      path: "/control/gh/use"
      body: { login: string; host: string }
    }
  | {
      kind: "accounts-list"
      method: "GET"
      path: "/control/accounts"
    }
  | {
      kind: "accounts-switch"
      method: "POST"
      path: "/control/accounts/switch"
      body: { key: string }
    }
  | {
      kind: "accounts-remove"
      method: "POST"
      path: "/control/accounts/remove"
      body: { key: string }
    }
  | {
      kind: "api-keys-list"
      method: "GET"
      path: "/control/api-keys"
    }
  | {
      kind: "api-keys-create"
      method: "POST"
      path: "/control/api-keys"
      body: { label: string; key?: string; enabled?: boolean }
    }
  | {
      kind: "api-keys-update"
      method: "PATCH"
      path: `/control/api-keys/${string}`
      body: { label?: string; key?: string; enabled?: boolean }
    }
  | {
      kind: "api-keys-delete"
      method: "DELETE"
      path: `/control/api-keys/${string}`
    }
  | {
      kind: "api-keys-enforce"
      method: "PATCH"
      path: "/control/api-keys/enforce"
      body: { enforce: boolean }
    }
  | {
      kind: "active-clients"
      method: "GET"
      path: `/control/clients?maxAgeSeconds=${number}`
    }
  | {
      kind: "apps-list"
      method: "GET"
      path: "/control/apps"
    }
  | {
      kind: "models-list"
      method: "GET"
      path: "/control/models"
    }
  | {
      kind: "models-refresh"
      method: "POST"
      path: "/control/models/refresh"
    }
  | {
      kind: "claude-code-toggle"
      method: "POST"
      path: "/control/apps/claude-code/toggle"
      body: { enabled: boolean }
    }
  | {
      kind: "claude-desktop-toggle"
      method: "POST"
      path: "/control/apps/claude-desktop/toggle"
      body: { enabled: boolean }
    }

type EndpointKind = Endpoint["kind"]

interface ResponseFor {
  diagnostics: DiagnosticsResponse
  "update-status": UpdateStatusResponse
  "auth-status": AuthStatus
  "auth-start": AuthStatus
  "auth-sign-out": z.infer<typeof AckResponse>
  "auth-cancel": AuthStatus
  "auth-rearm": z.infer<typeof AuthRearmResponse>
  "gh-status": GhCliStatus
  "gh-use": z.infer<typeof GhUseResponse>
  "accounts-list": AccountsListResponse
  "accounts-switch": z.infer<typeof AccountSwitchResponse>
  "accounts-remove": z.infer<typeof AccountRemoveResponse>
  "api-keys-list": ApiKeysListResponse
  "api-keys-create": ApiKeyEntry
  "api-keys-update": ApiKeyEntry
  "api-keys-delete": z.infer<typeof AckResponse>
  "api-keys-enforce": ApiKeysListResponse
  "active-clients": ActiveApiClientsResponse
  "apps-list": AppsListResponse
  "claude-code-toggle": AppEntry
  "claude-desktop-toggle": AppEntry
  "models-list": ModelsListResponse
  "models-refresh": ModelsListResponse
}

/**
 * Runtime schema for every endpoint's response body. `apiCall` `safeParse`s
 * the JSON against the matching entry so a shape the server didn't actually
 * send (version skew, a partial/'500-shaped' body, an older sidecar) becomes
 * a clean `{ ok: false }` Result instead of a raw cast that a consumer later
 * dereferences and crashes on. Total over `EndpointKind` — a new endpoint
 * won't typecheck until it declares its schema here.
 *
 * The settings-types schemas are the *same* objects the proxy validates its
 * responses against (see src/routes/control.ts, apps.ts), so they can't
 * drift from the wire; the handful of small local schemas above mirror the
 * routes that have no shared schema yet.
 */
const SCHEMA_FOR: Record<EndpointKind, z.ZodType> = {
  diagnostics: DiagnosticsResponse,
  "update-status": UpdateStatusResponse,
  "auth-status": AuthStatus,
  "auth-start": AuthStatus,
  "auth-sign-out": AckResponse,
  "auth-cancel": AuthStatus,
  "auth-rearm": AuthRearmResponse,
  "gh-status": GhCliStatus,
  "gh-use": GhUseResponse,
  "accounts-list": AccountsListResponse,
  "accounts-switch": AccountSwitchResponse,
  "accounts-remove": AccountRemoveResponse,
  "api-keys-list": ApiKeysListResponse,
  "api-keys-create": ApiKeyEntry,
  "api-keys-update": ApiKeyEntry,
  "api-keys-delete": AckResponse,
  "api-keys-enforce": ApiKeysListResponse,
  "active-clients": ActiveApiClientsResponseSchema,
  "apps-list": AppsListResponse,
  "claude-code-toggle": AppEntry,
  "claude-desktop-toggle": AppEntry,
  "models-list": ModelsListResponse,
  "models-refresh": ModelsListResponse,
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
    const json: unknown = await res.json()
    // Validate the body against the endpoint's schema. A cast alone is a lie
    // the moment the wire disagrees (an older sidecar, a partial payload); a
    // failed parse becomes an error Result the caller already handles, instead
    // of surfacing as an undefined-deref crash deep inside a consumer.
    const parsed = SCHEMA_FOR[endpoint.kind].safeParse(json)
    if (!parsed.success) {
      console.warn(
        `apiCall(${endpoint.kind}): response failed schema validation`,
        parsed.error.issues,
      )
      return {
        ok: false,
        status: res.status,
        error: `Malformed response for ${endpoint.kind}`,
      }
    }
    return { ok: true, data: parsed.data as ResponseFor[K] }
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

export { type ActiveApiClient } from "./feed-types"
export {
  // Apps types now live in settings-types (single source of truth); re-export
  // so shell call sites keep importing them from the client.
  type AppEntry,
  type AppInstall,
  type AppInstallHint,
  type AppsListResponse,
  type AuthStatus,
  type UpstreamRejection,
} from "@stuffbucket/maximal-core/settings-types"
