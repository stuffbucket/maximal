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
import type { AuthStatus } from "../src/lib/config/settings-types"
import { type ResolvedScenario, type ScenarioId, resolveScenario } from "./ui-harness-fixtures"

export interface MockBackend {
  readonly scenario: ScenarioId
  /** Current auth state (what the SSE `auth.changed` frame carries). */
  readonly auth: AuthStatus
  /** Handle a request; `null` means the path isn't part of the mocked surface. */
  handle: (req: Request) => Promise<Response | null>
  /** Called whenever a mutation changes `auth`. Returns an unsubscribe. */
  onAuthChange: (listener: (auth: AuthStatus) => void) => () => void
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
    mcp: fixture.mcp,
    requests: fixture.requests,
  }) as {
    auth: AuthStatus
    apps: ResolvedScenario["apps"]
    apiKeys: ResolvedScenario["apiKeys"]
    accounts: ResolvedScenario["accounts"]
    models: ResolvedScenario["models"]
    mcp: ResolvedScenario["mcp"]
    requests: ResolvedScenario["requests"]
  }
  const listeners = new Set<(auth: AuthStatus) => void>()
  const setAuth = (next: AuthStatus): void => {
    state.auth = next
    for (const l of listeners) l(next)
  }

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url)
    const path = url.pathname
    const method = req.method
    if (!isMockedPath(path)) return null
    const body = async (): Promise<any> => req.json().catch(() => ({}))

    // --- dashboard (/usage + /token-usage + /token-usage/sessions) ---
    if (path === "/usage") return json(fixture.dashboard.usage)
    if (path === "/token-usage") return json(fixture.dashboard.tokenUsage)
    if (path === "/token-usage/sessions") {
      const delayMs = Math.max(0, Number(url.searchParams.get("delay_ms")) || 0)
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      return json(fixture.dashboard.sessions())
    }
    if (path === "/token-usage/events") {
      const pageSize = Math.max(1, Number(url.searchParams.get("page_size")) || 20)
      const events = fixture.dashboard.tokenEvents
      const totalPages = Math.max(1, Math.ceil(events.length / pageSize))
      const page = Math.min(totalPages, Math.max(1, Number(url.searchParams.get("page")) || 1))
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
    if (path === "/settings/api/update-status") return json(fixture.updateStatus)
    if (path === "/settings/api/auth/github/status") return json(state.auth)
    if (path === "/settings/api/accounts") return json(state.accounts)
    if (path === "/settings/api/api-keys" && method === "GET") return json(state.apiKeys)
    if (path === "/settings/api/apps") return json(state.apps)
    if (path === "/settings/api/models" && method === "GET") return json(state.models)
    if (path === "/settings/api/mcp" && method === "GET") return json(state.mcp)
    if (path === "/settings/api/requests" && method === "GET") return json(state.requests)
    if (path === "/settings/api/requests/summary") {
      return json({
        pending: state.requests.requests.length,
        newestId: state.requests.requests.at(-1)?.id ?? null,
      })
    }
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
    const appToggle = /^\/settings\/api\/apps\/(claude-code|claude-desktop|codex)\/toggle$/.exec(path)
    if (appToggle && method === "POST") {
      const app = state.apps.apps.find((a) => a.id === appToggle[1])
      if (!app) return json({ error: { message: "no such app" } }, 404)
      app.enabled = !!(await body()).enabled
      return json(app)
    }

    // --- mcp add (move a found catalog server into the endpoints, off) ---
    if (path === "/settings/api/mcp" && method === "POST") {
      const { catalogId } = await body()
      const item = state.mcp.available.find((a) => a.id === catalogId)
      if (!item) return json({ error: { message: "no such server" } }, 404)
      if (item.status !== "ready") return json({ error: { message: "not installed" } }, 409)
      const endpoint = {
        id: item.id,
        label: item.label,
        enabled: false,
        clients: [],
        offered: [
          { id: "claude-code" as const, name: "Claude Code", available: true, configured: false },
          { id: "claude-desktop" as const, name: "Claude Desktop", available: false, configured: false },
        ],
      }
      state.mcp.endpoints.push(endpoint)
      state.mcp.available = state.mcp.available.filter((a) => a.id !== item.id)
      return json({ endpoint })
    }

    // --- answer a waiting request (it leaves the list) ---
    const requestAnswer = /^\/settings\/api\/requests\/([^/]+)$/.exec(path)
    if (requestAnswer && method === "POST") {
      const id = decodeURIComponent(requestAnswer[1])
      const before = state.requests.requests.length
      state.requests.requests = state.requests.requests.filter((r) => r.id !== id)
      if (state.requests.requests.length === before) {
        return new Response("This request is no longer waiting", { status: 404 })
      }
      return json({ ok: true })
    }

    // --- mcp remove ---
    const mcpRemove = /^\/settings\/api\/mcp\/([^/]+)$/.exec(path)
    if (mcpRemove && method === "DELETE") {
      const id = decodeURIComponent(mcpRemove[1])
      const endpoint = state.mcp.endpoints.find((e) => e.id === id)
      if (!endpoint) return json({ error: { message: "no such endpoint" } }, 404)
      state.mcp.endpoints = state.mcp.endpoints.filter((e) => e.id !== id)
      const removedFrom = endpoint.offered
        .filter((o) => o.configured)
        .map((o) => ({ client: o.id, name: o.name }))
      return json({ removedFrom })
    }

    // --- mcp toggle (flip enabled, remember the client choice) ---
    const mcpToggle = /^\/settings\/api\/mcp\/([^/]+)$/.exec(path)
    if (mcpToggle && method === "POST") {
      const id = decodeURIComponent(mcpToggle[1])
      const endpoint = state.mcp.endpoints.find((e) => e.id === id)
      if (!endpoint) return json({ error: { message: "no such endpoint" } }, 404)
      const b = await body()
      endpoint.enabled = !!b.enabled
      if (Array.isArray(b.clients)) endpoint.clients = b.clients
      for (const offer of endpoint.offered) {
        offer.configured = endpoint.enabled && endpoint.clients.includes(offer.id) && offer.available
      }
      return json({ endpoint, skipped: [] })
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
    if (path === "/settings/api/accounts/switch" || path === "/settings/api/gh/use") {
      return json({ ok: true })
    }
    if (path === "/settings/api/accounts/remove" && method === "POST") {
      const b = await body()
      state.accounts.accounts = state.accounts.accounts.filter((a) => a.key !== b.key)
      return json({ ok: true })
    }

    return json({ error: { message: `harness: unhandled ${method} ${path}` } }, 404)
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
  }
}
