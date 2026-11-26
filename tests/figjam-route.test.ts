/**
 * `/figjam/*` on Maximal's own origin: the discovery metadata and the panel's
 * WebSocket, relayed to the bridge. A real HTTP server (the same srvx + Bun
 * wiring `run-server.ts` uses) fronts a stand-in bridge socket, and once, the
 * real bridge, with a fake panel that pairs through the relay.
 */

import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"
import type { ServerWebSocket } from "bun"

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { serve } from "srvx"

import { isVerboseProfile, resolveFigjamProfile } from "~/lib/figjam/profile"
import {
  createFigjamRelay,
  FIGJAM_RELAY_BACKPRESSURE_LIMIT,
  FIGJAM_RELAY_PAYLOAD_LIMIT,
  type FigjamRelayData,
} from "~/lib/figjam/relay"
import {
  currentRelayKey,
  FIGJAM_RELAY_KEY_ENV,
  FIGJAM_RELAY_KEY_HEADER,
  relayKeyMatches,
} from "~/lib/figjam/relay-key"
import {
  type BridgeAvailability,
  BRIDGE_PORT_FACT,
  bridgeAvailability,
  createFigjamRoutes,
  FIGJAM_PANEL_PATH,
} from "~/routes/figjam/route"

import { startBridge } from "../packages/figjam-bridge/src/server"
import * as pluginProfile from "../packages/plugin-figjam/src/profile"
import {
  FIGJAM_RELAY_KEY_ENV as PLUGIN_RELAY_KEY_ENV,
  generationRelayKey,
  initializeFigjamRelayKey,
} from "../packages/plugin-figjam/src/relay-key"
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
  test("on the relay key: the plugin's process-lifetime key is the one these routes read and the bridge enforces", () => {
    expect(FIGJAM_RELAY_KEY_ENV).toBe(PLUGIN_RELAY_KEY_ENV)
    const env: Record<string, string | undefined> = {
      [FIGJAM_RELAY_KEY_ENV]: "inherited",
    }
    // Startup replaces whatever was inherited; the routes and every plugin
    // generation then read that one key from the environment.
    const key = initializeFigjamRelayKey(env)
    expect(key).toMatch(/^[\w-]{43}$/)
    expect(currentRelayKey(env)).toBe(key)
    expect(generationRelayKey(env)).toBe(key)
  })

  test("a missing or malformed key is no key: nothing can match it", () => {
    expect(currentRelayKey({})).toBe("")
    expect(currentRelayKey({ [FIGJAM_RELAY_KEY_ENV]: "inherited" })).toBe("")
    expect(relayKeyMatches("", "")).toBe(false)
    expect(relayKeyMatches(undefined, "k".repeat(43))).toBe(false)
    expect(relayKeyMatches("k".repeat(42), "k".repeat(43))).toBe(false)
    expect(relayKeyMatches("k".repeat(43), "k".repeat(43))).toBe(true)
  })

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
const RELAY_KEY = "r".repeat(43)

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
      relayKey: () => RELAY_KEY,
      maximalPort: () => 52_000,
      ...options,
    }),
  )
  return app
}

describe("GET /figjam/bridge.json", () => {
  test("says the bridge is available without exposing its port, path or relay key", async () => {
    const info = spyOn(consola, "info")
    cleanups.push(() => {
      info.mockRestore()
    })
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
    expect(text).not.toContain(RELAY_KEY)
    expect(text).not.toMatch(/ws:\/\/|http:\/\/|token|\/Users|figjam\/pairing/i)
    expect(JSON.stringify(info.mock.calls)).not.toContain(RELAY_KEY)
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

  test("requires the relay key for Origin: null, while no-Origin diagnostics remain usable", async () => {
    const app = discovery()
    const get = (origin?: string, key?: string) =>
      app.request("/figjam/bridge.json", {
        headers: {
          ...(origin === undefined ? {} : { origin }),
          ...(key === undefined ? {} : { [FIGJAM_RELAY_KEY_HEADER]: key }),
        },
      })
    expect((await get()).status).toBe(200)
    expect((await get("null")).status).toBe(403)
    expect((await get("null", "forged")).status).toBe(403)
    expect((await get("null", RELAY_KEY)).status).toBe(200)
    expect((await get("https://example.com", RELAY_KEY)).status).toBe(403)
    expect((await get("http://localhost:3000", RELAY_KEY)).status).toBe(403)
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

/**
 * A stand-in for the bridge's `/plugin` socket that enforces what the real one
 * does (#677): no upgrade unless the offered subprotocol is its relay key, which
 * it then selects.
 */
function stubBridge(key: string = RELAY_KEY) {
  const received: Array<string> = []
  const origins: Array<string | null> = []
  const offered: Array<string> = []
  const refused: Array<string> = []
  const stub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      origins.push(request.headers.get("origin"))
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((value) => value.trim())
      offered.push(...protocols.filter(Boolean))
      if (!protocols.includes(key)) {
        refused.push("no relay key")
        return new Response("forbidden", { status: 403 })
      }
      return (
          server.upgrade(request, {
            headers: { "Sec-WebSocket-Protocol": key },
          })
        ) ?
          undefined
        : new Response("no", { status: 400 })
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
  return { port: stub.port ?? 0, received, origins, offered, refused }
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

class FakeUpstream extends EventTarget {
  binaryType = "blob"
  bufferedAmount = 0
  readyState: number = WebSocket.CONNECTING
  readonly sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = []
  readonly closes: Array<{ code?: number; reason?: string }> = []

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.readyState = WebSocket.CLOSING
  }
}

function fakeDownstream(sendResult = 1): {
  socket: ServerWebSocket<FigjamRelayData>
  closes: Array<{ code: number; reason: string }>
} {
  const closes: Array<{ code: number; reason: string }> = []
  const data: FigjamRelayData = {
    target: "ws://127.0.0.1:4151/plugin",
    protocols: [RELAY_KEY],
    verbose: false,
    queue: [],
    queueBytes: 0,
    closed: false,
  }
  return {
    socket: {
      data,
      send: () => sendResult,
      close: (code: number, reason: string) => {
        closes.push({ code, reason })
      },
    } as unknown as ServerWebSocket<FigjamRelayData>,
    closes,
  }
}

function upstreamClose(code: number, reason = ""): Event {
  const event = new Event("close")
  Object.defineProperties(event, {
    code: { value: code },
    reason: { value: reason },
  })
  return event
}

describe("FigJam relay flow control", () => {
  test("keeps the 64 MiB payload allowance and configures bounded Bun backpressure", () => {
    const relay = createFigjamRelay()
    expect(relay.maxPayloadLength).toBe(FIGJAM_RELAY_PAYLOAD_LIMIT)
    expect(relay.backpressureLimit).toBe(FIGJAM_RELAY_BACKPRESSURE_LIMIT)
    expect(relay.closeOnBackpressureLimit).toBe(true)
  })

  test("closes both peers when the pre-upstream queue exceeds its byte bound", () => {
    const upstream = new FakeUpstream()
    const relay = createFigjamRelay(() => upstream as unknown as WebSocket, {
      backpressureLimit: 8,
    })
    const { socket, closes } = fakeDownstream()
    void relay.open?.(socket)
    void relay.message(socket, "12345678")
    expect(socket.data.queueBytes).toBe(8)
    void relay.message(socket, "x")
    expect(closes).toEqual([
      { code: 1013, reason: "FigJam relay backpressure limit exceeded." },
    ])
    expect(upstream.closes).toEqual([
      { code: 1013, reason: "FigJam relay backpressure limit exceeded." },
    ])
    expect(socket.data.queue).toEqual([])
  })

  test("caps upstream bufferedAmount instead of silently dropping a frame", () => {
    const upstream = new FakeUpstream()
    upstream.readyState = WebSocket.OPEN
    upstream.bufferedAmount = 8
    const relay = createFigjamRelay(() => upstream as unknown as WebSocket, {
      backpressureLimit: 8,
    })
    const { socket, closes } = fakeDownstream()
    void relay.open?.(socket)
    void relay.message(socket, "x")
    expect(upstream.sent).toEqual([])
    expect(closes[0]?.code).toBe(1013)
    expect(upstream.closes[0]?.code).toBe(1013)
  })

  test("an intentional downstream close makes late upstream error and 1006 quiet", () => {
    const warn = spyOn(consola, "warn")
    cleanups.push(() => {
      warn.mockRestore()
    })
    const upstream = new FakeUpstream()
    const relay = createFigjamRelay(() => upstream as unknown as WebSocket)
    const { socket, closes } = fakeDownstream()
    void relay.open?.(socket)
    void relay.close?.(socket, 1000, "done")
    upstream.dispatchEvent(new Event("error"))
    upstream.dispatchEvent(upstreamClose(1006))
    expect(warn).not.toHaveBeenCalled()
    expect(closes).toEqual([])
    expect(upstream.closes).toEqual([{ code: 1000, reason: "done" }])
  })

  test("closes the upstream when Bun reports downstream backpressure", () => {
    const upstream = new FakeUpstream()
    upstream.readyState = WebSocket.OPEN
    const relay = createFigjamRelay(() => upstream as unknown as WebSocket)
    const { socket, closes } = fakeDownstream(-1)
    void relay.open?.(socket)
    const message = new MessageEvent("message", { data: "from bridge" })
    upstream.dispatchEvent(message)
    expect(closes[0]?.code).toBe(1013)
    expect(upstream.closes[0]?.code).toBe(1013)
  })
})

/** The panel's side: the relay key as its subprotocol, from an opaque origin. */
const panelSocket = (url: string, key: string = RELAY_KEY) =>
  new WebSocket(url, { protocols: [key], headers: { origin: "null" } })

async function refused(ws: WebSocket): Promise<void> {
  expect(String(await opened(ws).catch((error: unknown) => error))).toContain(
    "did not open",
  )
}

describe("GET /figjam/plugin (relay)", () => {
  test("relays frames both ways, including ones sent before the bridge socket opens, and its close code", async () => {
    const stub = stubBridge()
    const front = frontServer({
      availability: () => ({ available: true, port: stub.port }),
    })
    const origin = await frontOrigin(front)
    const ws = panelSocket(`ws://127.0.0.1:${origin.port}${FIGJAM_PANEL_PATH}`)
    await opened(ws)
    ws.send("first") // likely ahead of the upstream socket opening
    expect(await nextMessage(ws)).toBe("echo:first")
    ws.send("second")
    expect(await nextMessage(ws)).toBe("echo:second")
    expect(stub.received).toEqual(["first", "second"])
    // The bridge sees no Origin of its own, as the panel's frames arrive via us.
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

  test("the relay offers the bridge its relay key (and only that), after the panel presented it", async () => {
    const stub = stubBridge()
    const front = frontServer({
      availability: () => ({ available: true, port: stub.port }),
    })
    const origin = await frontOrigin(front)
    const ws = panelSocket(`ws://127.0.0.1:${origin.port}${FIGJAM_PANEL_PATH}`)
    await opened(ws)
    ws.send("hello")
    expect(await nextMessage(ws)).toBe("echo:hello")
    expect(stub.offered).toEqual([RELAY_KEY])
    expect(stub.refused).toEqual([])
    ws.close()
  })

  test("answers 503 while the bridge is unavailable", async () => {
    const front = frontServer({
      availability: () => ({ available: false, reason: "disabled" }),
    })
    const origin = await frontOrigin(front)
    await refused(
      panelSocket(`ws://127.0.0.1:${origin.port}${FIGJAM_PANEL_PATH}`),
    )
  })

  test("a plain GET with the key is told to use a WebSocket; web origins, even with the key, are refused", async () => {
    const front = frontServer()
    const origin = await frontOrigin(front)
    const url = `http://127.0.0.1:${origin.port}/figjam/plugin`
    const plain = await fetch(url, {
      headers: { "sec-websocket-protocol": RELAY_KEY },
    })
    expect(plain.status).toBe(426)
    for (const webOrigin of ["https://example.com", "http://localhost:3000"]) {
      const foreign = await fetch(url, {
        headers: {
          origin: webOrigin,
          upgrade: "websocket",
          "sec-websocket-protocol": RELAY_KEY,
        },
      })
      expect(foreign.status).toBe(403)
    }
  })

  test("no socket opens without this process's relay key, whatever the Origin: none, a forged opaque origin, a wrong or truncated key", async () => {
    const stub = stubBridge()
    const front = frontServer({
      availability: () => ({ available: true, port: stub.port }),
    })
    const origin = await frontOrigin(front)
    const url = `ws://127.0.0.1:${origin.port}${FIGJAM_PANEL_PATH}`

    // A forged Origin: null frame offering nothing.
    await refused(new WebSocket(url, { headers: { origin: "null" } }))
    // A local process with no Origin at all (the relay must not lend it the
    // bridge's key): refused too.
    await refused(new WebSocket(url))
    // Wrong, truncated and padded keys.
    for (const wrong of [
      "w".repeat(43),
      RELAY_KEY.slice(0, 42),
      `${RELAY_KEY}x`,
    ]) {
      await refused(panelSocket(url, wrong))
    }
    // None of those reached the bridge.
    expect(stub.origins).toEqual([])
    expect(stub.offered).toEqual([])

    // With the key it opens, and echoes the relay protocol it selected.
    const ws = panelSocket(url)
    await opened(ws)
    expect(ws.protocol).toBe(RELAY_KEY)
    ws.send("authorized")
    expect(await nextMessage(ws)).toBe("echo:authorized")
    ws.close()
  })

  test("with no relay key in this process, nothing opens", async () => {
    const stub = stubBridge()
    const front = frontServer({
      availability: () => ({ available: true, port: stub.port }),
      relayKey: () => "",
    })
    const origin = await frontOrigin(front)
    const url = `ws://127.0.0.1:${origin.port}${FIGJAM_PANEL_PATH}`
    await refused(panelSocket(url))
    await refused(new WebSocket(url))
    expect(stub.origins).toEqual([])
  })

  test("a panel pairs with the real bridge through the relay, and one without the key cannot ask", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "figjam-relay-"))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    const bridge = await startBridge({
      port: 0,
      dataDir: dir,
      relayKey: RELAY_KEY,
    })
    cleanups.push(() => bridge.stop())
    const front = frontServer({
      availability: () => ({ available: true, port: bridge.port }),
    })
    const origin = await frontOrigin(front)
    const url = `ws://127.0.0.1:${origin.port}${FIGJAM_PANEL_PATH}`
    const hello = JSON.stringify({
      type: "hello",
      session: "relay-lynx",
      board: { name: "Board", boardId: "relay1", fileKey: "krelay1" },
      plugin: { version: "test" },
      tools: [],
    })

    // Forged sockets can't create a pairing request, relayed or not.
    for (const forged of [
      new WebSocket(url, { headers: { origin: "null" } }),
      new WebSocket(url),
      panelSocket(url, "w".repeat(43)),
    ]) {
      forged.addEventListener("open", () => forged.send(hello))
      await refused(forged)
    }
    expect(bridge.status().pending).toEqual([])

    const ws = panelSocket(url)
    const seen: Array<{ type: string; token?: string }> = []
    ws.addEventListener("message", (event) => {
      seen.push(JSON.parse(String(event.data)) as { type: string })
    })
    await opened(ws)
    ws.send(hello)
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
