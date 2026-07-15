import { afterAll, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { serve } from "srvx"

import { LiveFeedHub } from "~/lib/ws/live-feed"
import { PresenceRegistry } from "~/lib/ws/presence-registry"
import {
  createWebSocketHandler,
  createWsRoutes,
  WS_PATH,
} from "~/routes/ws/route"

/**
 * THE gate to prove first (spec §1.3, §10 "WS real-port handshake"): srvx's
 * fetch-wrapper must tolerate the `undefined` return after `server.upgrade()`. If
 * it coerces that to a `Response`, the Bun WebSocket handshake silently fails.
 *
 * This is the ONE deliberate real-port test in the suite (every other test uses
 * Hono's in-memory `app.request()` — the repo binds no ports). It uses
 * `serve({ port: 0, bun: { websocket } })` to get an ephemeral port and opens a
 * genuine WebSocket against it. Skipped until the handler body lands; if the gate
 * fails when unskipped, the fallback is a srvx plugin that upgrades before Hono.
 */

const sockets: Array<{ close: () => void }> = []
let httpServer: ReturnType<typeof serve> | null = null

afterAll(async () => {
  for (const s of sockets) s.close()
  await httpServer?.close(true)
})

describe.skip("srvx bun:{websocket} upgrade handshake — unskip when implemented", () => {
  test("a real WebSocket connects through the srvx→Bun upgrade", async () => {
    const registry = new PresenceRegistry()
    const hub = new LiveFeedHub({
      registry,
      buildSnapshot: () => Promise.reject(new Error("stub")),
    })
    const app = new Hono()
    app.route(WS_PATH, createWsRoutes({ hub, registry }))

    httpServer = serve({
      port: 0,
      fetch: app.fetch,
      // The passthrough under test: this handler object must reach Bun.serve.
      bun: { websocket: createWebSocketHandler({ hub, registry }) },
    })

    // srvx exposes the bound address on the server handle; derive the ws:// URL.
    const url = new URL((httpServer as unknown as { url: string }).url)
    const wsUrl = `ws://${url.host}${WS_PATH}?key=test-token`

    const opened = await new Promise<boolean>(
      (resolvePromise, rejectPromise) => {
        const ws = new WebSocket(wsUrl)
        sockets.push({ close: () => ws.close() })
        const timer = setTimeout(
          () => rejectPromise(new Error("handshake timeout")),
          2000,
        )
        ws.addEventListener("open", () => {
          clearTimeout(timer)
          resolvePromise(true)
        })
        ws.addEventListener("error", () => {
          clearTimeout(timer)
          rejectPromise(new Error("handshake failed"))
        })
      },
    )

    expect(opened).toBe(true)
  })
})
