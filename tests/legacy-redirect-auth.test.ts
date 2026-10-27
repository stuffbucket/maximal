/**
 * Legacy surface redirects (bookmarks, Claude config, the boot banner) must
 * redirect without an API key even when auth is enforced. Exercises the real
 * `server` so the redirect routes and the auth exemption list are tested
 * together — the routes once covered `/usage-viewer/` while the exemption
 * list didn't, so that redirect 401'd under enforcement.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { getConfig, writeConfig, type AppConfig } from "~/lib/config/config"
import { server } from "~/server"

describe("legacy redirects under enforced auth", () => {
  let prior: AppConfig

  beforeEach(() => {
    prior = getConfig()
    writeConfig({ ...prior, auth: { enforce: true, apiKeys: ["a-real-key"] } })
  })

  afterEach(() => {
    writeConfig(prior)
  })

  test("a keyless request to a non-exempt path is still rejected", async () => {
    const res = await server.request("/v1/models")
    expect(res.status).toBe(401)
  })

  test.each([
    ["/usage-viewer", "/ui/dashboard/"],
    ["/usage-viewer/", "/ui/dashboard/"],
    ["/settings", "/ui/settings/"],
    ["/settings/", "/ui/settings/"],
  ])("%s redirects to %s without a key", async (from, to) => {
    const res = await server.request(from)
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe(to)
  })

  test("the dashboard redirect keeps its query string", async () => {
    const res = await server.request("/usage-viewer/?endpoint=work")
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/ui/dashboard/?endpoint=work")
  })
})
