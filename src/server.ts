import consola from "consola"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { BUILD_VERSION } from "./lib/build-info"
import { staleRefreshMiddleware } from "./lib/refresh-models"
import { createAuthMiddleware, requireGithubAuth } from "./lib/request-auth"
import { getModelsLoadedAtMs } from "./lib/state"
import { buildStatus } from "./lib/status"
import { traceIdMiddleware } from "./lib/trace"
import { cacheModels } from "./lib/utils"
import { completionRoutes } from "./routes/chat-completions/route"
import { debugRoutes } from "./routes/debug/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { internalRoutes } from "./routes/internal/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { providerMessageRoutes } from "./routes/provider/messages/route"
import { providerModelRoutes } from "./routes/provider/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { settingsApiRoutes } from "./routes/settings/api"
import { setupStatusRoute } from "./routes/setup-status"
import { tokenUsageRoute } from "./routes/token-usage/route"
import { tokenRoute } from "./routes/token/route"
import { uiRoutes } from "./routes/ui/route"
import { usageRoute } from "./routes/usage/route"

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
server.use(cors())
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
      "/setup-status",
    ],
    // /ui/* serves the settings + dashboard UI shells and their assets.
    // /settings/api/* are data endpoints — gated by requireAuthPrefixes.
    allowUnauthenticatedPrefixes: ["/ui"],
    requireAuthPrefixes: ["/settings/api"],
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
server.route("/setup-status", setupStatusRoute)
// `/settings/api/*` requires API-key auth (covers the new auth endpoints too).
server.route("/settings/api", settingsApiRoutes)
// `/ui/*` serves the settings + dashboard UI (embedded in prod, from
// shell/dist in dev). See src/routes/ui/route.ts.
server.route("/ui", uiRoutes)

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
server.route("/token", tokenRoute)
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
