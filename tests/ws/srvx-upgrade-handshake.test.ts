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
 * genuine WebSocket against it. If the gate ever fails, the fallback is a srvx
 * plugin/middleware that upgrades before Hono.
 *
 * PROVEN: the `undefined` return after `server.upgrade()` survives Hono + srvx
 * + Bun with no coercion. This runs in the default `bun test` — it no longer
 * needs a gate. It used to conflict with `start-run-server.test.ts`, which
 * mocked srvx via `mock.module("srvx", …)` (a stub that forward-leaks across
 * files per CLAUDE.md and left the live `serve` binding half-rewired). That
 * test now injects its serve stub through a module-local DI seam
 * (`__setServeForTests`) instead of mocking srvx, so the real srvx reaches
 * this file and the two co-run cleanly. Ungating is guarded by the
 * mockModuleLeakGuard eslint rule, which forbids re-introducing
 * `mock.module("srvx", …)`.
 */

const sockets: Array<{ close: () => void }> = []
let httpServer: ReturnType<typeof serve> | null = null

afterAll(async () => {
  for (const s of sockets) s.close()
  await httpServer?.close(true)
})

describe("srvx bun:{websocket} upgrade handshake", () => {
  test("a real WebSocket connects through the srvx→Bun upgrade", async () => {
    const registry = new PresenceRegistry()
    const hub = new LiveFeedHub({
      registry,
      buildSnapshot: () => Promise.reject(new Error("stub")),
    })
    const app = new Hono()
    app.route(WS_PATH, createWsRoutes())

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
