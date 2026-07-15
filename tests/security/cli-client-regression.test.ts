import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createOriginGuardMiddleware } from "~/lib/auth/origin-guard"

/**
 * CLI/plugin non-regression (spec §6.6, §11.1 blocker).
 *
 * Claude Code, opencode, and SDK clients are non-browser callers that send NO
 * `Origin` and hit `/v1/*` (+ the `api claude-code` key mint) with
 * `Authorization: Bearer <key>` — NOT `/settings/api`. The Origin gate must let a
 * missing-Origin request through. Skipped until the middleware body lands.
 *
 * The OTHER half of the invariant — that the enforce-decoupled mandatory
 * `/settings/api` auth (§6.2) does NOT gate `/v1/*` — is asserted where that auth
 * lives (a mode of `createAuthMiddleware`, `request-auth.ts`), not here; there is
 * no separate settings-api gate to regress.
 */

/** Mounts the Origin guard in front of a `/v1` route (a no-Origin surface). */
function mountWithGuard() {
  const app = new Hono()
  // The guard is mounted globally in server.ts; a no-Origin request must pass
  // straight through on non-guarded paths.
  app.use("*", createOriginGuardMiddleware({ boundPort: () => 4141 }))
  app.post("/v1/messages", (c) => c.json({ ok: true }))
  return app
}

describe("no-Origin Bearer client on /v1/* still succeeds — unskip when implemented", () => {
  test("a Bearer request with no Origin header reaches /v1/messages", async () => {
    const res = await mountWithGuard().request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer sk-test" }, // NOTE: no `origin` header
    })
    expect(res.status).toBe(200)
  })
})
