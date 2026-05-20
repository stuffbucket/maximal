/**
 * /settings/api/clients — endpoint coverage.
 *
 * Mounts the route on a bare Hono app (no outer auth middleware) so we
 * exercise the handler contract directly. The auth-gating is validated
 * separately via the existing settings-api-auth suite and the prefix
 * config in server.ts.
 *
 * A second app, with `createAuthMiddleware` in front, covers the 401
 * path so we don't regress the "this endpoint requires a key" guarantee.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  __resetActiveClientsForTests,
  recordClient,
} from "~/lib/active-clients"
import { createAuthMiddleware } from "~/lib/request-auth"
import { clientsRoutes } from "~/routes/settings/clients"

function buildApp() {
  const app = new Hono()
  app.route("/clients", clientsRoutes)
  return app
}

function buildAuthedApp() {
  const app = new Hono()
  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => ["secret-key-aaaa"],
      isEnforcing: () => true,
      allowUnauthenticatedPaths: [],
    }),
  )
  app.route("/clients", clientsRoutes)
  return app
}

beforeEach(() => {
  __resetActiveClientsForTests()
})

describe("/settings/api/clients GET /", () => {
  test("returns empty list when nothing has been recorded", async () => {
    const res = await buildApp().request("/clients")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      clients: Array<unknown>
      total: number
    }
    expect(body.clients).toEqual([])
    expect(body.total).toBe(0)
  })

  test("returns recorded clients", async () => {
    recordClient({
      apiKeyId: "id-1",
      apiKeyLabel: "Claude Code",
      userAgent: "Claude-Code/2.0",
    })
    const res = await buildApp().request("/clients")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      clients: Array<{ label: string; userAgent: string }>
      total: number
    }
    expect(body.total).toBe(1)
    expect(body.clients[0].label).toBe("Claude Code")
    expect(body.clients[0].userAgent).toBe("Claude-Code/2.0")
  })

  test("honors maxAgeSeconds query parameter (parses + passes through)", async () => {
    recordClient({
      apiKeyId: null,
      apiKeyLabel: null,
      userAgent: "Cline/0.5",
    })
    // Both windows are larger than the elapsed time, so the entry shows
    // up either way — the assertion is really that the query param is
    // accepted and the response shape is unchanged across values. The
    // time-window expiry itself is covered in active-clients.test.ts.
    const res = await buildApp().request("/clients?maxAgeSeconds=120")
    expect(res.status).toBe(200)
    expect(((await res.json()) as { total: number }).total).toBe(1)
  })

  test("rejects out-of-range maxAgeSeconds", async () => {
    const res = await buildApp().request("/clients?maxAgeSeconds=9999")
    expect(res.status).toBe(400)
  })

  test("401 when no API key is supplied (auth middleware in front)", async () => {
    const res = await buildAuthedApp().request("/clients")
    expect(res.status).toBe(401)
  })

  test("200 when a valid API key is supplied", async () => {
    const res = await buildAuthedApp().request("/clients", {
      headers: { "x-api-key": "secret-key-aaaa" },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      clients: Array<unknown>
      total: number
    }
    expect(body.total).toBe(0)
  })
})
