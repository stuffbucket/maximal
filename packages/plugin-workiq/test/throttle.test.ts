import type { ToolResult } from "@stuffbucket/maximal-plugin-sdk"

import { FakeClock } from "@stuffbucket/maximal-connector-kit/testing"
import { loadPlugin, waitFor } from "@stuffbucket/maximal-plugin-sdk/testing"
import { afterEach, describe, expect, test } from "bun:test"

import {
  createWorkIqPlugin,
  inspectWorkIqResult,
  WORKIQ_MANIFEST,
  workIqKind,
  workIqLane,
} from "../src/index"
import {
  BENCH_ACCOUNT,
  fakeAuth,
  startFakeWorkIq,
  WORKIQ_TOOLS,
  type FakeRemoteMcp,
} from "../src/testing"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const NOW = Date.UTC(2025, 0, 1)

const json = (value: Record<string, unknown>, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
  ...(isError ? { isError: true } : {}),
})

const lane = (tool: string, args: Record<string, unknown>) =>
  workIqLane(tool, args)
expect(
  lane("fetch", {
    entityUrls: ["/me/chats/19:abc/messages?$top=10", "/me/messages"],
  }),
).toBe("teams")
expect(lane("fetch", { entityUrls: ["/teams/t1/channels/c1/messages"] })).toBe(
  "teams",
)
expect(
  lane("fetch", { entityUrls: ["/users/ada@contoso.com/onlineMeetings"] }),
).toBe("teams")
const inspect = (tool: string, result: ToolResult) =>
  inspectWorkIqResult(result, { tool, args: {}, now: NOW })
const throttled = (
  extra: Record<string, unknown>,
  error: Record<string, unknown> = {},
) => ({
  statusCode: 429,
  data: null,
  error: { code: "TooManyRequests", message: "Too many requests.", ...error },
  ...extra,
})
async function connect(server: FakeRemoteMcp) {
  const clock = new FakeClock()
  const backoffs: Array<number> = []
  const plugin = await loadPlugin(
    createWorkIqPlugin({
      endpoint: server.url,
      auth: fakeAuth({ account: BENCH_ACCOUNT, signedIn: true }),
      clock,
      random: () => 0.5,
      sleep: (ms, signal) => {
        backoffs.push(ms)
        return clock.sleep(ms, signal)
      },
    }),
    {},
    {
      storage: {
        workiq: {
          "terms.json": JSON.stringify({
            accepted: true,
            terms: "https://github.com/microsoft/work-iq",
          }),
        },
      },
    },
  )
  cleanups.push(() => plugin.dispose())
  await waitFor(() => plugin.status()?.code === "ready")
  const call = (tool: string, args: Record<string, unknown>) =>
    clock.run(plugin.callTool(tool, args))
  return { plugin, backoffs, call }
}
function fake(): FakeRemoteMcp {
  const server = startFakeWorkIq({
    tools: [
      ...WORKIQ_TOOLS,
      {
        name: "do_action",
        inputSchema: {
          type: "object",
          properties: { actionUrl: { type: "string" } },
        },
      },
    ],
  })
  cleanups.push(() => server.close())
  return server
}

describe("Work IQ tool kinds", () => {
  test("reads, writes, and do_action by action", () => {
    const kinds = Object.fromEntries(
      WORKIQ_TOOLS.map((tool) => [tool.name, workIqKind(tool.name, {})]),
    )
    expect(kinds).toEqual({
      retrieve: "read",
      fetch_blob: "read",
      get_schema: "read",
      call_function: "read",
      fetch: "read",
      search_paths: "read",
      accept_eula: "idempotent-write",
      delete_entity: "write",
      upload_blob: "write",
      create_entity: "write",
      update_entity: "write",
      ask: "read",
      list_agents: "read",
      get_debug_link: "read",
    })
    expect(workIqKind("do_action", { actionUrl: "/search/query" })).toBe("read")
    expect(
      workIqKind("do_action", { actionUrl: "/me/messages/AAMk/send" }),
    ).toBe("write")
    expect(workIqKind("something_new", {})).toBeUndefined()
  })
})

describe("Work IQ lanes", () => {
  test("by workload of the first path, the tool, or the search entity types", () => {
    expect(lane("fetch", { entityUrls: ["/me/messages"] })).toBe("outlook")
    expect(
      lane("fetch", { entityUrls: ["/v1.0/me/calendarView?startDateTime=x"] }),
    ).toBe("outlook")
    expect(lane("call_function", { functionUrl: "/me/messages/delta()" })).toBe(
      "outlook",
    )
    expect(lane("create_entity", { parentUrl: "/me/events" })).toBe("outlook")
    expect(
      lane("call_function", {
        functionUrl: "/me/drive/root/search(q='budget')",
      }),
    ).toBe("files")
    expect(lane("fetch", { entityUrls: ["/sites/root/lists"] })).toBe("files")
    expect(lane("fetch_blob", { path: "/me/photo/$value" })).toBe("files")
    expect(lane("ask", { question: "q" })).toBe("copilot")
    expect(lane("retrieve", { query: "q" })).toBe("copilot")
    expect(lane("fetch", { entityUrls: ["/me/manager"] })).toBeUndefined()
    const search = (entityTypes: Array<string>) =>
      lane("do_action", {
        actionUrl: "/search/query",
        jsonBody: JSON.stringify({
          requests: [{ entityTypes, query: { queryString: "x" } }],
        }),
      })
    expect(search(["chatMessage"])).toBe("teams")
    expect(search(["message"])).toBe("outlook")
    expect(search(["driveItem"])).toBe("files")
    expect(search(["person"])).toBeUndefined()
  })

  test("the manifest caps each lane", () => {
    expect(WORKIQ_MANIFEST.connector.limits?.lanes).toEqual({
      teams: { maxConcurrency: 2, minIntervalMs: 500 },
      outlook: { maxConcurrency: 4 },
      files: { maxConcurrency: 2 },
      copilot: { maxConcurrency: 2 },
    })
  })
})

describe("Work IQ result inspection", () => {
  test("finds throttled fetch entries (429/503/504) and keeps the others", () => {
    const result = json(
      {
        results: [
          { statusCode: 200, data: {}, error: null },
          throttled({}),
          { statusCode: 404, data: null, error: { code: "itemNotFound" } },
          { ...throttled({}), statusCode: 503 },
        ],
      },
      true,
    )
    expect(inspect("fetch", result)).toEqual({ status: 429, indexes: [1, 3] })
    expect(
      inspect("fetch", json({ results: [{ statusCode: 200 }] })),
    ).toBeUndefined()
  })

  test("Retry-After in a header, the error, its innerError or the message all give the same wait", () => {
    for (const entry of [
      throttled({ headers: { "Retry-After": "7" } }),
      throttled({}, { retryAfter: "7" }),
      throttled({}, { innerError: { "retry-after": "7" } }),
      throttled({}, { message: "Rate limit hit. Retry after 7 seconds." }),
    ])
      expect(inspect("fetch", json({ results: [entry] }))).toEqual({
        status: 429,
        indexes: [0],
        retryAfterMs: 7000,
      })
  })

  test("whole-call throttling: statusCode, a Graph error code, or plain error text", () => {
    expect(
      inspect(
        "call_function",
        json(throttled({ headers: { "retry-after": "2" } }), true),
      ),
    ).toEqual({
      status: 429,
      retryAfterMs: 2000,
    })
    expect(
      inspect(
        "do_action",
        json({ error: { code: "serviceNotAvailable", message: "x" } }, true),
      ),
    ).toEqual({ status: 503 })
    expect(
      inspect("ask", {
        isError: true,
        content: [
          { type: "text", text: "429 Too Many Requests. Retry-After: 4" },
        ],
      }),
    ).toEqual({ status: 429, retryAfterMs: 4000 })
    expect(
      inspect("ask", { content: [{ type: "text", text: "429 is a number" }] }),
    ).toBeUndefined()
    expect(
      inspect(
        "call_function",
        json({ statusCode: 200, data: {}, error: null }),
      ),
    ).toBeUndefined()
  })
})

describe("Work IQ throttling end to end", () => {
  test("a throttled Teams path in a fetch batch is re-read alone after its Retry-After", async () => {
    for (const where of ["headers", "error", "message"] as const) {
      const server = fake()
      const { call, backoffs } = await connect(server)
      server.throttle({
        mode: "result",
        tool: "fetch",
        retryAfter: "3",
        where,
        paths: (path) => path.startsWith("/me/chats"),
      })
      const result = await call("fetch", {
        entityUrls: ["/me", "/me/chats/19:x/messages", "/me/manager"],
      })
      expect(server.calls().map((c) => c.args.entityUrls)).toEqual([
        ["/me", "/me/chats/19:x/messages", "/me/manager"],
        ["/me/chats/19:x/messages"],
      ])
      expect(backoffs).toEqual([3000])
      const results = (
        result.structuredContent as {
          results: Array<{ statusCode: number; data: { path: string } }>
        }
      ).results
      expect(
        results.map((entry) => [entry.statusCode, entry.data.path]),
      ).toEqual([
        [200, "/me"],
        [200, "/me/chats/19:x/messages"],
        [200, "/me/manager"],
      ])
      expect(result.isError).toBeUndefined()
    }
  })

  test("writes: a Graph 503 is not retried; a search do_action is a read and is", async () => {
    const server = fake()
    const { call } = await connect(server)
    server.throttle({ mode: "result", tool: "create_entity", status: 503 })
    expect(
      await call("create_entity", { parentUrl: "/me/events", jsonBody: {} }),
    ).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "The request may have been carried out: Work IQ returned HTTP 503 for create_entity, which changes data. Check before retrying.",
        },
      ],
    })
    expect(server.calls()).toHaveLength(1)

    server.throttle({ mode: "http", tool: "do_action", status: 503 })
    const search = await call("do_action", {
      actionUrl: "/search/query",
      jsonBody: { requests: [] },
    })
    expect(search.isError).toBeUndefined()
    server.throttle({ mode: "http", tool: "do_action", status: 503 })
    const send = await call("do_action", {
      actionUrl: "/me/messages/AAMk/send",
    })
    expect(send.isError).toBe(true)
    // Search: throttled, then answered; send: throttled once and not retried.
    expect(
      server.requests
        .filter((r) => r.tool === "do_action")
        .map((r) => r.status),
    ).toEqual([503, 200, 503])
  })

  test("`ask` gets two attempts at most", async () => {
    const server = fake()
    const { call } = await connect(server)
    server.throttle({ mode: "http", tool: "ask", status: 429, times: Infinity })
    const result = await call("ask", { question: "q" })
    expect(result.isError).toBe(true)
    expect(server.requests.filter((r) => r.tool === "ask")).toHaveLength(2)
  })
})
