import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Exercises the unified `/ui/*` serving (src/routes/ui/route.ts) in
 * dev/disk mode via `MAXIMAL_UI_DIST`. Production embed mode (assets in
 * the compiled binary) is covered by the build pipeline; here we assert
 * routing, content types, SPA fallback, redirects, and traversal safety.
 */

let scratch: string
let app: Hono

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "maximal-ui-"))
  await mkdir(join(scratch, "settings"), { recursive: true })
  await writeFile(
    join(scratch, "settings", "index.html"),
    "<!doctype html><title>settings</title>",
  )
  await writeFile(
    join(scratch, "settings", "index-abc.js"),
    "console.log('settings')",
  )

  process.env.MAXIMAL_UI_DIST = scratch

  // Import after MAXIMAL_UI_DIST is set so disk resolution sees the fixture.
  const { uiRoutes } = await import("~/routes/ui/route")
  app = new Hono()
  app.route("/ui", uiRoutes)
})

afterAll(async () => {
  delete process.env.MAXIMAL_UI_DIST
  await rm(scratch, { recursive: true, force: true })
})

describe("ui routes", () => {
  test("serves the settings index", async () => {
    const res = await app.request("/ui/settings/")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toContain("settings")
  })

  test("inlines window.__STATE__ into the settings index for instant paint (§1.4)", async () => {
    const body = await (await app.request("/ui/settings/")).text()
    // The serve path injects the snapshot as window.__STATE__ (best-effort); a
    // populated first paint means the tab renders before the WS connects.
    expect(body).toContain("window.__STATE__=")
    // The snapshot is a real object with the auth surface, not an empty stub.
    expect(body).toContain("snapshot")
  })

  test("does NOT inline state into JS assets (only HTML is injected)", async () => {
    const body = await (await app.request("/ui/settings/index-abc.js")).text()
    expect(body).not.toContain("window.__STATE__=")
    expect(body).toContain("settings") // the asset's own content is intact
  })

  test("serves a settings asset with the right content type", async () => {
    const res = await app.request("/ui/settings/index-abc.js")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("javascript")
  })

  test("falls back to the settings SPA index for unknown sub-routes", async () => {
    const res = await app.request("/ui/settings/some/client/route")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("settings")
  })

  test("redirects the bare /ui/settings to the trailing-slash index", async () => {
    const res = await app.request("/ui/settings")
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/ui/settings/")
  })

  test("the removed /ui/dashboard surface is a 404, not a redirect (§7)", async () => {
    // The standalone dashboard is gone — its usage view is now the settings
    // Usage section. `/usage-viewer` (server.ts) is what redirects to `#usage`.
    const res = await app.request("/ui/dashboard/")
    expect(res.status).toBe(404)
  })

  test("404s an unknown surface under /ui", async () => {
    const res = await app.request("/ui/nope/index.html")
    expect(res.status).toBe(404)
  })

  test("rejects path traversal", async () => {
    const res = await app.request("/ui/settings/../../../etc/passwd")
    expect(res.status).toBe(404)
  })

  test("sends no-store so webviews never serve stale UI", async () => {
    const res = await app.request("/ui/settings/")
    expect(res.headers.get("cache-control")).toBe("no-store")
  })
})
