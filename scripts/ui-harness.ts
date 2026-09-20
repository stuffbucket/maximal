#!/usr/bin/env bun
/**
 * UI harness — a MOCK SIDECAR for driving the whole settings + dashboard UI
 * with no real backend.
 *
 * Why this shape (and why it's refactor-proof):
 *   The entire web UI reaches the backend through exactly one HTTP surface —
 *   `/settings/api/*` (see shell/src/proxy/client.ts) — plus the `/ui/*` static
 *   files and the SSE stream at `/settings/api/events`. This server reproduces
 *   THAT surface and serves the REAL built UI from shell/dist/ui/* unchanged.
 *   The UI cannot tell this mock from the production sidecar, so:
 *     • no UI source is modified — components/markup can be refactored freely;
 *     • the harness only needs updating if the WIRE CONTRACT changes (a new
 *       endpoint or a changed schema) — exactly the thing you'd want to notice.
 *
 * Fixtures are validated against the real Zod schemas in
 * src/lib/settings-types.ts at startup, so a fixture that drifts from the
 * contract fails loudly here rather than rendering a lie in the UI.
 *
 * SCENARIOS let you observe states that are hard to reproduce against a live
 * sidecar (no Claude Code installed, an upstream-rejection banner, a pending
 * device code, error states). Switch them live from the floating overlay the
 * server injects into the page — no rebuild, no backend poking.
 *
 * Usage:
 *   bun run build:ui                 # build the real UI once (or use --watch)
 *   bun scripts/ui-harness.ts        # serve at http://127.0.0.1:4747
 *   open http://127.0.0.1:4747/ui/settings/   (and /ui/dashboard/)
 *
 * Flags:
 *   --port <n>     listen port (default 4747)
 *   --scenario <s> initial scenario id (default "signed-in")
 *
 * Isolation — runs SIDE-BY-SIDE with a real maximal, zero interference:
 *   • Binds 127.0.0.1 only (loopback) — not reachable off-box, never `*`.
 *   • Default port 4747 deliberately avoids maximal's 4141, the OTLP
 *     4317/4318, and macOS Control Center's 5000/7000. It NEVER touches 4141.
 *   • Pure in-memory mock: reads the built UI from shell/dist/ui and serves
 *     fixtures. It writes no files and touches none of maximal's config, token
 *     store, or state. Stopping/forking it can't affect a running proxy.
 *   • If its own port is busy it EXITS with a message — it never evicts the
 *     listener (unlike maximal's `--replace`), so it can't knock over anything.
 */
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

import {
  AccountsListResponse,
  ApiKeysListResponse,
  AppsListResponse,
  AuthStatus,
  DiagnosticsResponse,
  ModelsListResponse,
  UpdateStatusResponse,
} from "../src/lib/config/settings-types"
import { SCENARIOS, type ScenarioId, defaultScenarioId } from "./ui-harness-fixtures"

const REPO = resolve(import.meta.dir, "..")
const DIST = join(REPO, "shell/dist/ui")

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2)
const portArg = argv.indexOf("--port")
const PORT = portArg !== -1 ? Number(argv[portArg + 1]) : 4747
const scenArg = argv.indexOf("--scenario")
let activeScenario: ScenarioId =
  scenArg !== -1 && argv[scenArg + 1] in SCENARIOS ?
    (argv[scenArg + 1] as ScenarioId)
  : defaultScenarioId

if (!existsSync(join(DIST, "settings", "index.html"))) {
  console.error(
    "✗ Built UI not found at shell/dist/ui. Run `bun run build:ui` first " +
      "(or `bun run build:ui --watch` in another terminal).",
  )
  process.exit(1)
}

// ---- startup contract check: every fixture must satisfy the real schema ----
// This is the refactor-proof guarantee: if a settings-types schema changes in a
// way a fixture doesn't meet, the harness refuses to start and names the gap.
function assertFixtures(): void {
  const checks: Array<[string, { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, (s: keyof typeof SCENARIOS) => unknown]> =
    [
      ["diagnostics", DiagnosticsResponse, (s) => SCENARIOS[s].diagnostics],
      ["update-status", UpdateStatusResponse, (s) => SCENARIOS[s].updateStatus],
      ["auth-status", AuthStatus, (s) => SCENARIOS[s].auth],
      ["accounts", AccountsListResponse, (s) => SCENARIOS[s].accounts],
      ["api-keys", ApiKeysListResponse, (s) => SCENARIOS[s].apiKeys],
      ["apps", AppsListResponse, (s) => SCENARIOS[s].apps],
      ["models", ModelsListResponse, (s) => SCENARIOS[s].models],
    ]
  let failures = 0
  for (const id of Object.keys(SCENARIOS) as Array<keyof typeof SCENARIOS>) {
    for (const [name, schema, pick] of checks) {
      const parsed = schema.safeParse(pick(id))
      if (!parsed.success) {
        failures++
        console.error(`✗ fixture [${String(id)}].${name} fails schema:`)
        console.error(JSON.stringify(parsed.error, null, 2))
      }
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} fixture(s) violate the wire contract. Fix ui-harness-fixtures.ts.`)
    process.exit(1)
  }
}
assertFixtures()

// ---- per-run mutable state, seeded from the active scenario ----------------
// Mutations (toggles, key create/delete) update this so the UI reacts like the
// real thing within a session. Switching scenarios reseeds.
function seed(): {
  auth: unknown
  apps: unknown
  apiKeys: unknown
  accounts: unknown
  models: unknown
} {
  const s = SCENARIOS[activeScenario]
  return structuredClone({
    auth: s.auth,
    apps: s.apps,
    apiKeys: s.apiKeys,
    accounts: s.accounts,
    models: s.models,
  })
}
let state = seed()

// ---- SSE subscribers (auth.changed parity with src/routes/settings/events) -
const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
const enc = new TextEncoder()
function broadcastAuth(): void {
  const frame = enc.encode(
    `event: auth.changed\ndata: ${JSON.stringify(state.auth)}\n\n`,
  )
  for (const c of sseClients) {
    try {
      c.enqueue(frame)
    } catch {
      // client gone; the cancel handler prunes it
    }
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

// ---- the overlay injected into served HTML (scenario switcher) -------------
// Kept inline + dependency-free so it survives any UI refactor. It talks to the
// harness-only /__harness/* control endpoints, never to the app's own surface.
function overlayScript(): string {
  const opts = (Object.keys(SCENARIOS) as Array<ScenarioId>)
    .map(
      (id) =>
        `<option value="${id}"${id === activeScenario ? " selected" : ""}>${SCENARIOS[id].label}</option>`,
    )
    .join("")
  return `
<div id="__harness" style="position:fixed;z-index:99999;right:12px;bottom:12px;
  font:12px/1.4 ui-sans-serif,system-ui;background:#1b1b1f;color:#fafafa;
  border:1px solid #444;border-radius:10px;padding:10px 12px;box-shadow:0 6px 24px #0008;opacity:.95">
  <div style="font-weight:700;margin-bottom:6px;letter-spacing:.02em">⚗ UI harness — mock backend</div>
  <label style="display:flex;gap:8px;align-items:center">
    <span style="opacity:.7">Scenario</span>
    <select id="__harness-scn" style="background:#26262b;color:#fafafa;border:1px solid #555;border-radius:6px;padding:3px 6px">${opts}</select>
  </label>
</div>
<script>
(function(){
  var sel=document.getElementById('__harness-scn');
  sel.addEventListener('change',function(){
    fetch('/__harness/scenario',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({id:sel.value})}).then(function(){location.reload()});
  });
})();
</script>`
}

// ---- static UI serving (parity with src/routes/ui/route.ts, disk mode) -----
function safeJoin(root: string, urlPath: string): string | null {
  const cleaned = urlPath.replace(/^\/+/, "")
  if (cleaned.includes("..")) return null
  const full = resolve(root, cleaned)
  return full.startsWith(resolve(root)) ? full : null
}

async function serveUi(urlPath: string): Promise<Response> {
  // /ui/settings/ and /ui/dashboard/ → their index.html (with overlay injected)
  let rel = urlPath.replace(/^\/ui\//, "")
  if (rel === "" || rel.endsWith("/")) rel += "index.html"
  const full = safeJoin(DIST, rel)
  if (!full || !existsSync(full)) return new Response("Not found", { status: 404 })
  const file = Bun.file(full)
  if (full.endsWith("index.html")) {
    const html = await file.text()
    const injected = html.replace(/<\/body>/i, `${overlayScript()}</body>`)
    return new Response(injected, { headers: { "content-type": "text/html; charset=utf-8" } })
  }
  return new Response(file)
}

// ---- the mock API surface --------------------------------------------------
async function handleApi(req: Request, path: string): Promise<Response> {
  const method = req.method
  const body = async (): Promise<any> => req.json().catch(() => ({}))

  // --- reads ---
  if (path === "/settings/api/diagnostics") return json(SCENARIOS[activeScenario].diagnostics)
  if (path === "/settings/api/update-status") return json(SCENARIOS[activeScenario].updateStatus)
  if (path === "/settings/api/auth/github/status") return json(state.auth)
  if (path === "/settings/api/accounts") return json(state.accounts)
  if (path === "/settings/api/api-keys" && method === "GET") return json(state.apiKeys)
  if (path === "/settings/api/apps") return json(state.apps)
  if (path === "/settings/api/models" && method === "GET") return json(state.models)
  if (path === "/settings/api/gh/status") return json(SCENARIOS[activeScenario].ghStatus)
  if (path.startsWith("/settings/api/clients")) return json({ clients: [] })

  // --- auth lifecycle (drive the device-code flow + sign out) ---
  if (path === "/settings/api/auth/github/start" && method === "POST") {
    state.auth = SCENARIOS[activeScenario].deviceCode ?? {
      state: "device_code_issued",
      user_code: "WXYZ-1234",
      verification_uri: "https://github.com/login/device",
      expires_at: new Date(Date.now() + 900_000).toISOString(),
    }
    broadcastAuth()
    return json(state.auth)
  }
  if (path === "/settings/api/auth/github/sign-out" && method === "POST") {
    state.auth = { state: "unauthenticated" }
    broadcastAuth()
    return json({ ok: true })
  }
  if (path === "/settings/api/auth/github/cancel" && method === "POST") {
    state.auth = SCENARIOS[activeScenario].auth
    broadcastAuth()
    return json(state.auth)
  }

  // --- apps toggles (flip enabled, echo the fresh entry) ---
  if (path === "/settings/api/apps/claude-code/toggle" && method === "POST") {
    return toggleApp("claude-code", (await body()).enabled)
  }
  if (path === "/settings/api/apps/claude-desktop/toggle" && method === "POST") {
    return toggleApp("claude-desktop", (await body()).enabled)
  }

  // --- models refresh (just re-stamp loaded_at) ---
  if (path === "/settings/api/models/refresh" && method === "POST") {
    ;(state.models as any).loaded_at = new Date().toISOString()
    return json(state.models)
  }

  // --- api-keys CRUD (mutate in-memory so the table reacts) ---
  if (path === "/settings/api/api-keys" && method === "POST") {
    const b = await body()
    const entry = {
      id: `key_${Math.floor(performance.now())}`,
      label: b.label ?? "New key",
      key: b.key ?? `mxl_${Math.random().toString(36).slice(2, 14)}`,
      enabled: b.enabled ?? true,
      created_at: new Date().toISOString(),
    }
    ;(state.apiKeys as any).entries.push(entry)
    ;(state.apiKeys as any).enforcing = true
    return json(entry)
  }
  if (path.startsWith("/settings/api/api-keys/") && path.endsWith("/enforce") === false && method === "DELETE") {
    const id = path.split("/").pop()
    const ks = state.apiKeys as any
    ks.entries = ks.entries.filter((e: any) => e.id !== id)
    ks.enforcing = ks.entries.some((e: any) => e.enabled)
    return new Response(null, { status: 204 })
  }
  if (path.startsWith("/settings/api/api-keys/") && method === "PATCH" && path.endsWith("/enforce") === false) {
    const id = path.split("/").pop()
    const b = await body()
    const ks = state.apiKeys as any
    const e = ks.entries.find((x: any) => x.id === id)
    if (e) Object.assign(e, b)
    return json(e ?? { error: { message: "not found" } }, e ? 200 : 404)
  }
  if (path === "/settings/api/api-keys/enforce" && method === "PATCH") {
    const b = await body()
    ;(state.apiKeys as any).enforcing = !!b.enforcing
    return json(state.apiKeys)
  }

  // --- account switch / remove / gh-use: echo authenticated (no real reboot) -
  if (
    path === "/settings/api/accounts/switch" ||
    path === "/settings/api/gh/use"
  ) {
    return json({ ok: true })
  }
  if (path === "/settings/api/accounts/remove" && method === "POST") {
    const b = await body()
    const acc = state.accounts as any
    acc.accounts = acc.accounts.filter((a: any) => a.key !== b.key)
    return json({ ok: true })
  }

  return json({ error: { message: `harness: unhandled ${method} ${path}` } }, 404)
}

function toggleApp(id: string, enabled: boolean): Response {
  const apps = (state.apps as any).apps as Array<any>
  const app = apps.find((a) => a.id === id)
  if (!app) return json({ error: { message: "no such app" } }, 404)
  app.enabled = enabled
  return json(app)
}

// ---- SSE ------------------------------------------------------------------
function serveEvents(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sseClients.add(controller)
      controller.enqueue(enc.encode(": connected\n\n"))
      controller.enqueue(
        enc.encode(`event: auth.changed\ndata: ${JSON.stringify(state.auth)}\n\n`),
      )
    },
    cancel() {
      // controller is invalid here; prune by sweeping closed ones lazily
    },
  })
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  })
}

// ---- server ----------------------------------------------------------------
// Guardrail: never bind maximal's proxy port. Even with --port, refuse 4141 so
// the harness can't be pointed at (and collide with) a real sidecar.
if (PORT === 4141) {
  console.error(
    "✗ Refusing to bind port 4141 — that's maximal's proxy port. " +
      "Pick another (the default 4747 runs safely alongside maximal).",
  )
  process.exit(1)
}

function serve(): ReturnType<typeof Bun.serve> {
  try {
    return Bun.serve({
      port: PORT,
      // Loopback only — never reachable off-box, and never the `*:` wildcard a
      // real service would use. This is a dev mock, not a server.
      hostname: "127.0.0.1",
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const path = url.pathname

        // harness control plane
        if (path === "/__harness/scenario" && req.method === "POST") {
          const b = await req.json().catch(() => ({}))
          if (b.id in SCENARIOS) {
            activeScenario = b.id as ScenarioId
            state = seed()
            broadcastAuth()
          }
          return json({ ok: true, active: activeScenario })
        }
        if (path === "/__harness/scenarios") {
          return json({
            active: activeScenario,
            scenarios: Object.fromEntries(
              (Object.keys(SCENARIOS) as Array<ScenarioId>).map((id) => [id, SCENARIOS[id].label]),
            ),
          })
        }

        if (path === "/settings/api/events") return serveEvents()
        if (path.startsWith("/settings/api/")) return handleApi(req, path)
        if (path.startsWith("/ui/")) return serveUi(path)
        if (path === "/") return Response.redirect("/ui/settings/", 302)
        return new Response("Not found", { status: 404 })
      },
    })
  } catch (err) {
    // Port busy (EADDRINUSE) or similar — exit cleanly. We deliberately do NOT
    // evict the listener (maximal has --replace logic that does; a dev harness
    // must never knock over whatever is already there).
    const msg = err instanceof Error ? err.message : String(err)
    console.error(
      `✗ Couldn't bind 127.0.0.1:${PORT} (${msg}).\n` +
        `  Something is already using it. Re-run with --port <n> to pick another.`,
    )
    process.exit(1)
  }
}

serve()

console.error(
  `\n⚗  UI harness (mock sidecar) on http://127.0.0.1:${PORT}\n` +
    `   settings  → http://127.0.0.1:${PORT}/ui/settings/\n` +
    `   dashboard → http://127.0.0.1:${PORT}/ui/dashboard/\n` +
    `   scenario  → "${activeScenario}" (switch live from the ⚗ overlay)\n` +
    `   no backend touched; fixtures validated against settings-types.ts\n`,
)
