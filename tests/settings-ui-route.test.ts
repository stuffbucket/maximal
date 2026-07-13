/**
 * /settings/api/ui — route-level coverage.
 *
 * Mocking strategy mirrors apps-route.test.ts: an in-memory
 * getConfig/writeConfig (Bun's `mock.module` persists forward across
 * files, so this stays a delegating wrapper that only swaps those two
 * functions), reset per test and cleared in afterAll so later files see
 * an empty config.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { AppConfig } from "~/lib/config"

let fakeConfig: AppConfig = {}

const actualConfig = await import("~/lib/config")
void mock.module("~/lib/config", () => ({
  ...actualConfig,
  getConfig: () => fakeConfig,
  writeConfig: (next: AppConfig) => {
    fakeConfig = next
    return next
  },
}))

const { uiRoutes } = await import("~/routes/settings/ui")
const { getConfig } = await import("~/lib/config")

function buildApp() {
  const app = new Hono()
  app.route("/ui", uiRoutes)
  return app
}

beforeEach(() => {
  fakeConfig = {}
})

afterAll(() => {
  fakeConfig = {}
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
