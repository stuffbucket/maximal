/**
 * `/figjam/*` on Maximal's own origin: the discovery metadata and the panel's
 * WebSocket, relayed to the bridge. A real HTTP server (the same srvx + Bun
 * wiring `run-server.ts` uses) fronts a stand-in bridge socket, and once, the
 * real bridge, with a fake panel that pairs through the relay.
 */

import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { serve } from "srvx"

import { isVerboseProfile, resolveFigjamProfile } from "~/lib/figjam/profile"
import { createFigjamRelay } from "~/lib/figjam/relay"
import {
  type BridgeAvailability,
  BRIDGE_PORT_FACT,
  bridgeAvailability,
  createFigjamRoutes,
  FIGJAM_PANEL_PATH,
} from "~/routes/figjam/route"

import { startBridge } from "../packages/figjam-bridge/src/server"
import * as pluginProfile from "../packages/plugin-figjam/src/profile"
import { BRIDGE_PORT_FACT as PLUGIN_PORT_FACT } from "../packages/plugin-figjam/src/status"

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Snapshot = Partial<ReturnType<PluginGateway["list"]>[number]>

function gatewayWith(...snapshots: Array<Snapshot>): PluginGateway {
  return { list: () => snapshots } as unknown as PluginGateway
}

const portFact = (value: string) => ({ label: "Port", value })
const active = (extra: Snapshot = {}): Snapshot => ({
  id: "figjam",
  enabled: true,
  lifecycle: "active",
  status: {
    state: "ready",
    code: "ready",
    summary: "Ready",
    facts: [portFact("4151")],
  },
  ...extra,
})

const reason = (gateway: PluginGateway | undefined) => {
  const state = bridgeAvailability(gateway)
  return state.available ? "available" : state.reason
}

describe("the parent and the plugin agree", () => {
  test("on the status fact that carries the bridge port", () => {
    expect(BRIDGE_PORT_FACT).toBe(PLUGIN_PORT_FACT)
  })

  test("on the profile and how verbose it logs", () => {
    for (const instance of [
      undefined,
      "",
      "co.stuffbucket.maximal",
      "co.stuffbucket.maximal.dev.maximal-ab12cd34ef56",
      "co.stuffbucket.maximal.test.run-1",
      "something-else",
    ]) {
      const env = { MAXIMAL_INSTANCE_ID: instance }
      const theirs = pluginProfile.resolveProfile(env)
      expect(resolveFigjamProfile(env)).toEqual(theirs)
      expect(isVerboseProfile(theirs)).toBe(pluginProfile.isVerbose(theirs))
    }
  })
})

describe("bridgeAvailability", () => {
  test("serves the port the plugin's status reports", () => {
    expect(bridgeAvailability(gatewayWith(active()))).toEqual({
      available: true,
      port: 4151,
    })
  })

  test("is unavailable for each way the plugin can not serve", () => {
    expect(reason(undefined)).toBe("unavailable")
    expect(reason(gatewayWith({ id: "other" }))).toBe("unavailable")
    expect(reason(gatewayWith(active({ enabled: false })))).toBe("disabled")
    expect(reason(gatewayWith(active({ lifecycle: "starting" })))).toBe(
      "starting",
    )
    expect(reason(gatewayWith(active({ lifecycle: "failed" })))).toBe("error")
    expect(
      reason(
        gatewayWith(
          active({
            status: {
              state: "error",
              code: "port-in-use",
              summary: "No free port",
            },
          }),
        ),
      ),
    ).toBe("error")
    // Active but not bound yet (no port in the status).
    expect(
      reason(
        gatewayWith(
          active({
            status: { state: "working", code: "starting", summary: "Starting" },
          }),
        ),
      ),
    ).toBe("starting")
    expect(
      reason(
        gatewayWith(
          active({
            status: {
              state: "ready",
              code: "ready",
              summary: "Ready",
              facts: [portFact("not-a-port")],
            },
          }),
        ),
      ),
    ).toBe("starting")
  })
})

const up: BridgeAvailability = { available: true, port: 4151 }

function discovery(
  options: Parameters<typeof createFigjamRoutes>[0] = {},
): Hono {
  const app = new Hono()
  app.route(
    "/figjam",
    createFigjamRoutes({
      getRequestIp: () => "127.0.0.1",
      availability: () => up,
      profile: { kind: "development", id: "ab12cd34ef56" },
      maximalPort: () => 52_000,
      ...options,
    }),
  )
  return app
}

describe("GET /figjam/bridge.json", () => {
  test("says the bridge is available and where the panel socket is, without any port or path", async () => {
    const res = await discovery().request("/figjam/bridge.json")
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({
      service: "maximal-figjam-bridge",
      schema: 1,
      available: true,
      profile: { kind: "development", id: "ab12cd34ef56" },
      panel: { path: FIGJAM_PANEL_PATH },
    })
    // The bridge's own port, URLs, tokens and file paths are never answered.
    expect(text).not.toContain("4151")
    expect(text).not.toMatch(/ws:\/\/|http:\/\/|token|\/Users|figjam\/pairing/i)
  })

  test("explains why it is unavailable, with a 503", async () => {
    const res = await discovery({
      availability: () => ({ available: false, reason: "disabled" }),
    }).request("/figjam/bridge.json")
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      available: false,
      reason: "disabled",
    })
  })

  test("a non-loopback caller gets a plain 404", async () => {
    const res = await discovery({ getRequestIp: () => "192.168.1.9" }).request(
      "/figjam/bridge.json",
    )
    expect(res.status).toBe(404)
  })

  test("accepts the Figma plugin frame (Origin: null) and no origin, refuses web origins", async () => {
    const app = discovery()
    const get = (origin?: string) =>
      app.request("/figjam/bridge.json", {
        headers: origin === undefined ? {} : { origin },
      })
    expect((await get()).status).toBe(200)
    expect((await get("null")).status).toBe(200)
    expect((await get("https://example.com")).status).toBe(403)
    expect((await get("http://localhost:3000")).status).toBe(403)
  })

  test("a panel built for another profile or port is warned about, not refused", async () => {
    const warn = spyOn(consola, "warn")
    cleanups.push(() => {
      warn.mockRestore()
    })
    const res = await discovery().request(
      "/figjam/bridge.json?profile=0f0f0f0f0f0f&maximalPort=4141&panel=0.10.1",
    )
    expect(res.status).toBe(200)
    const warnings = warn.mock.calls.map((call) => String(call[0]))
    expect(warnings.some((line) => line.includes("0f0f0f0f0f0f"))).toBe(true)
    expect(warnings.some((line) => line.includes("4141"))).toBe(true)
    // Nothing the panel sent is echoed back.
    expect(JSON.stringify(await res.json())).not.toContain("0f0f0f0f0f0f")
  })
})

function frontServer(
  options: Parameters<typeof createFigjamRoutes>[0] = {},
  connect?: Parameters<typeof createFigjamRelay>[0],
) {
  const app = discovery(options)
  const front = serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: 0,
    silent: true,
    bun: { idleTimeout: 0, websocket: createFigjamRelay(connect) },
  })
  cleanups.push(() => front.close(true))
  return front
}

async function frontOrigin(front: ReturnType<typeof frontServer>) {
  await front.ready()
  const url = front.url
  if (!url) throw new Error("no url")
  return new URL(url)
}

function stubBridge() {
  const received: Array<string> = []
  const origins: Array<string | null> = []
  const stub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      origins.push(request.headers.get("origin"))
      return server.upgrade(request) ? undefined : (
          new Response("no", { status: 400 })
        )
    },
    websocket: {
      message(ws, message) {
        const text = String(message)
        received.push(text)
        if (text === "bye") ws.close(4403, "denied")
        else ws.send(`echo:${text}`)
      },
    },
  })
  cleanups.push(() => stub.stop(true))
  return { port: stub.port ?? 0, received, origins }
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("message", (event) => resolve(String(event.data)), {
      once: true,
    })
    ws.addEventListener("error", () => reject(new Error("socket error")), {
      once: true,
    })
  })
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("did not open")), {
      once: true,
    })
  })
}

describe("GET /figjam/plugin (relay)", () => {
  test("relays frames both ways, including ones sent before the bridge socket opens, and its close code", async () => {
    const stub = stubBridge()
    const front = frontServer({
      availability: () => ({ available: true, port: stub.port }),
    })
    const origin = await frontOrigin(front)
    const ws = new WebSocket(
      `ws://127.0.0.1:${origin.port}${FIGJAM_PANEL_PATH}`,
    )
    await opened(ws)
    ws.send("first") // likely ahead of the upstream socket opening
    expect(await nextMessage(ws)).toBe("echo:first")
    ws.send("second")
    expect(await nextMessage(ws)).toBe("echo:second")
    expect(stub.received).toEqual(["first", "second"])
    // The bridge sends no Origin of its own, as the panel's frames arrive via us.
    expect(stub.origins).toEqual([null])

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener("close", (event) =>
        resolve({ code: event.code, reason: event.reason }),
      )
    })
    ws.send("bye")
    // The bridge's pairing close codes reach the panel unchanged.
    expect(await closed).toEqual({ code: 4403, reason: "denied" })
  })

  test("answers 503 while the bridge is unavailable", async () => {
    const front = frontServer({
      availability: () => ({ available: false, reason: "disabled" }),
    })
    const origin = await frontOrigin(front)
    const ws = new WebSocket(
      `ws://127.0.0.1:${origin.port}${FIGJAM_PANEL_PATH}`,
    )
    const failure = await opened(ws).catch((error: unknown) => error)
    expect(String(failure)).toContain("did not open")
  })

  test("a plain GET is told to use a WebSocket, and web origins are refused", async () => {
    const front = frontServer()
    const origin = await frontOrigin(front)
    const plain = await fetch(`http://127.0.0.1:${origin.port}/figjam/plugin`)
    expect(plain.status).toBe(426)
    const foreign = await fetch(
      `http://127.0.0.1:${origin.port}/figjam/plugin`,
      {
        headers: { origin: "https://example.com", upgrade: "websocket" },
      },
    )
    expect(foreign.status).toBe(403)
  })

  test("a panel pairs with the real bridge through the relay", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "figjam-relay-"))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    const bridge = await startBridge({ port: 0, dataDir: dir })
    cleanups.push(() => bridge.stop())
    const front = frontServer({
      availability: () => ({ available: true, port: bridge.port }),
    })
    const origin = await frontOrigin(front)

    const ws = new WebSocket(
      `ws://127.0.0.1:${origin.port}${FIGJAM_PANEL_PATH}`,
    )
    const seen: Array<{ type: string; token?: string }> = []
    ws.addEventListener("message", (event) => {
      seen.push(JSON.parse(String(event.data)) as { type: string })
    })
    await opened(ws)
    ws.send(
      JSON.stringify({
        type: "hello",
        session: "relay-lynx",
        board: { name: "Board", boardId: "relay1", fileKey: "krelay1" },
        plugin: { version: "test" },
        tools: [],
      }),
    )
    const waitFor = async (type: string) => {
      for (let i = 0; i < 200 && !seen.some((m) => m.type === type); i++)
        await Bun.sleep(10)
      expect(seen.map((m) => m.type)).toContain(type)
    }
    await waitFor("pair-pending")
    expect(bridge.status().pending.map((p) => p.name)).toEqual(["relay-lynx"])
    expect((await bridge.approve("relay-lynx")).ok).toBe(true)
    await waitFor("paired")
    // The panel's own token came from the bridge, over the relay, untouched.
    expect(seen.find((m) => m.type === "paired")?.token).toBeString()
    ws.close()
  })
})
