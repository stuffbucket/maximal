import consola from "consola"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { staleRefreshMiddleware } from "./lib/refresh-models"
import { createAuthMiddleware, requireGithubAuth } from "./lib/request-auth"
import { getModelsLoadedAtMs } from "./lib/state"
import { traceIdMiddleware } from "./lib/trace"
import { cacheModels } from "./lib/utils"
// `with { type: "file" }` is Bun's official asset-embedding path
// for `--compile` output. The import resolves to a real path in dev
// (`/abs/.../usage-viewer.html`) and to a virtual `$bunfs/...` path
// inside the compiled binary; Bun.file() reads both. Survives every
// platform — including Windows, which broke our previous
// readFileSync(URL) attempt with `B:\~BUN\root\...` ENOENTs.
// https://bun.com/docs/bundler/executables
//
// The TS cast is needed because Bun's default loader for *.html is
// `html` (returns an HTMLBundle), and TypeScript's import-attribute
// support doesn't yet thread through the `type: "file"` override
// to the resolved module type. The runtime is fine — it honors the
// attribute regardless.
import usageViewerImport from "./pages/usage-viewer.html" with { type: "file" }
const usageViewerPath = usageViewerImport as unknown as string
import usageViewerCssImport from "./pages/usage-viewer.css" with { type: "file" }
const usageViewerCssPath = usageViewerCssImport
import usageViewerJsImport from "./pages/usage-viewer.js" with { type: "file" }
const usageViewerJsPath = usageViewerJsImport as unknown as string
import lucideVendorImport from "./pages/vendor/lucide.min.js" with { type: "file" }
const lucideVendorPath = lucideVendorImport as unknown as string
import tailwindVendorImport from "./pages/vendor/tailwind.min.js" with { type: "file" }
const tailwindVendorPath = tailwindVendorImport as unknown as string
import { completionRoutes } from "./routes/chat-completions/route"
import { debugRoutes } from "./routes/debug/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { providerMessageRoutes } from "./routes/provider/messages/route"
import { providerModelRoutes } from "./routes/provider/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { settingsApiRoutes } from "./routes/settings/api"
import { settingsRoutes } from "./routes/settings/route"
import { setupStatusRoute } from "./routes/setup-status"
import { tokenUsageRoute } from "./routes/token-usage/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(traceIdMiddleware)
server.use(logger())
server.use(cors())
server.use(
  "*",
  createAuthMiddleware({
    allowUnauthenticatedPaths: [
      "/",
      "/usage-viewer",
      "/usage-viewer/",
      "/usage-viewer.css",
      "/usage-viewer.js",
      "/vendor/lucide.min.js",
      "/vendor/tailwind.min.js",
      "/_debug/state",
      "/setup-status",
    ],
    // /settings serves the UI shell + bundled assets (HTML/JS/CSS).
    // /settings/api/* are data endpoints — gated by requireAuthPrefixes.
    allowUnauthenticatedPrefixes: ["/settings"],
    requireAuthPrefixes: ["/settings/api"],
    // The dashboard at /usage-viewer fetches these endpoints from the
    // same machine. Trusting loopback lets us drop the client-side API
    // key UI (and its clear-text storage) without exposing the same
    // endpoints to remote callers, who still need a valid API key.
    loopbackOnlyPaths: ["/usage", "/token-usage", "/token-usage/events"],
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
server.get("/usage-viewer", async (c) =>
  c.html(await Bun.file(usageViewerPath).text()),
)
server.get("/usage-viewer/", (c) => c.redirect("/usage-viewer", 301))

// Sibling assets for the dashboard — extracted from the HTML to keep
// each file single-concern. Bun's `with { type: "file" }` embeds them
// in the compiled binary the same way it embeds the vendor scripts.
const CSS_HEADERS = {
  "content-type": "text/css; charset=utf-8",
  "cache-control": "public, max-age=86400",
} as const
const JS_HEADERS = {
  "content-type": "application/javascript; charset=utf-8",
  "cache-control": "public, max-age=86400",
} as const
server.get("/usage-viewer.css", async (c) =>
  c.body(await Bun.file(usageViewerCssPath).bytes(), 200, CSS_HEADERS),
)
server.get("/usage-viewer.js", async (c) =>
  c.body(await Bun.file(usageViewerJsPath).bytes(), 200, JS_HEADERS),
)

// Vendored third-party assets for the dashboard. Inlined as a small
// allowlist rather than a wildcard static handler to keep the surface
// area minimal and avoid path-traversal concerns. Both are pinned
// versions checked into the repo under `src/pages/vendor/`.
server.get("/vendor/lucide.min.js", async (c) =>
  c.body(await Bun.file(lucideVendorPath).bytes(), 200, JS_HEADERS),
)
server.get("/vendor/tailwind.min.js", async (c) =>
  c.body(await Bun.file(tailwindVendorPath).bytes(), 200, JS_HEADERS),
)

server.route("/_debug", debugRoutes)
server.route("/setup-status", setupStatusRoute)
// `/settings/api/*` requires API-key auth (covers the new auth endpoints too).
// `/settings/*` static bundle inherits whatever its route handler enforces.
server.route("/settings/api", settingsApiRoutes)
server.route("/settings", settingsRoutes)

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
