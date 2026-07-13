/**
 * /settings/api/ui — route-level coverage.
 *
 * Config comes from the REAL `~/lib/config/config`, which the global preload
 * (tests/test-setup.ts) has already redirected to a throwaway
 * COPILOT_API_HOME temp dir — so getConfig/writeConfig round-trip through a
 * temp `config.json`, never the user's real config. No `mock.module` on
 * config (it leaks forward across files — see apps-route.test.ts / #229);
 * we just reset with `writeConfig({})` per test.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

const { uiRoutes } = await import("~/routes/settings/ui")
const { getConfig, writeConfig } = await import("~/lib/config/config")

function buildApp() {
  const app = new Hono()
  app.route("/ui", uiRoutes)
  return app
}

beforeEach(() => {
  writeConfig({})
})

afterAll(() => {
  // Leave a clean slate so later files in the shared worker start empty.
  writeConfig({})
})

describe("GET /ui", () => {
  test("defaults menuBarOnly to false when unset", async () => {
    const res = await buildApp().request("/ui")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { menuBarOnly: boolean }
    expect(body.menuBarOnly).toBe(false)
  })
})

describe("POST /ui", () => {
  test("sets true, persists, and GET reflects it", async () => {
    const app = buildApp()
    const res = await app.request("/ui", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ menuBarOnly: true }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { menuBarOnly: boolean }).toEqual({
      menuBarOnly: true,
    })
    expect(getConfig().ui?.menuBarOnly).toBe(true)

    const get = await app.request("/ui")
    expect((await get.json()) as { menuBarOnly: boolean }).toEqual({
      menuBarOnly: true,
    })
  })

  test("sets false", async () => {
    const app = buildApp()
    await app.request("/ui", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ menuBarOnly: true }),
    })
    const res = await app.request("/ui", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ menuBarOnly: false }),
    })
    expect(res.status).toBe(200)
    expect(getConfig().ui?.menuBarOnly).toBe(false)
  })

  test("non-boolean input returns 400", async () => {
    const res = await buildApp().request("/ui", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ menuBarOnly: "yes" }),
    })
    expect(res.status).toBe(400)
  })
})
