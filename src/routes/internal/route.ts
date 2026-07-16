/**
 * /_internal/* — process-control endpoints meant for the local machine
 * only.
 *
 * Currently this exposes a single endpoint: `POST /_internal/shutdown`.
 * It's the graceful-eviction hook that a *second* `maximal start
 * --replace` invocation calls to ask the running instance to release
 * `:4141` cleanly.
 *
 * Loopback enforcement is non-negotiable here. The auth middleware in
 * `server.ts` already exempts loopback callers from API-key checks (via
 * `loopbackOnlyPaths`), but that only relaxes auth — it doesn't *block*
 * remote callers with a valid key. So this handler does the strict
 * check itself: non-loopback requests get a 404 (indistinguishable from
 * a missing route to a remote scanner).
 */

import type { Context } from "hono"

import consola from "consola"
import { Hono } from "hono"

import { defaultGetRequestIp, isLoopbackAddress } from "~/lib/auth/request-auth"
import { requestContext } from "~/lib/http/request-context"
import { emitQuitRequest } from "~/lib/start/boot-status"
import {
  orchestrateTrayOpen,
  presenceRegistry,
  type PresenceRegistry,
} from "~/lib/ws/presence-registry"

interface InternalRoutesOptions {
  /** Injectable for tests so we don't actually exit the runner. */
  exit?: (code: number) => void
  /** Injectable so tests can simulate non-loopback requests. */
  getRequestIp?: (c: Context) => string | null
  /** Injectable presence registry for the tray-open decision (default: singleton). */
  registry?: PresenceRegistry
  /** Injectable quit-request emitter (default: signals the shell over stdout). */
  requestQuit?: () => boolean
}

export function createInternalRoutes(
  options: InternalRoutesOptions = {},
): Hono {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const getRequestIp = options.getRequestIp ?? defaultGetRequestIp
  const registry = options.registry ?? presenceRegistry
  const requestQuit = options.requestQuit ?? emitQuitRequest

  const app = new Hono()

  // The browser-tab UI's quit path (§1.6): a tab has no Tauri host to `invoke`
  // a quit, so it POSTs here and the sidecar signals the supervising shell to
  // quit the whole app. Loopback-only + Origin-gated (server.ts) — a
  // cross-origin page can't reach it. Returns 202 when a shell is listening,
  // 409 for a plain-CLI run (nothing to quit).
  app.post("/quit", (c) => {
    if (!isLoopbackAddress(getRequestIp(c))) {
      return c.notFound()
    }
    if (!requestQuit()) {
      return c.json({ ok: false, reason: "no_supervising_shell" }, 409)
    }
    return c.json({ ok: true, quitting: true }, 202)
  })

  // The native tray click routes here (§1.2): the sidecar owns the browser tab
  // set, so it runs the single-tab decision — close buried tab(s) over the WS,
  // and tell the shell whether to open one fresh foreground tab. Loopback-only
  // (the shell is local) + Origin-gated in server.ts; a remote caller gets 404.
  app.post("/tray-open", (c) => {
    if (!isLoopbackAddress(getRequestIp(c))) {
      return c.notFound()
    }
    return c.json(orchestrateTrayOpen(registry))
  })

  app.post("/shutdown", async (c) => {
    if (!isLoopbackAddress(getRequestIp(c))) {
      return c.notFound()
    }

    let reason: string | undefined
    try {
      const body: { reason?: unknown } | null = await c.req.json()
      if (body && typeof body.reason === "string") {
        reason = body.reason
      }
    } catch {
      // Empty body is valid; ignore parse errors.
    }

    const traceId = requestContext.getStore()?.traceId
    consola.warn(
      `shutting down due to /_internal/shutdown${reason ? ` (reason: ${reason})` : ""}${traceId ? ` [trace ${traceId}]` : ""}`,
    )

    // Schedule the actual exit *after* Hono has had a chance to flush
    // the 202 response and Bun's HTTP server has released the port.
    // 250ms is empirically enough for both, and the caller is polling
    // for the port-release anyway.
    setTimeout(() => exit(0), 250)

    return c.json({ ok: true, draining: true }, 202)
  })

  return app
}

export const internalRoutes = createInternalRoutes()
