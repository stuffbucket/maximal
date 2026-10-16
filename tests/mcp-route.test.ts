/**
 * /mcp/<id> — main-port gateway to the isolated MCP broker.
 *
 * Uses the REAL config module (the preload points COPILOT_API_HOME at a temp
 * dir) and injects the broker upstream, peer address, and upstream fetch, so
 * no module mocks are needed.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { AppConfig } from "~/lib/config/config"

import { writeConfig } from "~/lib/config/config"
import { createMcpRoutes } from "~/routes/mcp/route"

const UPSTREAM = { origin: "http://127.0.0.1:49152", apiKey: "internal-key" }
const ENDPOINT_KEY = "mcp-endpoint-key"
const GENERAL_KEY = "general-client-key"

interface ForwardedRequest {
  url: string
  headers: Headers
  body: string
}

function brokerConfig(
  server: Record<string, unknown> = {},
  auth: AppConfig["auth"] = {},
): AppConfig {
  return {
    auth,
    mcpBroker: {
      enabled: true,
      limits: { httpBodyBytes: 1024 },
      servers: [
        {
          id: "fixture",
          label: "Fixture",
          transport: { type: "stdio", command: "fixture" },
          ...server,
        },
      ],
    },
  }
}

function buildApp(
  options: {
    ip?: string
    upstream?: typeof UPSTREAM | undefined
    respond?: (request: ForwardedRequest) => Response | Promise<Response>
    beforeNewSession?: () => Promise<void>
  } = {},
) {
  const forwarded: Array<ForwardedRequest> = []
  const routes = createMcpRoutes({
    ...(options.beforeNewSession ?
      { beforeNewSession: options.beforeNewSession }
    : {}),
    getRequestIp: () => options.ip ?? "127.0.0.1",
    getUpstream: () => ("upstream" in options ? options.upstream : UPSTREAM),
    fetchUpstream: (async (url: string, init: RequestInit) => {
      const request = {
        url,
        headers: new Headers(init.headers),
        body: init.body ? await new Response(init.body).text() : "",
      }
      forwarded.push(request)
      return options.respond ?
          options.respond(request)
        : new Response('{"ok":true}', {
            status: 200,
            headers: {
              "content-type": "application/json",
              "access-control-allow-origin": "*",
              "mcp-session-id": "session-1",
            },
          })
    }) as typeof fetch,
  })
  const app = new Hono()
  app.route("/mcp", routes)
  return { app, forwarded }
}

const post = (headers: Record<string, string> = {}, body = "{}") => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body,
})

beforeEach(() => {
  writeConfig(brokerConfig())
})

afterAll(() => {
  writeConfig({})
})

describe("/mcp/<id> new sessions", () => {
  test("re-reads a catalog server's newest install before a session opens", async () => {
    writeConfig(brokerConfig({ catalog: "workiq" }))
    const calls: Array<string> = []
    const { app, forwarded } = buildApp({
      beforeNewSession: () => {
        calls.push("refresh")
        // The session request is forwarded only after this finished.
        expect(forwarded).toHaveLength(0)
        return Promise.resolve()
      },
    })
    expect((await app.request("/mcp/fixture", post())).status).toBe(200)
    expect(calls).toEqual(["refresh"])

    // Requests inside a session don't re-check.
    await app.request("/mcp/fixture", post({ "mcp-session-id": "session-1" }))
    await app.request("/mcp/fixture", { method: "GET" })
    expect(calls).toEqual(["refresh"])
  })

  test("doesn't re-check servers that weren't added from the catalog", async () => {
    const calls: Array<string> = []
    const { app } = buildApp({
      beforeNewSession: () => {
        calls.push("refresh")
        return Promise.resolve()
      },
    })
    await app.request("/mcp/fixture", post())
    expect(calls).toEqual([])
  })

  test("a failed check still forwards the session", async () => {
    writeConfig(brokerConfig({ catalog: "workiq" }))
    const { app, forwarded } = buildApp({
      beforeNewSession: () => Promise.reject(new Error("probe failed")),
    })
    expect((await app.request("/mcp/fixture", post())).status).toBe(200)
    expect(forwarded).toHaveLength(1)
  })
})

describe("/mcp/<id> caller checks", () => {
  test("hides the route from non-loopback peers", async () => {
    const { app, forwarded } = buildApp({ ip: "192.168.1.20" })
    const res = await app.request("/mcp/fixture", post())
    expect(res.status).toBe(404)
    expect(forwarded).toHaveLength(0)
  })

  test("rejects a foreign Origin and accepts a loopback one", async () => {
    const { app } = buildApp()
    expect(
      (
        await app.request(
          "/mcp/fixture",
          post({ origin: "https://evil.example" }),
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(
          "/mcp/fixture",
          post({ origin: "http://localhost:4141" }),
        )
      ).status,
    ).toBe(200)
  })

  test("404s an unknown, disabled, or broker-disabled endpoint", async () => {
    const { app } = buildApp()
    expect((await app.request("/mcp/missing", post())).status).toBe(404)

    writeConfig(brokerConfig({ enabled: false }))
    expect((await app.request("/mcp/fixture", post())).status).toBe(404)

    writeConfig({ ...brokerConfig(), mcpBroker: { enabled: false } })
    expect((await app.request("/mcp/fixture", post())).status).toBe(404)
  })
})

describe("/mcp/<id> authentication", () => {
  test("an endpoint key is required and accepted as Bearer or x-api-key", async () => {
    writeConfig(brokerConfig({ apiKey: ENDPOINT_KEY }))
    const { app, forwarded } = buildApp()

    expect((await app.request("/mcp/fixture", post())).status).toBe(401)
    expect(
      (
        await app.request(
          "/mcp/fixture",
          post({ authorization: "Bearer wrong" }),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await app.request(
          "/mcp/fixture",
          post({ authorization: `Bearer ${ENDPOINT_KEY}` }),
        )
      ).status,
    ).toBe(200)
    expect(
      (await app.request("/mcp/fixture", post({ "x-api-key": ENDPOINT_KEY })))
        .status,
    ).toBe(200)
    expect(forwarded).toHaveLength(2)
  })

  test("a general main-port key does not open an endpoint with its own key", async () => {
    writeConfig(
      brokerConfig(
        { apiKey: ENDPOINT_KEY },
        { enforce: true, apiKeys: [GENERAL_KEY] },
      ),
    )
    const { app } = buildApp()
    const res = await app.request(
      "/mcp/fixture",
      post({ authorization: `Bearer ${GENERAL_KEY}` }),
    )
    expect(res.status).toBe(401)
  })

  test("without an endpoint key, main-port rules apply", async () => {
    const { app } = buildApp()
    expect((await app.request("/mcp/fixture", post())).status).toBe(200)

    writeConfig(brokerConfig({}, { enforce: true, apiKeys: [GENERAL_KEY] }))
    expect((await app.request("/mcp/fixture", post())).status).toBe(401)
    expect(
      (
        await app.request(
          "/mcp/fixture",
          post({ authorization: `Bearer ${GENERAL_KEY}` }),
        )
      ).status,
    ).toBe(200)
  })
})

describe("/mcp/<id> forwarding", () => {
  test("forwards to the broker with only the internal credential", async () => {
    writeConfig(brokerConfig({ apiKey: ENDPOINT_KEY }))
    const { app, forwarded } = buildApp()
    const res = await app.request(
      "/mcp/fixture?probe=1",
      post(
        {
          authorization: `Bearer ${ENDPOINT_KEY}`,
          origin: "http://127.0.0.1:4141",
          "mcp-session-id": "session-1",
        },
        '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      ),
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"ok":true}')
    expect(res.headers.get("mcp-session-id")).toBe("session-1")
    expect(res.headers.get("access-control-allow-origin")).toBeNull()

    const [request] = forwarded
    expect(request.url).toBe("http://127.0.0.1:49152/mcp/fixture?probe=1")
    expect(request.headers.get("authorization")).toBe("Bearer internal-key")
    expect(request.headers.get("origin")).toBeNull()
    expect(request.headers.get("mcp-session-id")).toBe("session-1")
    expect(request.body).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}')
  })

  test("returns 503 while the broker is not ready", async () => {
    const { app } = buildApp({ upstream: undefined })
    const res = await app.request("/mcp/fixture", post())
    expect(res.status).toBe(503)
  })

  test("rejects a declared body over the configured limit", async () => {
    const { app, forwarded } = buildApp()
    const res = await app.request(
      "/mcp/fixture",
      post({ "content-length": "2048" }, "x".repeat(2048)),
    )
    expect(res.status).toBe(413)
    expect(forwarded).toHaveLength(0)
  })

  test("returns 502 when the broker cannot be reached", async () => {
    const { app } = buildApp({
      respond: () => {
        throw new Error("connection refused")
      },
    })
    expect((await app.request("/mcp/fixture", post())).status).toBe(502)
  })

  test("releases capacity after completed, failed, and broken streams", async () => {
    let call = 0
    const { app } = buildApp({
      respond: () => {
        call += 1
        if (call % 3 === 0) throw new Error("broker gone")
        if (call % 3 === 1) return new Response("done")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"))
              controller.error(new Error("broker died mid-stream"))
            },
          }),
        )
      },
    })

    for (let index = 0; index < 60; index += 1) {
      const res = await app.request("/mcp/fixture", post())
      expect(res.status).not.toBe(503)
      await res.text().catch(() => undefined)
    }
  })
})
