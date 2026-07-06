/**
 * Regression guard for security defect #230.
 *
 * `GET /token` used to return the RAW upstream Copilot secret
 * (`{ token: state.copilotToken }`). It had zero legitimate consumers
 * anywhere in the repo and was inherited verbatim from the vendored
 * upstream fork, so the fix DELETED the route rather than gating it —
 * a deleted route can't leak the secret to anyone.
 *
 * The load-bearing assertion here is that an AUTHENTICATED,
 * NON-LOOPBACK caller (a remote holder of a valid API key) can NOT
 * read the secret: the route is gone, so the request 404s. Merely
 * adding `/token` to `loopbackOnlyPaths` would NOT have blocked such a
 * caller (that list only *relaxes* auth for loopback callers — see
 * src/lib/request-auth.ts), which is why deletion is the correct fix.
 *
 * In-process `server.request(...)` carries no socket, so
 * `defaultGetRequestIp` resolves to null → the caller is treated as
 * non-loopback. We authenticate via `state.shellApiKey`, whose
 * presented key bypasses the enforce flag in the auth middleware.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { state } from "~/lib/state"
import { server } from "~/server"

const SHELL_KEY = "test-shell-key-230"

describe("GET /token is removed (security defect #230)", () => {
  let priorShellKey: string | undefined
  let priorCopilotToken: string | undefined

  beforeEach(() => {
    priorShellKey = state.shellApiKey
    priorCopilotToken = state.copilotToken
    // A valid credential the auth middleware honours regardless of the
    // enforce flag, so the request reaches routing rather than 401ing.
    state.shellApiKey = SHELL_KEY
    // If the route somehow still existed, this is the secret it would leak.
    state.copilotToken = "copilot_secret_should_never_be_served"
  })

  afterEach(() => {
    state.shellApiKey = priorShellKey
    state.copilotToken = priorCopilotToken
  })

  test("authenticated non-loopback caller gets 404, never the raw secret", async () => {
    const res = await server.request("/token", {
      headers: { "x-api-key": SHELL_KEY },
    })

    // Route is absent → 404 (indistinguishable from a missing route to a
    // remote scanner), NOT a 200 carrying the Copilot token.
    expect(res.status).toBe(404)
    const text = await res.text()
    expect(text).not.toContain(state.copilotToken as string)
    expect(text).not.toContain("copilot_secret_should_never_be_served")
  })

  test("unauthenticated caller also never receives the secret", async () => {
    const res = await server.request("/token")

    // Either 401 (auth gate) or 404 (route absent) — never a 200 with the
    // token. The key property: no code path serves state.copilotToken.
    expect(res.status).not.toBe(200)
    const text = await res.text()
    expect(text).not.toContain("copilot_secret_should_never_be_served")
  })
})
