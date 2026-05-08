import consola from "consola"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { staleRefreshMiddleware } from "./lib/refresh-models"
import { createAuthMiddleware } from "./lib/request-auth"
import { getModelsLoadedAtMs } from "./lib/state"
import { traceIdMiddleware } from "./lib/trace"
import { cacheModels } from "./lib/utils"
import { completionRoutes } from "./routes/chat-completions/route"
import { debugRoutes } from "./routes/debug/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { providerMessageRoutes } from "./routes/provider/messages/route"
import { providerModelRoutes } from "./routes/provider/models/route"
import { responsesRoutes } from "./routes/responses/route"
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
      "/_debug/state",
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
server.get("/usage-viewer", async (c) => {
  // Bun's `--compile` output embeds files referenced via
  // import.meta.url-relative URLs but only `Bun.file()` knows how to
  // read them through the virtual filesystem on every platform.
  // `readFileSync` against the same URL works in dev and on macOS
  // builds but 500'd on Windows (`B:\~BUN\root\pages\usage-viewer.html`,
  // ENOENT). Same code path covers both runtimes here.
  const usageViewerFileUrl = new URL(
    "./pages/usage-viewer.html",
    import.meta.url,
  )
  return c.html(await Bun.file(usageViewerFileUrl).text())
})
server.get("/usage-viewer/", (c) => c.redirect("/usage-viewer", 301))

server.route("/_debug", debugRoutes)
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
