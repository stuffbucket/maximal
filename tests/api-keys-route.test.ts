/**
 * /settings/api/api-keys — CRUD coverage.
 *
 * `getConfig` and `writeConfig` are mocked to a single in-memory
 * fixture so tests don't touch disk or the user's real config. The
 * route is mounted on a bare Hono app (no outer auth middleware) so
 * we exercise the handler contract directly.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { AppConfig } from "~/lib/config"

let fakeConfig: AppConfig = {}

void mock.module("~/lib/config", () => ({
  getConfig: () => fakeConfig,
  writeConfig: (next: AppConfig) => {
    fakeConfig = next
    return next
  },
}))

const { apiKeysRoutes } = await import("~/routes/settings/api-keys")

function buildApp() {
  const app = new Hono()
  app.route("/api-keys", apiKeysRoutes)
  return app
}

beforeEach(() => {
  fakeConfig = {}
})

describe("/api-keys GET /", () => {
  test("empty config → enforcing=false, no entries", async () => {
    const res = await buildApp().request("/api-keys")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      entries: Array<unknown>
      enforcing: boolean
    }
    expect(body.entries).toEqual([])
    expect(body.enforcing).toBe(false)
  })

  test("legacy apiKeys present → enforcing=true even with no entries", async () => {
    fakeConfig = { auth: { apiKeys: ["legacy-key"] } }
    const res = await buildApp().request("/api-keys")
    const body = (await res.json()) as { enforcing: boolean }
    expect(body.enforcing).toBe(true)
  })

  test("only-disabled entries → enforcing=false", async () => {
    fakeConfig = {
      auth: {
        apiKeyEntries: [
          {
            id: "a",
            label: "off",
            key: "abcdefgh",
            enabled: false,
            created_at: "2025-01-01T00:00:00Z",
          },
        ],
      },
    }
    const res = await buildApp().request("/api-keys")
    const body = (await res.json()) as { enforcing: boolean }
    expect(body.enforcing).toBe(false)
  })
})

describe("/api-keys POST /", () => {
  test("auto-generates a key when none supplied; prefix mxl_; charset CLI-safe", async () => {
    const res = await buildApp().request("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Claude Code" }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { key: string; label: string }
    expect(body.label).toBe("Claude Code")
    expect(body.key.startsWith("mxl_")).toBe(true)
    expect(/^mxl_[\w-]+$/.test(body.key)).toBe(true)
    expect(fakeConfig.auth?.apiKeyEntries?.length).toBe(1)
  })

  test("accepts the literal '*' wildcard", async () => {
    const res = await buildApp().request("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Permit all", key: "*" }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { key: string }
    expect(body.key).toBe("*")
  })

  test("rejects keys containing shell-unsafe characters (e.g. $, !, space)", async () => {
    for (const bad of ["has space", "dollar$ign", "semi;colon", "back`tick"]) {
      const res = await buildApp().request("/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "x", key: bad }),
      })
      expect(res.status).toBe(400)
    }
  })

  test("rejects too-short keys (< 8 chars)", async () => {
    const res = await buildApp().request("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "x", key: "abc" }),
    })
    expect(res.status).toBe(400)
  })

  test("rejects empty label", async () => {
    const res = await buildApp().request("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "" }),
    })
    expect(res.status).toBe(400)
  })

  test("duplicate key → 409", async () => {
    const app = buildApp()
    await app.request("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "first", key: "duplicate-key-12345" }),
    })
    const res = await app.request("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "second", key: "duplicate-key-12345" }),
    })
    expect(res.status).toBe(409)
  })

  test("defaults enabled=true when omitted", async () => {
    const res = await buildApp().request("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    })
    const body = (await res.json()) as { enabled: boolean }
    expect(body.enabled).toBe(true)
  })
})

describe("/api-keys PATCH /:id", () => {
  test("toggles enabled without re-supplying the key", async () => {
    const app = buildApp()
    const created = (await (
      await app.request("/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "x" }),
      })
    ).json()) as { id: string; enabled: boolean }

    const res = await app.request(`/api-keys/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as { enabled: boolean }
    expect(updated.enabled).toBe(false)
  })

  test("404 when id is unknown", async () => {
    const res = await buildApp().request("/api-keys/does-not-exist", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(404)
  })

  test("rejects an updated key that collides with another entry", async () => {
    const app = buildApp()
    const a = (await (
      await app.request("/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "a", key: "first-key-aaaa" }),
      })
    ).json()) as { id: string }
    await app.request("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "b", key: "second-key-bbbb" }),
    })
    const res = await app.request(`/api-keys/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "second-key-bbbb" }),
    })
    expect(res.status).toBe(409)
  })
})

describe("/api-keys DELETE /:id", () => {
  test("removes the entry and returns 204", async () => {
    const app = buildApp()
    const created = (await (
      await app.request("/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "x" }),
      })
    ).json()) as { id: string }
    const res = await app.request(`/api-keys/${created.id}`, {
      method: "DELETE",
    })
    expect(res.status).toBe(204)
    expect(fakeConfig.auth?.apiKeyEntries ?? []).toEqual([])
  })

  test("404 when id is unknown", async () => {
    const res = await buildApp().request("/api-keys/nope", { method: "DELETE" })
    expect(res.status).toBe(404)
  })
})
