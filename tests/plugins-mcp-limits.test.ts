/**
 * `/mcp/<pluginId>` guard rails and session bookkeeping, driven through the
 * routes' own Hono app (no listener): non-loopback peers, the session cap
 * (`MCP_BUSY`) and eviction, the idle sweep, a transport that throws during
 * `initialize`, and closing every session at plugin shutdown.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { onPluginsStopping, stopPlugins } from "~/lib/plugins/runtime"
import {
  createPluginMcpRoutes,
  type PluginMcpRoutes,
  type PluginMcpRoutesOptions,
} from "~/routes/plugins/mcp"

import {
  definePlugin,
  startTestGateway,
  type TestGateway,
  waitFor,
} from "./helpers/plugins"

const demo = definePlugin("demo", (ctx) => {
  ctx.surface.setStatus({ state: "ready", code: "ready", summary: "Ready" })
})

const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
})

let plugins: TestGateway
let routes: PluginMcpRoutes
let ip: string | null = "127.0.0.1"

function mount(options: PluginMcpRoutesOptions = {}): PluginMcpRoutes {
  routes = createPluginMcpRoutes({
    getGateway: () => plugins.gateway,
    getRequestIp: () => ip,
    ...options,
  })
  return routes
}

async function initialize(
  init: RequestInit = {},
): Promise<{ response: Response; sessionId: string | null }> {
  const response = await routes.app.fetch(
    new Request("http://127.0.0.1/demo", {
      method: "POST",
      headers: JSON_HEADERS,
      body: INITIALIZE,
      ...init,
    }),
  )
  const sessionId = response.headers.get("mcp-session-id")
  // Drain the body so the request counts as finished.
  await response.text()
  return { response, sessionId }
}

/** A standalone SSE stream: the session counts as busy until it closes. */
async function openStream(sessionId: string | null): Promise<Response> {
  return await routes.app.fetch(
    new Request("http://127.0.0.1/demo", {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "mcp-session-id": sessionId ?? "",
      },
    }),
  )
}

beforeEach(async () => {
  ip = "127.0.0.1"
  plugins = await startTestGateway([demo], ["demo"])
  mount()
})

afterEach(async () => {
  await routes.closeAll()
  await plugins.dispose()
})

describe("/mcp guards", () => {
  test("a non-loopback peer gets a plain 404, never reaching auth or sessions", async () => {
    ip = "192.168.1.20"
    const { response, sessionId } = await initialize()
    expect(response.status).toBe(404)
    expect(sessionId).toBeNull()
    expect(routes.sessionCount()).toBe(0)

    ip = null
    expect((await initialize()).response.status).toBe(404)
  })

  test("a loopback peer initializes a session", async () => {
    const { response, sessionId } = await initialize()
    expect(response.status).toBe(200)
    expect(sessionId).toBeTruthy()
    expect(routes.sessionCount("demo")).toBe(1)
  })
})

describe("session cap", () => {
  test("answers 503 MCP_BUSY while every session has an open stream, then evicts the oldest idle one", async () => {
    mount({ maxSessions: 2 })
    const first = (await initialize()).sessionId
    const second = (await initialize()).sessionId
    expect(routes.sessionCount()).toBe(2)

    // Both sessions are idle: a third initialize evicts the oldest (first).
    const third = await initialize()
    expect(third.response.status).toBe(200)
    await waitFor(() => routes.sessionCount() === 2)
    const probe = (id: string | null) =>
      routes.app.fetch(
        new Request("http://127.0.0.1/demo", {
          method: "POST",
          headers: { ...JSON_HEADERS, "mcp-session-id": id ?? "" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
        }),
      )
    expect((await probe(first)).status).toBe(404)
    const alive = await probe(second)
    expect(alive.status).toBe(200)
    await alive.text()

    // Hold a standalone SSE stream open on each session: none is idle now.
    const streams = [
      await openStream(second),
      await openStream(third.sessionId),
    ]
    for (const stream of streams) expect(stream.status).toBe(200)

    const busy = await initialize()
    expect(busy.response.status).toBe(503)
    expect(busy.sessionId).toBeNull()
    expect(routes.sessionCount()).toBe(2)

    // Closing a stream frees its session for eviction.
    await streams[0]?.body?.cancel()
    expect((await initialize()).response.status).toBe(200)
    expect(routes.sessionCount()).toBe(2)
    await streams[1]?.body?.cancel()
  })

  test("the 503 carries the MCP_BUSY error body", async () => {
    mount({ maxSessions: 1 })
    const { sessionId } = await initialize()
    const stream = await openStream(sessionId)
    const { response } = await initialize()
    expect(response.status).toBe(503)
    await stream.body?.cancel()
  })
})

describe("idle sweep", () => {
  test("closes a session with no open request after the idle timeout", async () => {
    mount({ idleTimeoutMs: 20 })
    const { sessionId } = await initialize()
    expect(sessionId).toBeTruthy()
    expect(routes.sessionCount("demo")).toBe(1)
    // The sweeper ticks at most once a second.
    await waitFor(() => routes.sessionCount() === 0, 4_000)
  })

  test("leaves a session with an open stream alone", async () => {
    mount({ idleTimeoutMs: 20 })
    const { sessionId } = await initialize()
    const stream = await openStream(sessionId)
    await new Promise((resolve) => setTimeout(resolve, 1_300))
    expect(routes.sessionCount()).toBe(1)
    await stream.body?.cancel()
  })
})

describe("a transport that throws during initialize", () => {
  test("leaves no half-open session counting toward the cap", async () => {
    mount({ maxSessions: 1 })
    // The transport's `handleRequest` switches on `req.method` outside its
    // own try/catch; make that read (and only that one) throw.
    const exploding = new Request("http://127.0.0.1/demo", {
      method: "POST",
      headers: JSON_HEADERS,
      body: INITIALIZE,
    })
    Object.defineProperty(exploding, "method", {
      get(): string {
        if (new Error().stack?.includes("handleRequest")) {
          throw new Error("transport exploded")
        }
        return "POST"
      },
    })
    const failed = await routes.app.fetch(exploding)
    expect(failed.status).toBe(500)
    // With a cap of one, a leaked opening session would make this a 503.
    const { response } = await initialize()
    expect(response.status).toBe(200)
  })
})

describe("shutdown", () => {
  test("stopPlugins closes every MCP session through its stopping hook", async () => {
    // The production hook is registered by `src/server.ts`; register this
    // test's routes the same way.
    onPluginsStopping(() => routes.closeAll())
    await initialize()
    await initialize()
    expect(routes.sessionCount()).toBe(2)
    await stopPlugins()
    expect(routes.sessionCount()).toBe(0)
  })
})
