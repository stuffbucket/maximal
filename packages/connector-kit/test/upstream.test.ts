import type {
  ElicitRequest,
  ToolProgress,
} from "@stuffbucket/maximal-plugin-sdk"

import { afterEach, describe, expect, test } from "bun:test"

import {
  toConnectorError,
  UpstreamHttpError,
  type ErrorContext,
} from "../src/errors"
import { ADA, FakeTokenProvider } from "../src/testing/fake-auth"
import {
  SAMPLE_TOOLS,
  startFakeRemoteMcp,
  type FakeRemoteMcp,
} from "../src/testing/fake-server"
import { mirrorTools } from "../src/tools"
import { UpstreamConnection } from "../src/upstream/connection"
import { createUpstreamFetch } from "../src/upstream/fetch"
import { UpstreamPool } from "../src/upstream/pool"
import { rejection } from "./rejection"

const EXAMPLE: ErrorContext = { name: "Example" }
const toError = (error: unknown, endpoint?: string) =>
  toConnectorError(error, endpoint ? { ...EXAMPLE, endpoint } : EXAMPLE)

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fake(
  options?: Parameters<typeof startFakeRemoteMcp>[0],
): FakeRemoteMcp {
  const server = startFakeRemoteMcp(options)
  cleanups.push(() => server.close())
  return server
}

function harness(
  server: FakeRemoteMcp,
  options: { idleMs?: number; onToolsChanged?: () => void } = {},
) {
  const tokens = new FakeTokenProvider(ADA)
  const delays: Array<number> = []
  const upstreamFetch = createUpstreamFetch({
    getToken: (signal) => tokens.getToken(signal),
    retryDelaysMs: [1, 2, 3, 4],
    sleep: (ms) => {
      delays.push(ms)
      return Promise.resolve()
    },
  })
  let connects = 0
  const pool = new UpstreamPool({
    async connect(signal) {
      connects++
      const connection = new UpstreamConnection({
        endpoint: new URL(server.url),
        fetch: upstreamFetch,
        clientInfo: { name: "maximal-test", version: "0.0.0" },
        callTimeoutMs: 5000,
        requestTimeoutMs: 5000,
        ...(options.onToolsChanged ?
          { onToolsChanged: options.onToolsChanged }
        : {}),
      })
      await connection.connect(signal)
      return connection
    },
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  })
  cleanups.push(() => pool.dispose())
  return { tokens, delays, pool, connects: () => connects }
}

const signal = () => new AbortController().signal

describe("upstream MCP client", () => {
  test("sends the bearer token on every request and mirrors tools verbatim", async () => {
    const server = fake()
    const { pool } = harness(server)
    const tools = await pool.listTools()
    expect(server.requests.length).toBeGreaterThan(0)
    for (const request of server.requests)
      expect(request.authorization).toBe("Bearer token-1")

    const mirrored = mirrorTools(tools, () => Promise.resolve({ content: [] }))
    // eslint-disable-next-line @typescript-eslint/unbound-method -- only discarding `execute` to compare the remaining fields
    expect(mirrored.map(({ execute: _execute, ...rest }) => rest)).toEqual([
      {
        name: "ask",
        title: "Ask",
        description: "Ask a question about your work data.",
        inputSchema: SAMPLE_TOOLS[0].inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      {
        name: "fetch",
        description: "Fetch entities by path.",
        inputSchema: SAMPLE_TOOLS[1].inputSchema,
        outputSchema: SAMPLE_TOOLS[1].outputSchema as { type: "object" },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      {
        name: "search_paths",
        description: "Search the catalog of allowed paths.",
        inputSchema: SAMPLE_TOOLS[2].inputSchema,
      },
    ])
  })

  test("skips upstream tools the host contract cannot carry", () => {
    const warnings: Array<string> = []
    const logger = {
      debug() {},
      info() {},
      error() {},
      warn: (message: string) => void warnings.push(message),
    }
    const mirrored = mirrorTools(
      [
        { name: "bad name", inputSchema: { type: "object" } },
        { name: "ok", inputSchema: { type: "object" } },
        { name: "ok", inputSchema: { type: "object" } },
      ],
      () => Promise.resolve({ content: [] }),
      logger,
    )
    expect(mirrored.map((tool) => tool.name)).toEqual(["ok"])
    expect(mirrored[0].description).toBe("")
    expect(warnings).toHaveLength(2)
  })

  test("forwards tools/call and returns the upstream result", async () => {
    const server = fake({
      handlers: {
        fetch: (args) =>
          Promise.resolve({
            content: [{ type: "text", text: "ok" }],
            structuredContent: {
              results: [
                {
                  statusCode: 200,
                  path: (args.entityUrls as Array<string>)[0],
                },
              ],
            },
          }),
      },
    })
    const { pool } = harness(server)
    const result = await pool.callTool(
      "fetch",
      { entityUrls: ["/me"] },
      { signal: signal() },
    )
    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { results: [{ statusCode: 200, path: "/me" }] },
    })
    expect(server.calls()).toEqual([
      { name: "fetch", args: { entityUrls: ["/me"] } },
    ])
  })

  test("passes upstream isError results through", async () => {
    const server = fake({
      handlers: {
        fetch: () =>
          Promise.resolve({
            isError: true,
            content: [{ type: "text", text: "Access denied for GET path" }],
          }),
      },
    })
    const { pool } = harness(server)
    expect(
      await pool.callTool(
        "fetch",
        { entityUrls: ["/x"] },
        { signal: signal() },
      ),
    ).toEqual({
      isError: true,
      content: [{ type: "text", text: "Access denied for GET path" }],
    })
  })

  test("relays upstream progress notifications", async () => {
    const server = fake({
      handlers: {
        ask: async (_args, ctx, { progressToken }) => {
          if (progressToken !== undefined) {
            await ctx.mcpReq.notify({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: 1,
                total: 2,
                message: "Searching mail",
              },
            })
            await ctx.mcpReq.notify({
              method: "notifications/progress",
              params: { progressToken, progress: 2, total: 2 },
            })
          }
          return { content: [{ type: "text", text: "answer" }] }
        },
      },
    })
    const { pool } = harness(server)
    const updates: Array<ToolProgress> = []
    const result = await pool.callTool(
      "ask",
      { question: "q" },
      { signal: signal(), progress: (update) => updates.push(update) },
    )
    expect(result.content).toEqual([{ type: "text", text: "answer" }])
    expect(updates).toEqual([
      { progress: 1, total: 2, message: "Searching mail" },
      { progress: 2, total: 2 },
    ])
  })
})

describe("upstream MCP client elicitation", () => {
  test("relays upstream elicitation to the caller, and declines when the caller cannot elicit", async () => {
    const server = fake({
      handlers: {
        ask: async (_args, ctx) => {
          // The fake issues a 2025-era push elicitation, which is what the pool relays.
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          const answer = await ctx.mcpReq.elicitInput({
            mode: "form",
            message: "Share this file?",
            requestedSchema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
            },
          })
          return { content: [{ type: "text", text: JSON.stringify(answer) }] }
        },
      },
    })
    const { pool } = harness(server)
    const asked: Array<ElicitRequest> = []
    const accepted = await pool.callTool(
      "ask",
      { question: "q" },
      {
        signal: signal(),
        sessionId: "s1",
        elicit: (request) => {
          asked.push(request)
          return Promise.resolve({
            action: "accept",
            content: { ok: true, ignored: { nested: 1 } },
          })
        },
      },
    )
    expect(asked).toEqual([
      {
        message: "Share this file?",
        requestedSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    ])
    expect(JSON.parse((accepted.content[0] as { text: string }).text)).toEqual({
      action: "accept",
      content: { ok: true },
    })

    const declined = await pool.callTool(
      "ask",
      { question: "q" },
      { signal: signal() },
    )
    expect(JSON.parse((declined.content[0] as { text: string }).text)).toEqual({
      action: "decline",
    })
  })
})

describe("upstream fetch retries", () => {
  test("retries throttled protocol requests (tools/list), waiting at least the fallback", async () => {
    const server = fake()
    const { pool, delays } = harness(server)
    await pool.listTools()
    server.fail({
      status: 429,
      rpc: "tools/list",
      headers: { "retry-after": "0" },
    })
    server.fail({ status: 503, rpc: "tools/list" })
    server.fail({ status: 504, rpc: "tools/list" })
    expect(await pool.listTools()).toHaveLength(SAMPLE_TOOLS.length)
    // max(Retry-After 0, fallback 1 ms), then the fallback schedule.
    expect(delays).toEqual([1, 2, 3])
    expect(
      server.requests
        .filter((r) => r.rpc === "tools/list")
        .map((r) => r.status),
    ).toEqual([200, 429, 503, 504, 200])
  })

  test("gives up on a protocol request after 5 attempts and reports the service as busy", async () => {
    const server = fake()
    const { pool, delays } = harness(server)
    await pool.listTools()
    server.fail({ status: 503, rpc: "tools/list" }, 5)
    const error = await pool.listTools().catch((e: unknown) => e)
    expect(delays).toEqual([1, 2, 3, 4])
    expect(server.requests.filter((r) => r.rpc === "tools/list")).toHaveLength(
      6,
    )
    const mapped = toError(error)
    expect(mapped.code).toBe("busy")
    expect(mapped.message).toBe(
      "Example is busy (HTTP 503). Try again in a moment.",
    )
  })

  test("never retries a throttled tools/call itself (the guarded upstream owns that)", async () => {
    const server = fake()
    const throttles: Array<[number, number | undefined]> = []
    const tokens = new FakeTokenProvider(ADA)
    const upstreamFetch = createUpstreamFetch({
      getToken: (s) => tokens.getToken(s),
      retryDelaysMs: [1, 2, 3, 4],
      sleep: () => Promise.resolve(),
      onThrottle: (status, ms) => void throttles.push([status, ms]),
    })
    const pool = new UpstreamPool({
      async connect(s) {
        const connection = new UpstreamConnection({
          endpoint: new URL(server.url),
          fetch: upstreamFetch,
          clientInfo: { name: "t", version: "0" },
          callTimeoutMs: 5000,
          requestTimeoutMs: 5000,
        })
        await connection.connect(s)
        return connection
      },
    })
    cleanups.push(() => pool.dispose())
    await pool.listTools()
    server.fail({
      status: 503,
      rpc: "tools/call",
      headers: { "retry-after": "7" },
    })
    const error = await pool
      .callTool("create_entity", {}, { signal: signal() })
      .catch((e: unknown) => e)
    expect(server.requests.filter((r) => r.rpc === "tools/call")).toHaveLength(
      1,
    )
    const mapped = toError(error)
    expect(mapped.status).toBe(503)
    expect(mapped.message).toBe(
      "Example is busy (HTTP 503). Try again in about 7 s.",
    )
    expect(mapped.busy).toEqual({ reason: "throttled", retryAfterMs: 7000 })
    // A throttled tools/call is the guarded upstream's to report; protocol throttles are reported here.
    expect(throttles).toEqual([])
    server.fail({
      status: 429,
      rpc: "tools/list",
      headers: { "retry-after": "2" },
    })
    await pool.listTools()
    expect(throttles).toEqual([[429, 2000]])
  })

  test("aborting the call aborts the retry wait", async () => {
    const server = fake()
    const tokens = new FakeTokenProvider(ADA)
    const upstreamFetch = createUpstreamFetch({
      getToken: (s) => tokens.getToken(s),
      retryDelaysMs: [60_000],
    })
    server.fail({ status: 429 })
    const controller = new AbortController()
    const pending = upstreamFetch(server.url, {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 20)
    const started = Date.now()
    expect(await rejection(pending)).toBeInstanceOf(Error)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("maps 401/403 bodies to clear messages", async () => {
    const server = fake()
    const { pool } = harness(server)
    server.fail({
      status: 403,
      rpc: "initialize",
      body: '{"error":{"code":"Forbidden","message":"User does not have a valid license for this service."}}',
    })
    const license = toError(await pool.listTools().catch((e: unknown) => e))
    expect(license.code).toBe("license-needed")
    expect(license.status).toBe(403)

    server.fail({
      status: 403,
      rpc: "initialize",
      body: "AADSTS65001: The user or administrator has not consented to use the application.",
    })
    const consent = toError(await pool.listTools().catch((e: unknown) => e))
    expect(consent.code).toBe("consent-needed")
    expect(consent.message).toBe(
      "Your organization has not approved Example. An administrator must grant consent before you can use it.",
    )
    expect(
      toConnectorError(consent.cause, {
        ...EXAMPLE,
        wording: {
          messages: { "consent-needed": "Ask IT to approve Example." },
        },
      }).message,
    ).toBe("Ask IT to approve Example.")

    server.fail({ status: 403, rpc: "initialize" })
    expect(toError(await pool.listTools().catch((e: unknown) => e)).code).toBe(
      "not-entitled",
    )

    server.token = "rotated"
    const unauthorized = toError(
      await pool.listTools().catch((e: unknown) => e),
    )
    expect(unauthorized.code).toBe("signed-out")
    expect(unauthorized.message).toBe(
      "Example did not accept your sign-in (HTTP 401). Sign in again.",
    )
  })

  test("reports an unreachable endpoint as a network error", async () => {
    const server = fake()
    const url = server.url
    await server.close()
    const tokens = new FakeTokenProvider(ADA)
    const connection = new UpstreamConnection({
      endpoint: new URL(url),
      fetch: createUpstreamFetch({ getToken: (s) => tokens.getToken(s) }),
      clientInfo: { name: "t", version: "0" },
      callTimeoutMs: 1000,
      requestTimeoutMs: 1000,
    })
    const error = toError(
      await connection.connect().catch((e: unknown) => e),
      url,
    )
    await connection.close()
    expect(error.code).toBe("network")
    expect(error.message).toBe(
      `Could not reach Example at ${new URL(url).host}. Check your network connection.`,
    )
  })
})

describe("upstream MCP sessions", () => {
  test("uses one upstream session per downstream session, plus a shared one", async () => {
    const server = fake()
    const { pool, connects } = harness(server)
    await pool.callTool(
      "search_paths",
      {},
      { signal: signal(), sessionId: "a" },
    )
    await pool.callTool(
      "search_paths",
      {},
      { signal: signal(), sessionId: "a" },
    )
    await pool.callTool(
      "search_paths",
      {},
      { signal: signal(), sessionId: "b" },
    )
    await pool.callTool("search_paths", {}, { signal: signal() })
    await pool.listTools()
    expect(connects()).toBe(3)
    expect(server.sessionCount).toBe(3)
    const callSessions = server.requests
      .filter((r) => r.rpc === "tools/call")
      .map((r) => r.sessionId)
    expect(callSessions[0]).toBe(callSessions[1])
    expect(new Set(callSessions).size).toBe(3)
  })

  test("closes idle sessions and reconnects when upstream forgot the session", async () => {
    const server = fake()
    const { pool, connects } = harness(server, { idleMs: 60_000 })
    await pool.callTool(
      "search_paths",
      {},
      { signal: signal(), sessionId: "a" },
    )
    expect(pool.size).toBe(1)
    await pool.sweep(Date.now() + 60_001)
    expect(pool.size).toBe(0)
    await Bun.sleep(10)
    expect(server.sessionCount).toBe(0)

    await pool.callTool(
      "search_paths",
      {},
      { signal: signal(), sessionId: "a" },
    )
    await server.expireSessions()
    const result = await pool.callTool(
      "search_paths",
      { query: "x" },
      { signal: signal(), sessionId: "a" },
    )
    expect(result.isError).toBeUndefined()
    expect(connects()).toBe(3)
  })

  test("notifies when the upstream tool list changes", async () => {
    const server = fake()
    let changed = 0
    const { pool } = harness(server, { onToolsChanged: () => changed++ })
    await pool.listTools()
    await Bun.sleep(50)
    await server.setTools([SAMPLE_TOOLS[0]])
    const deadline = Date.now() + 3000
    while (changed === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(changed).toBe(1)
    expect((await pool.listTools()).map((tool) => tool.name)).toEqual(["ask"])
  })

  test("UpstreamHttpError keeps the body for mapping", () => {
    const error = new UpstreamHttpError(403, "no licence", {
      wwwAuthenticate: 'Bearer error="insufficient_scope"',
    })
    expect(toError(error).code).toBe("license-needed")
  })
})

/** A stand-in pool connection the test drives directly. */
function stub(name: string) {
  let closing: Promise<void> | undefined
  const connection = {
    name,
    lastUsed: 0,
    busy: false,
    closes: 0,
    failNext: undefined as Error | undefined,
    holdClose(until: Promise<void>) {
      closing = until
    },
    async close() {
      connection.closes++
      await closing
    },
    listTools: () => Promise.resolve([]),
    callTool() {
      const failure = connection.failNext
      connection.failNext = undefined
      return failure === undefined ?
          Promise.resolve({ content: [] })
        : Promise.reject(failure)
    },
  }
  return connection
}
type Stub = ReturnType<typeof stub>

function stubPool(options: { onSharedReconnect?: () => void } = {}) {
  const made: Array<Stub> = []
  const pool = new UpstreamPool({
    connect: () => {
      const connection = stub(`c${made.length}`)
      made.push(connection)
      return Promise.resolve(connection as unknown as UpstreamConnection)
    },
    idleMs: 1000,
    ...options,
  })
  cleanups.push(() => pool.dispose())
  return { pool, made }
}

describe("upstream session pool", () => {
  test("a sweep leaves a connection alone that a call picked up meanwhile", async () => {
    const { pool, made } = stubPool()
    await pool.callTool("t", {}, { signal: signal(), sessionId: "a" })
    await pool.callTool("t", {}, { signal: signal(), sessionId: "b" })
    const [a, b] = made
    let release!: () => void
    a.holdClose(new Promise<void>((resolve) => (release = resolve)))
    const sweeping = pool.sweep(Date.now() + 10_000)
    while (a.closes === 0) await Bun.sleep(1)
    // While the sweep closes `a`, a call starts on `b`.
    b.busy = true
    release()
    await sweeping
    expect(b.closes).toBe(0)
    expect(pool.size).toBe(1)
  })

  test("the shared connection (it carries list_changed) is never idle-swept", async () => {
    const { pool, made } = stubPool()
    await pool.listTools()
    await pool.callTool("t", {}, { signal: signal(), sessionId: "a" })
    await pool.sweep(Date.now() + 10_000)
    expect(made.map((connection) => connection.closes)).toEqual([0, 1])
    expect(pool.size).toBe(1)
  })

  test("a reopened shared connection asks for the tool list again", async () => {
    let relists = 0
    const { pool, made } = stubPool({ onSharedReconnect: () => relists++ })
    await pool.listTools()
    await pool.callTool("t", {}, { signal: signal() })
    expect(relists).toBe(0)
    // The upstream forgot the shared session: reconnect once, then re-list.
    made[0].failNext = Object.assign(new Error("gone"), { status: 404 })
    await pool.callTool("t", {}, { signal: signal() })
    await Bun.sleep(0)
    expect(made).toHaveLength(2)
    expect(relists).toBe(1)
    // A tools/list that opens it is the re-list itself.
    await pool.closeAll()
    await pool.listTools()
    await Bun.sleep(0)
    expect(relists).toBe(1)
  })
})

describe("bearer token origin", () => {
  test("the token goes only to the endpoint's origin, never along a redirect elsewhere", async () => {
    const seen: Array<{ url: string; auth: string | null; redirect?: string }> =
      []
    const upstreamFetch = createUpstreamFetch({
      getToken: () => Promise.resolve("secret"),
      origin: "https://mcp.example.com",
      baseFetch: (url, init) => {
        const target = new URL(url)
        seen.push({
          url: target.href,
          auth: new Headers(init?.headers).get("authorization"),
          ...(init?.redirect ? { redirect: init.redirect } : {}),
        })
        const location: Record<string, string> = {
          "/same": "/mcp",
          "/away": "https://evil.example.net/collect",
        }
        const to = location[target.pathname]
        return Promise.resolve(
          to ?
            new Response(null, { status: 307, headers: { location: to } })
          : new Response("ok"),
        )
      },
    })
    await upstreamFetch("https://evil.example.net/mcp", { method: "POST" })
    await upstreamFetch("http://mcp.example.com/mcp", { method: "POST" })
    const same = await upstreamFetch("https://mcp.example.com/same", {
      method: "POST",
    })
    const away = await upstreamFetch("https://mcp.example.com/away", {
      method: "POST",
    })
    expect(same.status).toBe(200)
    expect(away.status).toBe(307)
    expect(seen).toEqual([
      { url: "https://evil.example.net/mcp", auth: null },
      { url: "http://mcp.example.com/mcp", auth: null },
      {
        url: "https://mcp.example.com/same",
        auth: "Bearer secret",
        redirect: "manual",
      },
      {
        url: "https://mcp.example.com/mcp",
        auth: "Bearer secret",
        redirect: "manual",
      },
      {
        url: "https://mcp.example.com/away",
        auth: "Bearer secret",
        redirect: "manual",
      },
    ])
  })
})
