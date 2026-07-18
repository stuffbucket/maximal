import { describe, expect, test } from "bun:test"

import { createInternalRoutes } from "~/routes/internal/route"

/**
 * Browser-tab in-place self-update path (Phase 6). The settings tab has no Tauri
 * host to invoke the updater plugin, so it POSTs /_internal/upgrade; the sidecar
 * signals the supervising shell (over stdout) to run the signed
 * download+verify+install+relaunch. Loopback-only, mirroring /_internal/quit.
 */

function app(opts: Parameters<typeof createInternalRoutes>[0]) {
  return createInternalRoutes({ getRequestIp: () => "127.0.0.1", ...opts })
}

describe("POST /_internal/upgrade", () => {
  test("loopback caller with a supervising shell → 202 and signals upgrade", async () => {
    let signalled = false
    const res = await app({
      requestUpgrade: () => {
        signalled = true
        return true
      },
    }).request("/upgrade", { method: "POST" })
    expect(res.status).toBe(202)
    expect(signalled).toBe(true)
    expect(await res.json()).toEqual({ ok: true, upgrading: true })
  })

  test("no supervising shell (plain CLI) → 409, does not claim to upgrade", async () => {
    const res = await app({ requestUpgrade: () => false }).request("/upgrade", {
      method: "POST",
    })
    expect(res.status).toBe(409)
    expect((await res.json()) as { ok: boolean; reason: string }).toEqual({
      ok: false,
      reason: "no_supervising_shell",
    })
  })

  test("a non-loopback caller gets 404 (a remote page can't self-update the app)", async () => {
    let signalled = false
    const res = await createInternalRoutes({
      getRequestIp: () => "10.0.0.5",
      requestUpgrade: () => {
        signalled = true
        return true
      },
    }).request("/upgrade", { method: "POST" })
    expect(res.status).toBe(404)
    expect(signalled).toBe(false)
  })
})
