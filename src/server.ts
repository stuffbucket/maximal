import consola from "consola"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import {
  buildCorsOptions,
  createOriginGuardMiddleware,
  MANDATORY_AUTH_PREFIX,
} from "./lib/auth/origin-guard"
import {
  createAuthMiddleware,
  requireGithubAuth,
} from "./lib/auth/request-auth"
import { traceIdMiddleware } from "./lib/http/trace"
import { staleRefreshMiddleware } from "./lib/models/refresh-models"
import { cacheModels } from "./lib/platform/utils"
import { getModelsLoadedAtMs, state } from "./lib/runtime-state/state"
import { buildStatus } from "./lib/runtime-state/status"
import { BUILD_VERSION } from "./lib/update/build-info"
import { completionRoutes } from "./routes/chat-completions/route"
import { debugRoutes } from "./routes/debug/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { internalRoutes } from "./routes/internal/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { productApiRoutes } from "./routes/product-api"
import { providerMessageRoutes } from "./routes/provider/messages/route"
import { providerModelRoutes } from "./routes/provider/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { settingsApiRoutes } from "./routes/settings/api"
import { tokenUsageRoute } from "./routes/token-usage/route"
import { uiRoutes } from "./routes/ui/route"
import { usageRoute } from "./routes/usage/route"
import { createWsRoutes, WS_PATH } from "./routes/ws/route"

export const server = new Hono()

/** Captured at module load — anchors the `/status` uptime to "when the
 *  server module first ran," which is what callers mean by "how long has
 *  Maximal been up." */
const SERVER_START_MS = Date.now()

server.use(traceIdMiddleware)
// Stamp the proxy build version on every response so downstream clients
// can read which Maximal build served their request without hitting a
// separate endpoint. Global (right after trace) means it lands on
// completion responses, /status, /settings/api/*, redirects, and errors
// alike. Value is a static build constant — no per-request cost, no
// secrets. Set before next() so it applies to c.res on the way out.
server.use(async (c, next) => {
  c.header("x-maximal-version", BUILD_VERSION)
  await next()
})
server.use(logger())
// Control-surface hardening (§6, ADR-0021). `boundPort` is read lazily per
// request — `runServer` sets `state.boundPort` from the resolved `--port` before
// it binds, and in-memory tests fall back to the 4141 default.
const boundPort = (): number => state.boundPort
// CORS narrowed from `*` to a localhost allowlist. The OPTIONS preflight is the
// load-bearing case (auth bypasses OPTIONS), so a `*` here would let any origin
// preflight-probe the control surface.
server.use(cors(buildCorsOptions(boundPort)))
// Reject any present, non-localhost `Origin` on the control prefixes
// (`/settings/api`, `/_internal`, `/_debug/state`) — including `/_internal/shutdown`.
// A missing Origin passes (the CLI/plugin/SDK invariant, §6.6). Mounted before
// auth so a cross-origin browser request is refused regardless of any key.
server.use(createOriginGuardMiddleware({ boundPort }))
server.use(
  "*",
  createAuthMiddleware({
    allowUnauthenticatedPaths: [
      "/",
      "/status",
      // Bare-surface redirects to the canonical /ui/* paths.
      "/usage-viewer",
      "/settings",
      "/settings/",
      "/_debug/state",
      // The read-only, secret-redacting diagnostics endpoint (§1.7): the data
      // behind the "open in any browser" diagnostics page, deliberately
      // unauthenticated (§6.5). GET-only and CSRF-safe via the Origin guard
      // above, so it is exempt from the /settings/api mandatory-auth prefix.
      "/settings/api/diagnostics",
      "/setup-status",
      // The live-feed WebSocket handshake (§1.3). It is Origin-gated (a
      // cross-origin browser WS is 403'd by the guard above) and the route
      // itself requires the minted `?key=` session token — so it is exempt
      // from the API-key middleware here, not unprotected.
      WS_PATH,
      // The product-API OpenAPI document is a public spec (no secrets),
      // served alongside the fresh-install `/setup-status` surface.
      "/openapi.json",
    ],
    // /ui/* serves the settings + dashboard UI shells and their assets.
    // /settings/api/* are data endpoints — gated by requireAuthPrefixes.
    allowUnauthenticatedPrefixes: ["/ui"],
    requireAuthPrefixes: ["/settings/api"],
    // §6.2: /settings/api stays auth-mandatory even when the user-facing
    // `enforce` toggle is off — a local browser page must not be able to drive
    // the control surface key-less. The shell-key bypass keeps the Settings UI
    // working. One auth decision, not a parallel gate (see origin-guard.ts).
    alwaysEnforcePrefixes: [MANDATORY_AUTH_PREFIX],
    // The dashboard at /ui/dashboard fetches these endpoints from the
    // same machine. Trusting loopback lets us drop the client-side API
    // key UI (and its clear-text storage) without exposing the same
    // endpoints to remote callers, who still need a valid API key.
    loopbackOnlyPaths: [
      "/usage",
      "/token-usage",
      "/token-usage/events",
      // Shutdown endpoint is loopback-gated. The route handler itself
      // *also* enforces loopback (a remote caller with a valid API key
      // must NOT be able to evict the running instance), but listing
      // it here means we skip the auth dance for the local caller.
      "/_internal/shutdown",
      // Tray-open (§1.2): the native shell POSTs this on a tray click — a
      // local, keyless caller. Same posture as shutdown (the route re-checks
      // loopback + it's Origin-gated), so skip auth for the loopback caller,
      // else dedup would break when "block unknown connections" is on.
      "/_internal/tray-open",
    ],
  }),
)

// L1a model-cache lazy refresh. Runs after auth so unauthenticated
// probes ("/", "/usage-viewer") don't count as activity. Fire-and-
// forget; the triggering request continues with the slightly stale
// cache. See docs/spec/model-protocol-strategy.md.
server.use(
  "*",
  staleRefreshMiddleware({
    getLoadedAtMs: getModelsLoadedAtMs,
    refresh: cacheModels,
    onError: (err) =>
      consola.warn(
        "Background models refresh failed; keeping stale cache",
        err,
      ),
  }),
)

server.get("/", (c) => c.text("Server running"))

// Identity + liveness probe. Unauthenticated and loopback-friendly so a
// local caller (the Claude Code shim, a health check, a script) can ask
// "is the thing on :4141 actually Maximal, is it up, and is it ready to
// serve?" without an API key. The `service: "maximal"` field is the
// unambiguous identity marker the shim keys off; `subsystems` namespaces
// per-part health so new subsystems slot in without reshaping the
// contract. Safe-for-unauth only (booleans/tiers/counts, no secrets);
// see src/lib/status.ts. Cheap: in-memory state, no upstream calls.
server.get("/status", (c) => c.json(buildStatus(SERVER_START_MS)))
// Legacy redirects → canonical /ui/* surfaces. Kept so existing links
// (Claude config, boot banner, bookmarks, the Tauri shell pre-upgrade)
// keep working. The dashboard preserves its `?endpoint=…` query.
server.get("/usage-viewer", (c) => {
  const qs = new URL(c.req.url).search
  return c.redirect(`/ui/dashboard/${qs}`, 301)
})
server.get("/usage-viewer/", (c) => {
  const qs = new URL(c.req.url).search
  return c.redirect(`/ui/dashboard/${qs}`, 301)
})
server.get("/settings", (c) => c.redirect("/ui/settings/", 301))
server.get("/settings/", (c) => c.redirect("/ui/settings/", 301))

server.route("/_debug", debugRoutes)
server.route("/_internal", internalRoutes)
// The maximal-specific product API surface: `/setup-status` plus its
// route-bound OpenAPI document at `/openapi.json`. See routes/product-api.ts.
server.route("/", productApiRoutes)
// `/settings/api/*` requires API-key auth (covers the new auth endpoints too).
server.route("/settings/api", settingsApiRoutes)
// `/ui/*` serves the settings + dashboard UI (embedded in prod, from
// shell/dist in dev). See src/routes/ui/route.ts.
server.route("/ui", uiRoutes)

// `/ws` — the unified live-feed WebSocket (§1.3). This mounts the HTTP GET that
// performs the Bun upgrade; the socket callbacks (presence + feed) are the
// `websocket` handler passed to `serve({ bun: { websocket } })` in run-server.ts.
// Origin-gated + `?key=`-scoped (see the allowlist note above).
server.route(WS_PATH, createWsRoutes())

// Gate every upstream-touching route on the presence of a GitHub token.
// When the sidecar boots without one, the HTTP server still listens (so
// the Tauri shell can load Settings and trigger auth on demand) but the
// proxy endpoints 401 with `not_authenticated` instead of crashing or
// firing the device-code flow.
server.use("/chat/completions", requireGithubAuth)
server.use("/chat/completions/*", requireGithubAuth)
server.use("/models", requireGithubAuth)
server.use("/models/*", requireGithubAuth)
server.use("/embeddings", requireGithubAuth)
server.use("/embeddings/*", requireGithubAuth)
server.use("/responses", requireGithubAuth)
server.use("/responses/*", requireGithubAuth)
server.use("/v1/*", requireGithubAuth)
server.use("/:provider/v1/*", requireGithubAuth)

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token-usage", tokenUsageRoute)
server.route("/responses", responsesRoutes)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/responses", responsesRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)

// Provider scoped Anthropic-compatible endpoints
server.route("/:provider/v1/messages", providerMessageRoutes)
server.route("/:provider/v1/models", providerModelRoutes)
