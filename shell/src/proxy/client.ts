import { getShellApiKey } from "../tauri/shell";

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

import type {
  AccountsListResponse,
  ApiKeyEntry,
  ApiKeysListResponse,
  AuthStatus,
  BudgetActivityResponse,
  BudgetSimulateRequest,
  BudgetSimulateResponse,
  BudgetTimelineResponse,
  BudgetLimitPutRequest,
  BudgetSettingsPatchRequest,
  BudgetStatusResponse,
  ClaudeAutoModelsUpdateRequest,
  ClaudeCodeInstallStatus,
  DiagnosticsResponse,
  ModelsListResponse,
  PluginActionResponse,
  PluginDetailView,
  PluginsListResponse,
  PluginStatus,
  PluginToolPermissionsRequest,
  PluginUpdateRequest,
  PluginValidationErrorResponse,
  PluginValidationIssue,
  UpdateStatusResponse,
  UpstreamRejection,
} from "../../../src/lib/config/settings-types"

// Re-export so existing shell call sites that pull the type from
// "./api" keep working. AuthStatus is owned by src/lib/settings-types
// (ADR-0005/0006) — the shell does NOT redeclare it. The plugin
// (Connectors) contract is owned there too.
export type { AuthStatus, ClaudeCodeInstallStatus, UpstreamRejection }
export type {
  JsonSchemaObject,
  PluginClientId,
  PluginClientView,
  PluginConnectorInfo,
  PluginDetailView,
  PluginStatus,
  PluginToolView,
  PluginUpdateRequest,
  PluginValidationErrorResponse,
  PluginValidationIssue,
  PluginView,
  ToolGroup,
  ToolPermission,
} from "../../../src/lib/config/settings-types"

/** One action button a plugin's status offers. */
export type PluginStatusAction = NonNullable<PluginStatus["actions"]>[number]
export type PluginStatusState = PluginStatus["state"]

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

/**
 * Apps integrations (Claude Code, Claude Desktop, Codex, Copilot CLI). Contract
 * is jointly owned with `/settings/api/apps` on the proxy side; if the
 * server-side route ships under a different shape, update both ends.
 * Kept LOCAL to this file on purpose — the backend's new `src/`
 * settings-types are not present in this worktree, so importing them
 * would break the typecheck. Mirror by name, not by import.
 */
export type AppId = "claude-code" | "claude-desktop" | "codex" | "copilot-cli"
export type AppKind = "config" | "coming-soon"
export type AppStatus = "ready" | "not-installed" | "coming-soon"

/** Why enabling was refused. The app's config already carries a routing
 *  setting we don't own, so we backed off rather than clobber it. */
export type AppConflict =
  | "foreign-base-url"
  | "foreign-api-key-helper"
  | "foreign-gateway-profile"
  | "cleanup-required"

export interface AppInstall {
  kind?: "cli" | "desktop"
  path: string
  version: string | null
  source: string
}

export interface AppInstallHint {
  method: "curl" | "npm" | "powershell"
  command: string
  /** `winget`: Maximal can run this install itself after the user clicks. */
  automatic: "winget" | null
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
      // "Check now": a fresh check, skipping the proxy's 6-hour cache.
      kind: "update-check"
      method: "GET"
      path: "/settings/api/update-status?force=1"
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
      kind: "models-auto-update"
      method: "PATCH"
      path: "/settings/api/models/claude-code-auto"
      body: ClaudeAutoModelsUpdateRequest
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
  | {
      kind: "claude-code-install-status"
      method: "GET"
      path: "/settings/api/apps/claude-code/install"
    }
  | {
      kind: "claude-code-install-start"
      method: "POST"
      path: "/settings/api/apps/claude-code/install"
      body: { method: "winget" }
    }
  | {
      kind: "codex-toggle"
      method: "POST"
      path: "/settings/api/apps/codex/toggle"
      body: { enabled: boolean }
    }
  | {
      kind: "plugins-list"
      method: "GET"
      path: "/settings/api/plugins"
    }
  | {
      kind: "plugins-detail"
      method: "GET"
      path: `/settings/api/plugins/${string}`
    }
  | {
      kind: "plugins-update"
      method: "PATCH"
      path: `/settings/api/plugins/${string}`
      body: PluginUpdateRequest
    }
  | {
      kind: "plugins-tool-permissions"
      method: "PUT"
      path: `/settings/api/plugins/${string}/tool-permissions`
      body: PluginToolPermissionsRequest
    }
  | {
      kind: "plugins-action"
      method: "POST"
      path: `/settings/api/plugins/${string}/actions/${string}`
    }

  | {
      kind: "budget-status"
      method: "GET"
      path: "/settings/api/budget"
    }
  | {
      kind: "budget-settings"
      method: "PATCH"
      path: "/settings/api/budget"
      body: BudgetSettingsPatchRequest
    }
  | {
      kind: "budget-limit-put"
      method: "PUT"
      path: `/settings/api/budget/limits/${string}`
      body: BudgetLimitPutRequest
    }
  | {
      kind: "budget-limit-delete"
      method: "DELETE"
      path: `/settings/api/budget/limits/${string}`
    }
  | {
      kind: "budget-activity"
      method: "GET"
      path: `/settings/api/budget/activity?${string}`
    }
  | {
      kind: "budget-timeline"
      method: "GET"
      path: `/settings/api/budget/limits/${string}/timeline?${string}`
    }
  | {
      kind: "budget-simulate"
      method: "POST"
      path: "/settings/api/budget/simulate"
      body: BudgetSimulateRequest
    }

type EndpointKind = Endpoint["kind"]

interface ResponseFor {
  diagnostics: DiagnosticsResponse
  "update-status": UpdateStatusResponse
  "update-check": UpdateStatusResponse
  "auth-status": AuthStatus
  "auth-start": AuthStatus
  "auth-sign-out": AuthSignOutResponse
  "auth-cancel": AuthStatus
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
  "codex-toggle": AppEntry
  "plugins-list": PluginsListResponse
  "plugins-detail": PluginDetailView
  "plugins-update": PluginDetailView
  "plugins-tool-permissions": PluginDetailView
  "plugins-action": PluginActionResponse
  "claude-code-install-status": ClaudeCodeInstallStatus
  "claude-code-install-start": ClaudeCodeInstallStatus
  "models-list": ModelsListResponse
  "models-refresh": ModelsListResponse
  "models-auto-update": ModelsListResponse
  "budget-status": BudgetStatusResponse
  "budget-settings": BudgetStatusResponse
  "budget-limit-put": BudgetStatusResponse
  "budget-limit-delete": BudgetStatusResponse
  "budget-activity": BudgetActivityResponse
  "budget-timeline": BudgetTimelineResponse
  "budget-simulate": BudgetSimulateResponse
}

interface ApiOptions {
  /** Optional override (tests). Defaults to AbortController + 5s. */
  signal?: AbortSignal
  /** Override the API key resolver (tests). */
  apiKey?: string
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }

/** A failed call: HTTP status (0 when Maximal never answered) + raw body. */
export type ApiFailure = Extract<ApiResult<unknown>, { ok: false }>

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
  // The Tauri shell injects a per-launch key into the sidecar and serves
  // it to the webview on demand; that's the sole key source now.
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

/** Handle to the live SSE subscription; call `close()` to disconnect. */
export interface EventSubscription {
  close: () => void
}

/**
 * Subscribe to the sidecar's live event stream (ADR-0007). Opens an
 * `EventSource` against `/settings/api/events` and dispatches typed events
 * to the handlers — currently `auth.changed`, carrying the full `AuthStatus`
 * (same shape as GET /settings/api/auth/github/status).
 *
 * EventSource can't send headers, so the API key rides in the query string;
 * the sidecar honours `?key=` only for this endpoint (see request-auth.ts).
 * The browser's EventSource auto-reconnects on transient drops; `onError`
 * fires on each disconnect so the caller can fall back to a GET/poll until
 * the stream recovers. Never throws — payload parse failures are swallowed
 * and resynced by the next event or the GET fallback.
 */
export async function subscribeAuthEvents(handlers: {
  onAuth: (status: AuthStatus) => void
  onOpen?: () => void
  onError?: () => void
}): Promise<EventSubscription> {
  const apiKey = await resolveApiKey()
  const query = apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""
  const source = new EventSource(`${baseUrl()}/settings/api/events${query}`)

  source.addEventListener("open", () => handlers.onOpen?.())
  source.addEventListener("error", () => handlers.onError?.())
  source.addEventListener("auth.changed", (event) => {
    const message = event as MessageEvent<string>
    try {
      handlers.onAuth(JSON.parse(message.data) as AuthStatus)
    } catch {
      // Malformed frame — drop it; the next event (or a GET fallback)
      // resyncs. An event listener must never throw.
    }
  })

  return { close: () => source.close() }
}

/**
 * Subscribe to `plugins.changed` on the same stream: a plugin's lifecycle,
 * status or tool list changed. The frame is only a nudge; the listener
 * refetches GET /settings/api/plugins. `onOpen` fires on every (re)connect so
 * the caller can resync what it missed while the stream was down.
 */
export async function subscribePluginEvents(handlers: {
  onChanged: () => void
  onOpen?: () => void
  onError?: () => void
}): Promise<EventSubscription> {
  const apiKey = await resolveApiKey()
  const query = apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""
  const source = new EventSource(`${baseUrl()}/settings/api/events${query}`)

  source.addEventListener("open", () => handlers.onOpen?.())
  source.addEventListener("error", () => handlers.onError?.())
  source.addEventListener("plugins.changed", () => handlers.onChanged())

  return { close: () => source.close() }
}

/**
 * Subscribe to `budget.changed` on the same stream: a limit, the on/off switch
 * or the display unit changed, or a limit crossed its warning. The frame
 * carries the whole status (the same payload as GET /settings/api/budget), so
 * the listener needs no refetch. `onOpen` fires on every (re)connect so the
 * caller can resync what it missed while the stream was down.
 */
export async function subscribeBudgetEvents(handlers: {
  onChanged: (status: BudgetStatusResponse) => void
  onOpen?: () => void
  onError?: () => void
}): Promise<EventSubscription> {
  const apiKey = await resolveApiKey()
  const query = apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""
  const source = new EventSource(`${baseUrl()}/settings/api/events${query}`)

  source.addEventListener("open", () => handlers.onOpen?.())
  source.addEventListener("error", () => handlers.onError?.())
  source.addEventListener("budget.changed", (event) => {
    const message = event as MessageEvent<string>
    try {
      handlers.onChanged(JSON.parse(message.data) as BudgetStatusResponse)
    } catch {
      // Malformed frame: drop it; the next event or reconnect resyncs.
    }
  })

  return { close: () => source.close() }
}

/**
 * The activity as CSV text. Not `apiCall`: the reply isn't JSON, and the
 * file is saved as it came (`activity.csv` shares the activity query).
 */
export async function fetchBudgetCsv(
  query: string,
): Promise<ApiResult<string>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const apiKey = await resolveApiKey()
    const res = await fetch(`${baseUrl()}/settings/api/budget/activity.csv?${query}`, {
      headers: apiKey ? { "x-api-key": apiKey } : {},
      signal: controller.signal,
    })
    const text = await res.text().catch(() => "")
    if (!res.ok) {
      return { ok: false, status: res.status, error: text || `HTTP ${res.status}` }
    }
    return { ok: true, data: text }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : "Unknown error" }
  } finally {
    clearTimeout(timer)
  }
}

export function listPlugins(): Promise<ApiResult<PluginsListResponse>> {
  return apiCall({ kind: "plugins-list", method: "GET", path: "/settings/api/plugins" })
}

const pluginPath = (id: string): `/settings/api/plugins/${string}` =>
  `/settings/api/plugins/${encodeURIComponent(id)}`

/** One plugin with its config, config schema and every tool's permission. */
export function getPlugin(id: string): Promise<ApiResult<PluginDetailView>> {
  return apiCall({ kind: "plugins-detail", method: "GET", path: pluginPath(id) })
}

/** Turn a plugin on/off, choose the clients it is registered with, and/or
 *  replace its config. A config the plugin rejects answers 400 with
 *  `issues` (see `pluginValidationIssues`). */
export function updatePlugin(
  id: string,
  body: PluginUpdateRequest,
): Promise<ApiResult<PluginDetailView>> {
  return apiCall({ kind: "plugins-update", method: "PATCH", path: pluginPath(id), body })
}

/** Set tool permissions by tool name; `null` returns a tool to its default. */
export function setToolPermissions(
  id: string,
  permissions: PluginToolPermissionsRequest["permissions"],
): Promise<ApiResult<PluginDetailView>> {
  return apiCall({
    kind: "plugins-tool-permissions",
    method: "PUT",
    path: `${pluginPath(id)}/tool-permissions`,
    body: { permissions },
  })
}

/** Start one of the plugin's status actions. Answers 202 at once; how it
 *  goes (sign-in can take minutes) arrives through `plugins.changed`. */
export function runPluginAction(
  id: string,
  actionId: string,
): Promise<ApiResult<PluginActionResponse>> {
  return apiCall({
    kind: "plugins-action",
    method: "POST",
    path: `${pluginPath(id)}/actions/${encodeURIComponent(actionId)}`,
  })
}

/** The `issues` of a 400 validation reply, or `null` when the failure is
 *  something else (the raw body travels in `ApiFailure.error`). */
export function pluginValidationIssues(failure: ApiFailure): Array<PluginValidationIssue> | null {
  if (failure.status !== 400) return null
  try {
    const body = JSON.parse(failure.error) as Partial<PluginValidationErrorResponse>
    return Array.isArray(body.issues) ? body.issues : null
  } catch {
    return null
  }
}
