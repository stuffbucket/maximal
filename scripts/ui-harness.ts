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
 *   --check        validate the fixtures against the schemas and exit
 *                  (no built UI or server needed; `bun run storybook:check`)
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
  McpEndpointsListResponse,
  ModelsListResponse,
  UpdateStatusResponse,
} from "../src/lib/config/settings-types"
import { type MockBackend, createMockBackend } from "./ui-harness-api"
import {
  type ResolvedScenario,
  SCENARIOS,
  type ScenarioId,
  defaultScenarioId,
  resolveScenario,
} from "./ui-harness-fixtures"

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

// ---- startup contract check: every fixture must satisfy the real schema ----
// This is the refactor-proof guarantee: if a settings-types schema changes in a
// way a fixture doesn't meet, the harness refuses to start and names the gap.
function assertFixtures(): void {
  const checks: Array<[string, { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, (s: ResolvedScenario) => unknown]> =
    [
      ["diagnostics", DiagnosticsResponse, (s) => s.diagnostics],
      ["update-status", UpdateStatusResponse, (s) => s.updateStatus],
      ["auth-status", AuthStatus, (s) => s.auth],
      ["accounts", AccountsListResponse, (s) => s.accounts],
      ["api-keys", ApiKeysListResponse, (s) => s.apiKeys],
      ["apps", AppsListResponse, (s) => s.apps],
      ["models", ModelsListResponse, (s) => s.models],
      ["mcp", McpEndpointsListResponse, (s) => s.mcp],
    ]
  let failures = 0
  for (const id of Object.keys(SCENARIOS) as Array<ScenarioId>) {
    const resolved = resolveScenario(id)
    for (const [name, schema, pick] of checks) {
      const parsed = schema.safeParse(pick(resolved))
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

// --check: the contract check alone (no built UI needed, no server).
if (argv.includes("--check")) {
  console.error(`✓ ${Object.keys(SCENARIOS).length} scenarios match the wire contract`)
  process.exit(0)
}

if (!existsSync(join(DIST, "settings", "index.html"))) {
  console.error(
    "✗ Built UI not found at shell/dist/ui. Run `bun run build:ui` first " +
      "(or `bun run build:ui --watch` in another terminal).",
  )
  process.exit(1)
}

// ---- per-run mock backend, seeded from the active scenario ----------------
// Mutations (toggles, key create/delete) update the backend's own state so the
// UI reacts like the real thing within a session. Switching scenarios reseeds.
// The request handling itself lives in ui-harness-api.ts, shared with the
// Storybook package's in-browser fetch mock.
let backend: MockBackend = createMockBackend(activeScenario)

// ---- SSE subscribers (auth.changed parity with src/routes/settings/events) -
const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
const enc = new TextEncoder()
function broadcastAuth(): void {
  const frame = enc.encode(
    `event: auth.changed\ndata: ${JSON.stringify(backend.auth)}\n\n`,
  )
  for (const c of sseClients) {
    try {
      c.enqueue(frame)
    } catch {
      // client gone; the cancel handler prunes it
    }
  }
}
backend.onAuthChange(broadcastAuth)

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

// ---- SSE ------------------------------------------------------------------
function serveEvents(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sseClients.add(controller)
      controller.enqueue(enc.encode(": connected\n\n"))
      controller.enqueue(
        enc.encode(`event: auth.changed\ndata: ${JSON.stringify(backend.auth)}\n\n`),
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
            backend = createMockBackend(activeScenario)
            backend.onAuthChange(broadcastAuth)
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
        const mocked = await backend.handle(req)
        if (mocked) return mocked
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
