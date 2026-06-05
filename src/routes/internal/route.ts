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

import { defaultGetRequestIp, isLoopbackAddress } from "~/lib/request-auth"
import { requestContext } from "~/lib/request-context"

interface InternalRoutesOptions {
  /** Injectable for tests so we don't actually exit the runner. */
  exit?: (code: number) => void
  /** Injectable so tests can simulate non-loopback requests. */
  getRequestIp?: (c: Context) => string | null
}

export function createInternalRoutes(
  options: InternalRoutesOptions = {},
): Hono {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const getRequestIp = options.getRequestIp ?? defaultGetRequestIp

  const app = new Hono()

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
