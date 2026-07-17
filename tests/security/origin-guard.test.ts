import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  CSRF_GUARDED_PREFIXES,
  MANDATORY_AUTH_PREFIX,
  buildCorsOptions,
  createOriginGuardMiddleware,
  isAllowedOrigin,
  isCsrfGuardedPath,
} from "~/lib/auth/origin-guard"
import { WS_PATH } from "~/routes/ws/route"

/**
 * Control-surface hardening (spec §6, ADR-0021). The CSRF hole is live TODAY, so
 * this ships first (build sequence §9.1). Behavioral cases are authored below and
 * skipped until the bodies land; the constant-shape guards run live now.
 */

const PORT = 4141

describe("hardening constants — active now", () => {
  test("the guarded prefixes cover settings-api, internal, and debug-state (§6.1)", () => {
    expect(CSRF_GUARDED_PREFIXES).toContain("/settings/api")
    expect(CSRF_GUARDED_PREFIXES).toContain("/_internal") // covers /_internal/shutdown
    expect(CSRF_GUARDED_PREFIXES).toContain("/_debug/state")
  })

  test("mandatory auth is scoped to /settings/api, decoupled from enforce (§6.2)", () => {
    expect(MANDATORY_AUTH_PREFIX).toBe("/settings/api")
  })

  test("the live-feed WS path is Origin-gated, and the constant hasn't drifted (§1.3)", () => {
    // The snapshot exposes auth/accounts state and WebSockets bypass CORS, so the
    // handshake GET must be Origin-gated. Pin CSRF_GUARDED_PREFIXES to the actual
    // mount path so a rename of one doesn't silently un-gate the socket.
    expect(CSRF_GUARDED_PREFIXES).toContain(WS_PATH)
    expect(isCsrfGuardedPath(`${WS_PATH}?key=tok`.split("?")[0])).toBe(true)
  })
})

describe("isAllowedOrigin — unskip when implemented", () => {
  test("a missing Origin passes — CLI/plugin clients send none (§6.6 invariant)", () => {
    expect(isAllowedOrigin(null, PORT)).toBe(true)
  })
  test("localhost + 127.0.0.1 on the bound port pass", () => {
    expect(isAllowedOrigin(`http://localhost:${PORT}`, PORT)).toBe(true)
    expect(isAllowedOrigin(`http://127.0.0.1:${PORT}`, PORT)).toBe(true)
  })
  test("a foreign origin is rejected", () => {
    expect(isAllowedOrigin("https://evil.example", PORT)).toBe(false)
  })
  test("the wrong port is rejected (not a blanket localhost allow)", () => {
    expect(isAllowedOrigin(`http://localhost:${PORT + 1}`, PORT)).toBe(false)
  })
})

describe("isCsrfGuardedPath — unskip when implemented", () => {
  test("guards the control prefixes and not the proxy surface", () => {
    expect(isCsrfGuardedPath("/settings/api/accounts")).toBe(true)
    expect(isCsrfGuardedPath("/_internal/shutdown")).toBe(true)
    expect(isCsrfGuardedPath("/_debug/state")).toBe(true)
    expect(isCsrfGuardedPath("/v1/models")).toBe(false) // CLI surface stays open
  })
})

function mountGuarded() {
  const app = new Hono()
  app.use("*", createOriginGuardMiddleware({ boundPort: () => PORT }))
  app.post("/settings/api/accounts/remove", (c) => c.json({ ok: true }))
  return app
}

describe("origin guard middleware — unskip when implemented", () => {
  test("evil Origin → 403 on a mutation", async () => {
    const res = await mountGuarded().request("/settings/api/accounts/remove", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    })
    expect(res.status).toBe(403)
    // Pin the machine-readable error contract — clients branch on `type`.
    const body = (await res.json()) as { error?: { type?: string } }
    expect(body.error?.type).toBe("csrf_error")
  })

  test("localhost Origin passes the Origin gate (reaches the route)", async () => {
    // The enforce-decoupled mandatory `/settings/api` auth (§6.2) is NOT a
    // separate gate — it is a mode of `createAuthMiddleware`; its "no key → 401"
    // behavior is exercised in the request-auth suite, not here.
    const res = await mountGuarded().request("/settings/api/accounts/remove", {
      method: "POST",
      headers: { origin: `http://localhost:${PORT}` },
    })
    expect(res.status).toBe(200)
  })

  test("cors options never echo '*'", () => {
    const opts = buildCorsOptions(() => PORT)
    expect(opts.origin("https://evil.example")).toBeNull()
    expect(opts.origin(`http://localhost:${PORT}`)).toBe(
      `http://localhost:${PORT}`,
    )
  })
})
