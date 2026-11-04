/**
 * The mock sidecar's HTTP surface, as a pure `Request → Response` function.
 *
 * Shared by two hosts:
 *   • scripts/ui-harness.ts — wraps it in a Bun server on :4747;
 *   • packages/storybook — installs it as an in-browser `fetch` override so
 *     stories render the real components/windows against the same fixtures.
 *
 * Browser-safe on purpose: web-standard Request/Response/URL only, no node:*
 * imports, so the same file bundles for either host. Fixtures come from
 * ui-harness-fixtures.ts (validated against the real Zod schemas by the
 * harness at startup).
 *
 * Mutations (toggles, key create/delete, sign-in) update per-backend state so
 * the UI reacts like the real thing within a session. A fresh backend reseeds.
 */
import type { AuthStatus, PluginDetailView } from "../src/lib/config/settings-types"

import {
  ClaudeAutoModelsUpdateRequest,
  PluginToolPermissionsRequest,
  PluginUpdateRequest,
} from "../src/lib/config/settings-types"
import {
  type ResolvedScenario,
  type ScenarioId,
  type WorkiqStage,
  listItem,
  resolveScenario,
  toolCounts,
  workiqStatus,
  workiqToolViews,
} from "./ui-harness-fixtures"

export interface MockBackend {
  readonly scenario: ScenarioId
  /** Current auth state (what the SSE `auth.changed` frame carries). */
  readonly auth: AuthStatus
  /** Handle a request; `null` means the path isn't part of the mocked surface. */
  handle: (req: Request) => Promise<Response | null>
  /** Called whenever a mutation changes `auth`. Returns an unsubscribe. */
  onAuthChange: (listener: (auth: AuthStatus) => void) => () => void
  /** Called whenever a plugin's lifecycle, status, tools or settings change
   *  (the SSE `plugins.changed` frame). Returns an unsubscribe. */
  onPluginsChange: (listener: () => void) => () => void
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

/** True for the paths this module answers (the UI's whole backend surface). */
export function isMockedPath(path: string): boolean {
  return (
    path.startsWith("/settings/api/") ||
    path === "/usage" ||
    path === "/token-usage" ||
    path === "/token-usage/sessions" ||
    path === "/token-usage/events"
  )
}

export function createMockBackend(scenario: ScenarioId): MockBackend {
  const fixture: ResolvedScenario = resolveScenario(scenario)
  const state = structuredClone({
    auth: fixture.auth,
    apps: fixture.apps,
    apiKeys: fixture.apiKeys,
    accounts: fixture.accounts,
    models: fixture.models,
    connectors: fixture.connectors,
  }) as {
    auth: AuthStatus
    apps: ResolvedScenario["apps"]
    apiKeys: ResolvedScenario["apiKeys"]
    accounts: ResolvedScenario["accounts"]
    models: ResolvedScenario["models"]
    connectors: Array<PluginDetailView>
  }
  const pluginListeners = new Set<() => void>()
  const pluginsChanged = (): void => {
    for (const l of pluginListeners) l()
  }
  // Where each connector's setup stands, so enabling it again picks up where
  // the user left off (the real connector keeps this in its own storage).
  const stages = new Map<string, WorkiqStage>()
  for (const connector of fixture.connectors) {
    const code = connector.status?.code
    const stage: WorkiqStage | undefined =
      code === "terms-needed" ? "terms-needed"
      : code === "signin-needed" || code === "signing-in" ? "signin-needed"
      : code === "ready" ? "ready"
      : code === "consent-needed" ? "error"
      : undefined
    stages.set(connector.id, stage ?? "terms-needed")
  }
  const listeners = new Set<(auth: AuthStatus) => void>()
  const setAuth = (next: AuthStatus): void => {
    state.auth = next
    for (const l of listeners) l(next)
  }

  const findConnector = (id: string): PluginDetailView | undefined =>
    state.connectors.find((c) => c.id === id)

  /** Tools follow the stage: live once ready (catalog refreshed), else the
   *  last catalog stays as a cache; the user's permissions are kept. */
  const syncTools = (connector: PluginDetailView): void => {
    const live = connector.lifecycle === "active" && stages.get(connector.id) === "ready"
    if (live && connector.tools.length === 0) {
      connector.tools = workiqToolViews([])
    }
    if (live) connector.catalogUpdatedAt = new Date().toISOString()
    connector.toolsSource = live ? "live" : connector.tools.length > 0 ? "cache" : "none"
    connector.toolCounts = toolCounts(connector.tools)
  }

  /** Move a (running) connector to a setup stage, as its own status would. */
  const setStage = (id: string, stage: WorkiqStage): void => {
    const connector = findConnector(id)
    if (!connector) return
    stages.set(id, stage)
    connector.status = workiqStatus(stage)
    syncTools(connector)
    pluginsChanged()
  }

  /** The connector kit's config check: endpoint and authority are http(s) URLs. */
  const configIssues = (config: Record<string, unknown>): Array<{ path: string; message: string }> => {
    const issues: Array<{ path: string; message: string }> = []
    for (const key of ["endpoint", "authority"]) {
      const value = config[key]
      if (value === undefined) continue
      let ok = false
      if (typeof value === "string") {
        try {
          ok = /^https?:$/.test(new URL(value).protocol)
        } catch {
          ok = false
        }
      }
      if (!ok) issues.push({ path: `config.${key}`, message: "Invalid URL. Enter an http(s) address, e.g. https://example.com/mcp." })
    }
    for (const key of Object.keys(config)) {
      if (key !== "endpoint" && key !== "authority") {
        issues.push({ path: `config.${key}`, message: `Unrecognized key: "${key}"` })
      }
    }
    return issues
  }

  const invalid = (issues: Array<{ path: string; message: string }>): Response =>
    json(
      {
        error: {
          message: issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
          type: "invalid_request_error",
        },
        issues,
      },
      400,
    )

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url)
    const path = url.pathname
    const method = req.method
    if (!isMockedPath(path)) return null
    const body = async (): Promise<any> => req.json().catch(() => ({}))

    // --- dashboard (/usage + /token-usage + /token-usage/sessions) ---
    if (path === "/usage") {
      if (state.auth.state !== "authenticated") {
        return json(
          {
            error: "not_authenticated",
            hint: "Open Settings → Account to sign in, or run `maximal auth`.",
          },
          401,
        )
      }
      return json(fixture.dashboard.usage)
    }
    if (path === "/token-usage") return json(fixture.dashboard.tokenUsage)
    if (path === "/token-usage/sessions") {
      const delayMs = Math.max(0, Number(url.searchParams.get("delay_ms")) || 0)
      if (delayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      return json(fixture.dashboard.sessions())
    }
    if (path === "/token-usage/events") {
      const pageSize = Math.max(
        1,
        Number(url.searchParams.get("page_size")) || 20,
      )
      const events = fixture.dashboard.tokenEvents
      const totalPages = Math.max(1, Math.ceil(events.length / pageSize))
      const page = Math.min(
        totalPages,
        Math.max(1, Number(url.searchParams.get("page")) || 1),
      )
      return json({
        items: events.slice((page - 1) * pageSize, page * pageSize),
        page,
        total: events.length,
        total_pages: totalPages,
        range: fixture.dashboard.tokenUsage.range,
      })
    }

    // --- reads ---
    if (path === "/settings/api/diagnostics") return json(fixture.diagnostics)
    if (path === "/settings/api/update-status")
      return json(fixture.updateStatus)
    if (path === "/settings/api/auth/github/status") return json(state.auth)
    if (path === "/settings/api/accounts") return json(state.accounts)
    if (path === "/settings/api/api-keys" && method === "GET")
      return json(state.apiKeys)
    if (path === "/settings/api/apps") return json(state.apps)
    if (path === "/settings/api/models" && method === "GET")
      return json(state.models)
    if (path === "/settings/api/gh/status") return json(fixture.ghStatus)
    if (path === "/settings/api/clients") return json(fixture.clients)

    // --- auth lifecycle (drive the device-code flow + sign out) ---
    if (path === "/settings/api/auth/github/start" && method === "POST") {
      setAuth(
        fixture.deviceCode ?? {
          state: "device_code_issued",
          user_code: "WXYZ-1234",
          verification_uri: "https://github.com/login/device",
          expires_at: new Date(Date.now() + 900_000).toISOString(),
        },
      )
      return json(state.auth)
    }
    if (path === "/settings/api/auth/github/sign-out" && method === "POST") {
      setAuth({ state: "unauthenticated" })
      return json({ ok: true })
    }
    if (path === "/settings/api/auth/github/cancel" && method === "POST") {
      setAuth(fixture.auth)
      return json(state.auth)
    }

    // --- apps toggles (flip enabled, echo the fresh entry) ---
    const appToggle =
      /^\/settings\/api\/apps\/(claude-code|claude-desktop|codex)\/toggle$/.exec(
        path,
      )
    if (appToggle && method === "POST") {
      const app = state.apps.apps.find((a) => a.id === appToggle[1])
      if (!app) return json({ error: { message: "no such app" } }, 404)
      app.enabled = !!(await body()).enabled
      return json(app)
    }

    // --- connectors (plugins): list, detail, change, permissions, actions ---
    if (path === "/settings/api/plugins" && method === "GET") {
      return json({ plugins: state.connectors.map(listItem) })
    }
    const pluginPath = /^\/settings\/api\/plugins\/([^/]+)$/.exec(path)
    if (pluginPath && method === "GET") {
      const connector = findConnector(decodeURIComponent(pluginPath[1]))
      if (!connector) return json({ error: { message: "no such plugin" } }, 404)
      return json(connector)
    }
    if (pluginPath && method === "PATCH") {
      const id = decodeURIComponent(pluginPath[1])
      const connector = findConnector(id)
      if (!connector) return json({ error: { message: "no such plugin" } }, 404)
      const parsed = PluginUpdateRequest.safeParse(await body())
      if (!parsed.success) {
        return invalid(parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })))
      }
      const b = parsed.data
      if (b.config) {
        const issues = configIssues(b.config)
        if (issues.length > 0) return invalid(issues)
        connector.config = b.config
        if (connector.manifest.connector && typeof b.config.endpoint === "string") {
          connector.manifest.connector.endpoint = b.config.endpoint
        }
        // A valid config restarts a connector that failed on its old one.
        if (connector.enabled && connector.lifecycle === "failed") {
          connector.lifecycle = "active"
          delete connector.error
          connector.status = workiqStatus(stages.get(id) ?? "terms-needed")
        }
      }
      if (typeof b.enabled === "boolean" && b.enabled !== connector.enabled) {
        connector.enabled = b.enabled
        delete connector.error
        if (b.enabled) {
          connector.lifecycle = "active"
          connector.status = workiqStatus(stages.get(id) ?? "terms-needed")
        } else {
          connector.lifecycle = "disabled"
          delete connector.status
        }
      }
      if (b.clients) {
        for (const client of connector.clients) client.selected = b.clients.includes(client.id)
      }
      syncTools(connector)
      pluginsChanged()
      return json(connector)
    }
    const permissionsPath = /^\/settings\/api\/plugins\/([^/]+)\/tool-permissions$/.exec(path)
    if (permissionsPath && method === "PUT") {
      const connector = findConnector(decodeURIComponent(permissionsPath[1]))
      if (!connector) return json({ error: { message: "no such plugin" } }, 404)
      const parsed = PluginToolPermissionsRequest.safeParse(await body())
      if (!parsed.success) {
        return invalid(parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })))
      }
      for (const [name, value] of Object.entries(parsed.data.permissions)) {
        const tool = connector.tools.find((t) => t.name === name)
        if (!tool) continue
        tool.permission = value ?? "allow"
        tool.permissionSource = value === null ? "default" : "user"
      }
      pluginsChanged()
      return json(connector)
    }
    const pluginAction = /^\/settings\/api\/plugins\/([^/]+)\/actions\/([^/]+)$/.exec(path)
    if (pluginAction && method === "POST") {
      const id = decodeURIComponent(pluginAction[1])
      const actionId = decodeURIComponent(pluginAction[2])
      const connector = findConnector(id)
      if (!connector) return json({ error: { message: "no such plugin" } }, 404)
      if (connector.lifecycle !== "active") {
        return json({ error: { message: "plugin is not running" } }, 409)
      }
      if (!connector.status?.actions?.some((a) => a.id === actionId)) {
        return json({ error: { message: "no such action" } }, 404)
      }
      if (actionId === "accept-terms") setStage(id, "signin-needed")
      else if (actionId === "cancel-sign-in" || actionId === "sign-out") setStage(id, "signin-needed")
      else if (actionId === "sign-in") {
        // Signing in takes a while; the outcome arrives as a status change.
        setStage(id, "working")
        setTimeout(() => {
          if (stages.get(id) === "working") setStage(id, "ready")
        }, 2500)
      }
      return json({ ok: true }, 202)
    }

    // --- Claude Code model settings ---
    if (
      path === "/settings/api/models/claude-code-auto" &&
      method === "PATCH"
    ) {
      const selection = ClaudeAutoModelsUpdateRequest.safeParse(await body())
      if (!selection.success) {
        return json({ error: { message: "invalid model selection" } }, 400)
      }
      for (const tier of ["fast", "capable", "classifier"] as const) {
        if (!(tier in selection.data)) continue
        const configured = selection.data[tier]
        if (typeof configured === "string") {
          const options =
            tier === "classifier"
              ? state.models.claude_code_auto.classifier_options
              : state.models.claude_code_auto.options
          const option = options.find(
            (candidate) => candidate.id === configured,
          )
          if (!option) {
            return json({ error: { message: "model is not available" } }, 400)
          }
          state.models.claude_code_auto[tier] = {
            configured,
            effective: configured,
            source: "maximal-override",
            status: "ready",
            reason: "override",
          }
        } else {
          state.models.claude_code_auto[tier] = structuredClone(
            fixture.models.claude_code_auto[tier],
          )
        }
      }
      return json(state.models)
    }

    // --- models refresh (just re-stamp loaded_at) ---
    if (path === "/settings/api/models/refresh" && method === "POST") {
      state.models.loaded_at = new Date().toISOString()
      return json(state.models)
    }

    // --- api-keys CRUD (mutate in-memory so the table reacts) ---
    const ks = state.apiKeys
    if (path === "/settings/api/api-keys" && method === "POST") {
      const b = await body()
      const entry = {
        id: `key_${Math.floor(performance.now())}`,
        label: b.label ?? "New key",
        key: b.key ?? `mxl_${Math.random().toString(36).slice(2, 14)}`,
        enabled: b.enabled ?? true,
        created_at: new Date().toISOString(),
      }
      ks.entries.push(entry)
      ks.enforcing = true
      return json(entry)
    }
    if (path === "/settings/api/api-keys/enforce" && method === "PATCH") {
      ks.enforcing = !!(await body()).enforcing
      return json(ks)
    }
    const keyPath = /^\/settings\/api\/api-keys\/([^/]+)$/.exec(path)
    if (keyPath && method === "DELETE") {
      ks.entries = ks.entries.filter((e) => e.id !== keyPath[1])
      ks.enforcing = ks.entries.some((e) => e.enabled)
      return new Response(null, { status: 204 })
    }
    if (keyPath && method === "PATCH") {
      const e = ks.entries.find((x) => x.id === keyPath[1])
      if (!e) return json({ error: { message: "not found" } }, 404)
      Object.assign(e, await body())
      return json(e)
    }

    // --- account switch / remove / gh-use: echo ok (no real reboot) ---
    if (
      path === "/settings/api/accounts/switch" ||
      path === "/settings/api/gh/use"
    ) {
      return json({ ok: true })
    }
    if (path === "/settings/api/accounts/remove" && method === "POST") {
      const b = await body()
      state.accounts.accounts = state.accounts.accounts.filter(
        (a) => a.key !== b.key,
      )
      return json({ ok: true })
    }

    return json(
      { error: { message: `harness: unhandled ${method} ${path}` } },
      404,
    )
  }

  return {
    scenario,
    get auth() {
      return state.auth
    },
    handle,
    onAuthChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onPluginsChange(listener) {
      pluginListeners.add(listener)
      return () => pluginListeners.delete(listener)
    },
  }
}
