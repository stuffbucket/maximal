/**
 * The guarded upstream over real MCP sessions (fake server on loopback,
 * virtual clock): one retry owner for tools/call, result-level throttling,
 * batch splitting and partial re-issue.
 */
import type { ToolResult } from "@stuffbucket/maximal-plugin-sdk"

import { afterEach, describe, expect, test } from "bun:test"

import { ConnectorError, toConnectorError } from "../src/errors"
import { FakeClock } from "../src/testing/clock"
import { ADA, FakeTokenProvider } from "../src/testing/fake-auth"
import {
  startFakeRemoteMcp,
  type FakeRemoteMcp,
  type FakeRemoteMcpOptions,
} from "../src/testing/fake-server"
import { UpstreamConnection } from "../src/upstream/connection"
import { createUpstreamFetch } from "../src/upstream/fetch"
import { GuardedUpstream } from "../src/upstream/guarded"
import { ConnectorLimiter } from "../src/upstream/limiter"
import { resolveLimits } from "../src/upstream/limits"
import { UpstreamPool } from "../src/upstream/pool"
import { cooldownFor } from "../src/upstream/retry"
import { failure, HOOKS } from "./guard-harness"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const FETCH_TOOL = {
  name: "fetch",
  inputSchema: { type: "object" as const },
  annotations: { readOnlyHint: true },
}
const CREATE_TOOL = {
  name: "create_entity",
  inputSchema: { type: "object" as const },
}

/** Canned `fetch`: one 200 entry per path, except `/missing` (404). */
function fetchAnswer(args: Record<string, unknown>) {
  const paths = args.entityUrls as Array<string>
  const value = {
    results: paths.map((path) =>
      path === "/missing" ?
        { statusCode: 404, data: null, error: { code: "itemNotFound" } }
      : { statusCode: 200, data: { path }, error: null },
    ),
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  }
}

async function setup(options: FakeRemoteMcpOptions = {}, limits = {}) {
  const clock = new FakeClock()
  const server = startFakeRemoteMcp({
    tools: [FETCH_TOOL, CREATE_TOOL],
    results: { fetch: fetchAnswer },
    now: clock.now,
    ...options,
  })
  cleanups.push(() => server.close())
  const resolved = resolveLimits([limits])
  const limiter = new ConnectorLimiter(resolved, clock)
  const tokens = new FakeTokenProvider(ADA)
  const upstreamFetch = createUpstreamFetch({
    getToken: (signal) => tokens.getToken(signal),
    retryDelaysMs: resolved.retry.fallbackDelaysMs,
    maxWaitMs: resolved.retry.maxWaitMs,
    sleep: clock.sleep,
    now: clock.now,
    onThrottle: (_status, ms) =>
      limiter.penalize(undefined, cooldownFor(resolved.retry, 0, ms)),
  })
  const pool = new UpstreamPool({
    async connect(signal) {
      const connection = new UpstreamConnection({
        endpoint: new URL(server.url),
        fetch: upstreamFetch,
        clientInfo: { name: "t", version: "0" },
        callTimeoutMs: 5000,
        requestTimeoutMs: 5000,
      })
      await connection.connect(signal)
      return connection
    },
  })
  cleanups.push(() => pool.dispose())
  const backoffs: Array<number> = []
  const guarded = new GuardedUpstream({
    name: "Example",
    upstream: pool,
    limiter,
    clock,
    hooks: { ...HOOKS, batch: [{ tool: "fetch", argument: "entityUrls" }] },
    sleep: (ms, signal) => {
      backoffs.push(ms)
      return clock.sleep(ms, signal)
    },
    random: () => 0.5,
    toError: (error) => toConnectorError(error, { name: "Example" }),
  })
  await guarded.listTools()
  const call = (tool: string, args: Record<string, unknown>) =>
    clock.run(
      guarded.callTool(tool, args, { signal: new AbortController().signal }),
    )
  return { clock, server, limiter, guarded, backoffs, call }
}

const toolCalls = (server: FakeRemoteMcp) =>
  server.requests.filter((request) => request.rpc === "tools/call")

const entries = (result: ToolResult) =>
  (
    result.structuredContent as {
      results: Array<{ statusCode: number; data: { path?: string } | null }>
    }
  ).results

describe("single retry owner", () => {
  test("an HTTP 429 on tools/call costs exactly `attempts` requests, not attempts²", async () => {
    const { server, call, backoffs } = await setup()
    server.throttle({ mode: "http", status: 429, times: Infinity })
    const error = await failure(call("fetch", { entityUrls: ["/me"] }))
    expect(toolCalls(server)).toHaveLength(5)
    expect(backoffs).toEqual([2000, 4000, 8000, 16_000])
    expect((error as ConnectorError).busy).toMatchObject({
      reason: "throttled",
      attempts: 5,
    })
  })

  test("an HTTP 503 on a write is sent once and reported as maybe carried out", async () => {
    const { server, call } = await setup()
    server.throttle({ mode: "http", status: 503, retryAfter: "1" })
    const error = await failure(
      call("create_entity", { parentUrl: "/me/events" }),
    )
    expect(toolCalls(server)).toHaveLength(1)
    expect((error as ConnectorError).busy?.reason).toBe("outcome-unknown")
  })

  test("a throttled tools/list is retried by the transport and opens the shared cool-down", async () => {
    const { server, guarded, limiter, call } = await setup()
    server.throttle({ mode: "http", rpc: "tools/list", retryAfter: "40" })
    // 40 s is past maxWaitMs: the list fails at once…
    expect(await failure(guarded.listTools())).toBeInstanceOf(Error)
    expect(limiter.cooldownMs("default")).toBe(40_000)
    // …and tool calls fail fast instead of piling onto the throttled service.
    const error = await failure(call("fetch", { entityUrls: ["/me"] }))
    expect((error as ConnectorError).busy).toMatchObject({
      reason: "cooldown",
      retryAfterMs: 40_000,
    })
    expect(toolCalls(server)).toHaveLength(0)
  })
})

describe("result-level throttling", () => {
  test("a throttled result is retried after its Retry-After", async () => {
    const { server, call, backoffs } = await setup()
    server.throttle({
      mode: "result",
      tool: "create_entity",
      retryAfter: "3",
      where: "error",
    })
    // HOOKS read `retryAfter` at the top level; this shape puts it under `error`, so the fallback applies.
    const result = await call("create_entity", { parentUrl: "/me/events" })
    expect(result.isError).toBeUndefined()
    expect(backoffs).toEqual([2000])
    expect(toolCalls(server)).toHaveLength(2)
  })
})

describe("batch reads", () => {
  test("re-issues only the throttled paths and splices the answers back in order", async () => {
    const { server, call } = await setup()
    server.throttle({
      mode: "result",
      tool: "fetch",
      paths: (path) => path === "/b" || path === "/d",
    })
    const result = await call("fetch", {
      entityUrls: ["/a", "/b", "/missing", "/d", "/e"],
    })
    expect(server.calls().map((c) => c.args.entityUrls)).toEqual([
      ["/a", "/b", "/missing", "/d", "/e"],
      ["/b", "/d"],
    ])
    expect(
      entries(result).map((entry) => [entry.statusCode, entry.data?.path]),
    ).toEqual([
      [200, "/a"],
      [200, "/b"],
      [404, undefined],
      [200, "/d"],
      [200, "/e"],
    ])
    // The 404 is a real per-path failure, as Work IQ reports it.
    expect(result.isError).toBe(true)
    expect(result.content).toHaveLength(1)
  })

  test("paths still throttled when the budget runs out keep their 429, with a note", async () => {
    const { server, call } = await setup({}, { retry: { attempts: 2 } })
    server.throttle({
      mode: "result",
      tool: "fetch",
      paths: (path) => path === "/d",
      times: Infinity,
    })
    const result = await call("fetch", { entityUrls: ["/a", "/d"] })
    expect(toolCalls(server)).toHaveLength(2)
    expect(entries(result).map((entry) => entry.statusCode)).toEqual([200, 429])
    expect(result.isError).toBe(true)
    expect(result.content[1]).toEqual({
      type: "text",
      text: "1 of 2 entries were throttled by Example and still show the throttled status; retry those in about 4 s.",
    })
  })

  test("splits long lists into chunks of fetchBatchSize", async () => {
    const { server, call } = await setup()
    const paths = Array.from({ length: 45 }, (_, i) => `/p${i}`)
    const result = await call("fetch", { entityUrls: paths })
    expect(
      server.calls().map((c) => (c.args.entityUrls as Array<string>).length),
    ).toEqual([20, 20, 5])
    expect(entries(result).map((entry) => entry.data?.path)).toEqual(paths)
    expect(result.isError).toBeUndefined()

    const unsplit = await setup({}, { fetchBatchSize: 0 })
    await unsplit.call("fetch", { entityUrls: paths })
    expect(unsplit.server.calls()).toHaveLength(1)
  })

  test("a 429 on the fifth chunk gets its own retries; the earlier chunks' answers are kept", async () => {
    let answered = 0
    const box: { server?: FakeRemoteMcp } = {}
    const { server, call, backoffs } = await setup({
      results: {
        fetch: (args) => {
          // The next request (chunk 5) is refused with HTTP 429.
          if (++answered === 4)
            box.server?.throttle({ mode: "http", status: 429 })
          return fetchAnswer(args)
        },
      },
    })
    box.server = server
    const paths = Array.from({ length: 100 }, (_, i) => `/p${i}`)
    const result = await call("fetch", { entityUrls: paths })
    expect(result.isError).toBeUndefined()
    expect(entries(result).map((entry) => entry.data?.path)).toEqual(paths)
    expect(toolCalls(server)).toHaveLength(6)
    expect(backoffs).toEqual([2000])
  })
})
