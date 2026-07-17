import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { uiRoutes } from "~/routes/ui/route"

/**
 * Pins the Rust↔TS agreement on the `/ui/*` URLs. No compiler spans the
 * boundary: the Tauri shell (shell/src-tauri/src/lib.rs) opens its webview
 * windows at hard-coded URLs, and the proxy (src/routes/ui/route.ts) decides
 * what those URLs serve. A one-sided rename — e.g. moving the route to
 * `/ui/config` but leaving lib.rs on `/ui/settings/` — compiles and tests
 * green on each side individually, but the packaged app's window silently
 * 404s. These tests fail instead.
 */

const REPO_ROOT = resolve(import.meta.dir, "..")
const SHELL_LIB_RS = readFileSync(
  resolve(REPO_ROOT, "shell", "src-tauri", "src", "lib.rs"),
  "utf8",
)

// The canonical UI window URL the Tauri shell navigates to. (The standalone
// /ui/dashboard/ was removed in §7 — its usage view is the settings SPA's Usage
// section, so lib.rs opens Settings at #usage, not a separate dashboard route.)
const UI_WINDOW_PATHS = ["/ui/settings/"] as const

describe("shell ↔ proxy /ui URL contract", () => {
  for (const path of UI_WINDOW_PATHS) {
    test(`lib.rs opens a window at ${path}`, () => {
      expect(
        SHELL_LIB_RS.includes(path),
        `shell/src-tauri/src/lib.rs no longer references ${path}. If the proxy `
          + `route moved, update the Tauri window URL too — otherwise the packaged `
          + `app's webview 404s.`,
      ).toBe(true)
    })

    test(`the proxy serves ${path}`, async () => {
      const app = new Hono()
      app.route("/ui", uiRoutes)
      const res = await app.request(path)
      // 200 when a bundle is present (dev/embed), 503 when not built — either
      // proves the route is *mounted* at this path. A 404 means it isn't.
      expect([200, 503]).toContain(res.status)
    })
  }

  test("legacy /settings and /usage-viewer paths are still referenced as redirects", () => {
    // The shell may still deep-link the old paths; the proxy 301s them. Pin
    // that the redirect surface exists in server wiring — including the
    // /usage-viewer → Usage-section redirect that replaced the old dashboard.
    const server = readFileSync(resolve(REPO_ROOT, "src", "server.ts"), "utf8")
    expect(server).toContain('"/ui/settings/"')
    expect(server).toContain("/ui/settings/#usage")
  })
})
