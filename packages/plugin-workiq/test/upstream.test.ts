import type {
  ElicitRequest,
  ToolProgress,
} from "@stuffbucket/maximal-plugin-sdk"

import { afterEach, describe, expect, test } from "bun:test"

import { toWorkIqError, UpstreamHttpError } from "../src/errors"
import { mirrorTools } from "../src/tools"
import { UpstreamConnection } from "../src/upstream/connection"
import { createUpstreamFetch, retryAfterMs } from "../src/upstream/fetch"
import { UpstreamPool } from "../src/upstream/pool"
import { ADA, FakeTokenProvider } from "./fake-tokens"
import { RECORDED_TOOLS, startFakeWorkIq, type FakeWorkIq } from "./fake-workiq"
import { rejection } from "./rejection"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fake(options?: Parameters<typeof startFakeWorkIq>[0]): FakeWorkIq {
  const server = startFakeWorkIq(options)
  cleanups.push(() => server.close())
  return server
}

function harness(
  server: FakeWorkIq,
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
        title: "Ask Work IQ",
        description: "Ask a question about your Microsoft 365 work data.",
        inputSchema: RECORDED_TOOLS[0].inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      {
        name: "fetch",
        description: "Fetch Microsoft Graph entities by path.",
        inputSchema: RECORDED_TOOLS[1].inputSchema,
        outputSchema: RECORDED_TOOLS[1].outputSchema as { type: "object" },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      {
        name: "search_paths",
        description: "Search the catalog of allowed Graph paths.",
        inputSchema: RECORDED_TOOLS[2].inputSchema,
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

describe("upstream MCP client elicitation and retries", () => {
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

  test("retries 429 and 503, honouring Retry-After", async () => {
    const server = fake()
    const { pool, delays } = harness(server)
    await pool.listTools()
    server.fail({
      status: 429,
      rpc: "tools/call",
      headers: { "retry-after": "0" },
    })
    server.fail({ status: 503, rpc: "tools/call" })
    server.fail({ status: 504, rpc: "tools/call" })
    const result = await pool.callTool(
      "search_paths",
      { query: "mail" },
      { signal: signal() },
    )
    expect(result.content).toEqual([
      { type: "text", text: 'search_paths:{"query":"mail"}' },
    ])
    expect(delays).toEqual([0, 2, 3])
    expect(
      server.requests
        .filter((r) => r.rpc === "tools/call")
        .map((r) => r.status),
    ).toEqual([429, 503, 504, 200])
  })

  test("gives up after 5 attempts and reports Work IQ as busy", async () => {
    const server = fake()
    const { pool, delays } = harness(server)
    await pool.listTools()
    server.fail({ status: 503, rpc: "tools/call" }, 5)
    const error = await pool
      .callTool("search_paths", {}, { signal: signal() })
      .catch((e: unknown) => e)
    expect(delays).toEqual([1, 2, 3, 4])
    expect(server.requests.filter((r) => r.rpc === "tools/call")).toHaveLength(
      5,
    )
    const mapped = toWorkIqError(error)
    expect(mapped.code).toBe("busy")
    expect(mapped.message).toBe(
      "Work IQ is busy (HTTP 503). Try again in a moment.",
    )
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
    const license = toWorkIqError(
      await pool.listTools().catch((e: unknown) => e),
    )
    expect(license.code).toBe("license-needed")
    expect(license.status).toBe(403)

    server.fail({
      status: 403,
      rpc: "initialize",
      body: "AADSTS65001: The user or administrator has not consented to use the application.",
    })
    const consent = toWorkIqError(
      await pool.listTools().catch((e: unknown) => e),
    )
    expect(consent.code).toBe("consent-needed")
    expect(consent.message).toContain("ba081686-5d24-4bc6-a0d6-d034ecffed87")

    server.fail({ status: 403, rpc: "initialize" })
    expect(
      toWorkIqError(await pool.listTools().catch((e: unknown) => e)).code,
    ).toBe("access-denied")

    server.token = "rotated"
    const unauthorized = toWorkIqError(
      await pool.listTools().catch((e: unknown) => e),
    )
    expect(unauthorized.code).toBe("signed-out")
    expect(unauthorized.message).toBe(
      "Work IQ did not accept your sign-in (HTTP 401). Sign in again.",
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
    const error = toWorkIqError(
      await connection.connect().catch((e: unknown) => e),
      url,
    )
    await connection.close()
    expect(error.code).toBe("network")
    expect(error.message).toBe(
      `Could not reach Work IQ at ${new URL(url).host}. Check your network connection.`,
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
    await server.setTools([RECORDED_TOOLS[0]])
    const deadline = Date.now() + 3000
    while (changed === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(changed).toBe(1)
    expect((await pool.listTools()).map((tool) => tool.name)).toEqual(["ask"])
  })

  test("retryAfterMs parses seconds and HTTP dates, capped at a minute", () => {
    expect(retryAfterMs(null)).toBeUndefined()
    expect(retryAfterMs("3")).toBe(3000)
    expect(retryAfterMs("9999")).toBe(60_000)
    expect(retryAfterMs(new Date(10_000).toUTCString(), 5_000)).toBe(5000)
    expect(retryAfterMs("soon")).toBeUndefined()
  })

  test("UpstreamHttpError keeps the body for mapping", () => {
    const error = new UpstreamHttpError(
      403,
      "no licence",
      'Bearer error="insufficient_scope"',
    )
    expect(toWorkIqError(error).code).toBe("license-needed")
  })
})
