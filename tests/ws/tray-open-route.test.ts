import { describe, expect, test } from "bun:test"

import {
  orchestrateTrayOpen,
  PresenceRegistry,
  type PresenceSocket,
} from "~/lib/ws/presence-registry"
import { createInternalRoutes } from "~/routes/internal/route"

/**
 * Tray-open orchestration (spec §1.2). The native tray click routes to
 * POST /_internal/tray-open; the sidecar runs the single-tab decision over its
 * presence registry — close buried tab(s) over the WS, tell the shell whether to
 * open a fresh foreground tab — and it is loopback-only.
 */

function fakeSocket(): PresenceSocket & { sent: Array<string> } {
  const sent: Array<string> = []
  return { sent, send: (d: string) => sent.push(d), close: () => {} }
}

/** Mount the internal routes with an injected registry + simulated peer IP. */
function trayOpenApp(registry: PresenceRegistry, ip = "127.0.0.1") {
  return createInternalRoutes({ registry, getRequestIp: () => ip })
}

describe("orchestrateTrayOpen", () => {
  test("no tabs → open, nothing to close", () => {
    expect(orchestrateTrayOpen(new PresenceRegistry())).toEqual({ open: true })
  })

  test("a visible tab exists → noop (don't open a duplicate)", () => {
    const reg = new PresenceRegistry()
    reg.register("a", fakeSocket(), "visible")
    expect(orchestrateTrayOpen(reg)).toEqual({ open: false })
  })

  test("only buried tabs → close each over the WS, then open one fresh", () => {
    const reg = new PresenceRegistry()
    const a = fakeSocket()
    const b = fakeSocket()
    reg.register("a", a, "hidden")
    reg.register("b", b, "prerender")
    expect(orchestrateTrayOpen(reg)).toEqual({ open: true })
    // Each buried tab was told to self-close.
    expect(JSON.parse(a.sent[0])).toEqual({ type: "close" })
    expect(JSON.parse(b.sent[0])).toEqual({ type: "close" })
  })

  test("a visible tab among buried ones is NOT closed (noop wins)", () => {
    const reg = new PresenceRegistry()
    const hidden = fakeSocket()
    reg.register("a", hidden, "hidden")
    reg.register("b", fakeSocket(), "visible")
    expect(orchestrateTrayOpen(reg)).toEqual({ open: false })
    expect(hidden.sent).toHaveLength(0) // nothing closed
  })
})

describe("POST /_internal/tray-open", () => {
  test("loopback caller gets the decision", async () => {
    const reg = new PresenceRegistry()
    reg.register("a", fakeSocket(), "visible")
    const res = await trayOpenApp(reg).request("/tray-open", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ open: false })
  })

  test("closes buried tabs and reports open:true", async () => {
    const reg = new PresenceRegistry()
    const buried = fakeSocket()
    reg.register("a", buried, "hidden")
    const res = await trayOpenApp(reg).request("/tray-open", { method: "POST" })
    expect(await res.json()).toEqual({ open: true })
    expect(JSON.parse(buried.sent[0])).toEqual({ type: "close" })
  })

  test("a non-loopback caller gets 404 (indistinguishable from no route)", async () => {
    const res = await trayOpenApp(new PresenceRegistry(), "10.0.0.5").request(
      "/tray-open",
      { method: "POST" },
    )
    expect(res.status).toBe(404)
  })
})
