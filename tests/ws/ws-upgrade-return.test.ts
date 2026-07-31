import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createWsRoutes, WS_PATH } from "~/routes/ws/route"

/**
 * Unit guard for the `/ws` upgrade return (complements the real-port handshake
 * in srvx-upgrade-handshake.test.ts). On a successful `server.upgrade()` the
 * handler must return a Response Hono can finalize — an explicit `101`. A bare
 * `undefined` finalizes to status 0, which `new Response()` rejects (RangeError),
 * logging a spurious error + 500 on every connection.
 *
 * We inject a fake Bun server via `request.runtime.bun.server` (the seam
 * `bunServer()` reads) so the handler reaches the upgrade branch in-memory,
 * without binding a port.
 */
describe("ws /ws upgrade return value", () => {
  test("returns a 101 Response when the server upgrades (not an uncoercible undefined)", async () => {
    const app = new Hono()
    app.route(WS_PATH, createWsRoutes())

    const req = new Request(`http://local${WS_PATH}?key=test-token`)
    ;(req as unknown as { runtime: unknown }).runtime = {
      bun: { server: { upgrade: () => true } },
    }

    const res = await app.request(req)
    expect(res.status).toBe(101)
  })

  test("returns 426 when the server declines the upgrade", async () => {
    const app = new Hono()
    app.route(WS_PATH, createWsRoutes())

    const req = new Request(`http://local${WS_PATH}?key=test-token`)
    ;(req as unknown as { runtime: unknown }).runtime = {
      bun: { server: { upgrade: () => false } },
    }

    const res = await app.request(req)
    expect(res.status).toBe(426)
  })
})
