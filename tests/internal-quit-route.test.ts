import { describe, expect, test } from "bun:test"

import { createInternalRoutes } from "~/routes/internal/route"

/**
 * Browser-tab quit path (spec §1.6). The settings tab has no Tauri host to
 * `invoke` a quit, so it POSTs /_internal/quit; the sidecar signals the
 * supervising shell (over stdout) to quit the whole app. Loopback-only.
 */

function app(opts: Parameters<typeof createInternalRoutes>[0]) {
  return createInternalRoutes({ getRequestIp: () => "127.0.0.1", ...opts })
}

describe("POST /_internal/quit", () => {
  test("loopback caller with a supervising shell → 202 and signals quit", async () => {
    let signalled = false
    const res = await app({
      requestQuit: () => {
        signalled = true
        return true
      },
    }).request("/quit", { method: "POST" })
    expect(res.status).toBe(202)
    expect(signalled).toBe(true)
    expect(await res.json()).toEqual({ ok: true, quitting: true })
  })

  test("no supervising shell (plain CLI) → 409, does not claim to quit", async () => {
    const res = await app({ requestQuit: () => false }).request("/quit", {
      method: "POST",
    })
    expect(res.status).toBe(409)
    expect((await res.json()) as { ok: boolean; reason: string }).toEqual({
      ok: false,
      reason: "no_supervising_shell",
    })
  })

  test("a non-loopback caller gets 404 (a remote page can't quit the app)", async () => {
    let signalled = false
    const res = await createInternalRoutes({
      getRequestIp: () => "10.0.0.5",
      requestQuit: () => {
        signalled = true
        return true
      },
    }).request("/quit", { method: "POST" })
    expect(res.status).toBe(404)
    expect(signalled).toBe(false)
  })
})
