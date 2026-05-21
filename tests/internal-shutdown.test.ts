/**
 * /_internal/shutdown — graceful-eviction endpoint.
 *
 * Loopback enforcement is the contract that matters here: a remote
 * caller with a valid API key must NOT be able to evict the running
 * proxy. We exercise the handler with an injectable `getRequestIp` so
 * we can simulate both sides without binding a real socket, and an
 * injectable `exit` so the test runner survives.
 */

import type { Context } from "hono"

import { describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { createInternalRoutes } from "~/routes/internal/route"

function buildApp(ip: string | null, exit: (code: number) => void) {
  const routes = createInternalRoutes({
    exit,
    getRequestIp: (_c: Context) => ip,
  })
  const app = new Hono()
  app.route("/_internal", routes)
  return app
}

describe("/_internal/shutdown", () => {
  test("non-loopback origin → 404, no exit scheduled", async () => {
    const exit = mock((_code: number) => {})
    const res = await buildApp("10.0.0.5", exit).request(
      "/_internal/shutdown",
      { method: "POST" },
    )
    expect(res.status).toBe(404)
    // Even after a tick, exit must not fire.
    await new Promise((r) => setTimeout(r, 350))
    expect(exit).not.toHaveBeenCalled()
  })

  test("loopback origin → 202 with { ok: true, draining: true }", async () => {
    const exit = mock((_code: number) => {})
    const res = await buildApp("127.0.0.1", exit).request(
      "/_internal/shutdown",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "replace" }),
      },
    )
    expect(res.status).toBe(202)
    const body = (await res.json()) as { ok: boolean; draining: boolean }
    expect(body).toEqual({ ok: true, draining: true })
  })

  test("loopback origin schedules process exit after responding", async () => {
    const exit = mock((_code: number) => {})
    const res = await buildApp("::1", exit).request("/_internal/shutdown", {
      method: "POST",
    })
    expect(res.status).toBe(202)
    // Exit must NOT have fired before the response was returned.
    expect(exit).not.toHaveBeenCalled()
    // The handler uses a 250ms delay before exit; wait long enough.
    await new Promise((r) => setTimeout(r, 400))
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })
})
