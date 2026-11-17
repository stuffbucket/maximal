/**
 * Live connector use for the Sessions view: the tracker's bounds, the Work IQ
 * path through `/mcp`, and the `connector_activity` the sessions route serves
 * apart from the sessions.
 */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { setPluginGateway } from "~/lib/plugins/gateway"
import { closeUsageStore } from "~/lib/token-usage"
import {
  __resetConnectorActivityForTests,
  beginConnectorCall,
  connectorActivity,
  LINGER_MS,
  MAX_CALL_MS,
} from "~/lib/token-usage/connector-activity"
import { __resetInFlightForTests } from "~/lib/token-usage/in-flight"
import { SessionsResponse } from "~/lib/token-usage/sessions-schema"
import { pluginMcpRoutes } from "~/routes/plugins/mcp"
import { tokenUsageRoute } from "~/routes/token-usage/route"
import { server } from "~/server"

import {
  definePlugin,
  serveApp,
  startTestGateway,
  type TestGateway,
  waitFor,
} from "./helpers/plugins"

const NOW = 1_800_000_000_000

beforeEach(() => {
  __resetConnectorActivityForTests()
})

describe("connectorActivity", () => {
  test("lists nothing before any call", () => {
    expect(connectorActivity({ nowMs: NOW })).toEqual([])
  })

  test("a running call is listed with its count, start, tool and a hard deadline", () => {
    beginConnectorCall("workiq", "search_mail", NOW - 4000)
    beginConnectorCall("workiq", "search_files", NOW - 1000)
    expect(connectorActivity({ nowMs: NOW })).toEqual([
      {
        connector: "workiq",
        state: "running",
        active_calls: 2,
        started_at_ms: NOW - 4000,
        last_activity_at_ms: NOW - 1000,
        expires_at_ms: NOW - 4000 + MAX_CALL_MS,
        last_tool: "search_files",
      },
    ])
  })

  test("a finished call lingers, then is gone", () => {
    const end = beginConnectorCall("workiq", "search_mail", Date.now() - 2000)
    end()
    const [view] = connectorActivity({ nowMs: Date.now() })
    expect(view).toMatchObject({
      connector: "workiq",
      state: "recent",
      active_calls: 0,
      started_at_ms: null,
      last_tool: "search_mail",
    })
    expect(view.expires_at_ms).toBe(view.last_activity_at_ms + LINGER_MS)
    expect(
      connectorActivity({ nowMs: view.last_activity_at_ms + LINGER_MS }),
    ).toEqual([])
  })

  test("ending a call twice counts once", () => {
    const first = beginConnectorCall("workiq", "a", NOW - 1000)
    beginConnectorCall("workiq", "b", NOW - 500)
    first()
    first()
    expect(connectorActivity({ nowMs: NOW })[0]).toMatchObject({
      state: "running",
      active_calls: 1,
    })
  })

  test("a call refused before it ran leaves no trace", () => {
    const earlier = beginConnectorCall("workiq", "kept", NOW - 20_000)
    earlier()
    const refused = beginConnectorCall("workiq", "blocked", NOW)
    refused(false)
    expect(connectorActivity({ nowMs: NOW })).toEqual([])
    beginConnectorCall("figjam", "x", NOW)(false)
    expect(connectorActivity({ nowMs: NOW })).toEqual([])
  })

  test("a call that never ends stops counting at its deadline", () => {
    beginConnectorCall("workiq", "stuck", NOW - MAX_CALL_MS - 1)
    expect(connectorActivity({ nowMs: NOW })).toEqual([])
  })

  test("a plugin that is not listed is ignored", () => {
    const end = beginConnectorCall("other", "x", NOW)
    end()
    expect(connectorActivity({ nowMs: NOW })).toEqual([])
  })

  test("tool names are cleaned and bounded", () => {
    beginConnectorCall("workiq", `get\n${"x".repeat(200)}`, NOW)
    const [view] = connectorActivity({ nowMs: NOW })
    expect(view.last_tool).toHaveLength(80)
    expect(view.last_tool).not.toContain("\n")
  })

  test("remembers at most a bounded number of calls", () => {
    for (let call = 0; call < 1000; call += 1)
      beginConnectorCall("workiq", "t", NOW)
    expect(connectorActivity({ nowMs: NOW })[0].active_calls).toBe(256)
  })

  test("FigJam is read from what the plugin reports, with the same bounds", () => {
    const reported = (activity: {
      activeCalls: number
      startedAtMs: number | null
      lastActivityAtMs: number
      lastTool?: string
    }) =>
      connectorActivity({
        nowMs: NOW,
        reported: (id) => (id === "figjam" ? activity : undefined),
      })

    expect(
      reported({
        activeCalls: 1,
        startedAtMs: NOW - 2000,
        lastActivityAtMs: NOW - 2000,
        lastTool: "get_board",
      }),
    ).toEqual([
      {
        connector: "figjam",
        state: "running",
        active_calls: 1,
        started_at_ms: NOW - 2000,
        last_activity_at_ms: NOW - 2000,
        expires_at_ms: NOW - 2000 + MAX_CALL_MS,
        last_tool: "get_board",
      },
    ])
    expect(
      reported({
        activeCalls: 0,
        startedAtMs: null,
        lastActivityAtMs: NOW - 3000,
        lastTool: "find_nodes",
      })[0],
    ).toMatchObject({ state: "recent", last_tool: "find_nodes" })
    // Old, or a call that claims to have run too long: not listed.
    expect(
      reported({
        activeCalls: 0,
        startedAtMs: null,
        lastActivityAtMs: NOW - LINGER_MS,
      }),
    ).toEqual([])
    expect(
      reported({
        activeCalls: 1,
        startedAtMs: NOW - MAX_CALL_MS,
        lastActivityAtMs: NOW - MAX_CALL_MS,
      }),
    ).toEqual([])
  })

  test("lists Work IQ before FigJam", () => {
    beginConnectorCall("workiq", "a", NOW)
    const views = connectorActivity({
      nowMs: NOW,
      reported: (id) =>
        id === "figjam" ?
          { activeCalls: 1, startedAtMs: NOW, lastActivityAtMs: NOW }
        : undefined,
    })
    expect(views.map((view) => view.connector)).toEqual(["workiq", "figjam"])
  })
})

describe("Work IQ over /mcp", () => {
  let plugins: TestGateway
  let app: Awaited<ReturnType<typeof serveApp>>
  let client: Client
  let release: (() => void) | undefined

  const workiq = definePlugin(
    "workiq",
    (ctx) => {
      ctx.surface.setStatus({ state: "ready", code: "ready", summary: "Ready" })
      ctx.tools.register({
        name: "search_mail",
        description: "Slow search.",
        inputSchema: { type: "object" },
        execute: async () => {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return { content: [{ type: "text" as const, text: "found" }] }
        },
      })
    },
    { defaultToolPermission: () => "allow" },
  )

  beforeEach(async () => {
    plugins = await startTestGateway([workiq], ["workiq"])
    app = await serveApp(server.fetch)
    client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.origin}/mcp/workiq`)),
    )
  })

  afterEach(async () => {
    await client.close()
    await pluginMcpRoutes.closeAll()
    await app.close()
    await plugins.dispose()
  })

  test("is listed while a tool call runs and lingers after it, without its arguments", async () => {
    const call = client.callTool({
      name: "search_mail",
      arguments: { query: "do-not-keep-this" },
    })
    await waitFor(() => connectorActivity({ nowMs: Date.now() }).length === 1)
    const [running] = connectorActivity({ nowMs: Date.now() })
    expect(running).toMatchObject({
      connector: "workiq",
      state: "running",
      active_calls: 1,
      last_tool: "search_mail",
    })
    expect(JSON.stringify(running)).not.toContain("do-not-keep-this")

    release?.()
    await call
    const [after] = connectorActivity({ nowMs: Date.now() })
    expect(after).toMatchObject({ state: "recent", active_calls: 0 })
  })
})

async function fetchSessions(): Promise<SessionsResponse> {
  const app = new Hono()
  app.route("/token-usage", tokenUsageRoute)
  const response = await app.request("/token-usage/sessions")
  expect(response.status).toBe(200)
  return SessionsResponse.parse(await response.json())
}

describe("GET /token-usage/sessions: connector_activity", () => {
  let home: string
  const disposers: Array<() => Promise<void>> = []

  const figjam = definePlugin(
    "figjam",
    (ctx) => {
      ctx.surface.setStatus({
        state: "ready",
        code: "ready",
        summary: "Ready",
        activity: {
          activeCalls: 1,
          startedAtMs: Date.now() - 1000,
          lastActivityAtMs: Date.now() - 1000,
          lastTool: "get_board",
        },
      })
    },
    { kind: "extension" },
  )

  beforeEach(async () => {
    await closeUsageStore()
    home = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-connector-route-"))
    process.env.COPILOT_API_SQLITE_DB_PATH = path.join(home, "usage.sqlite")
    __resetInFlightForTests()
  })

  afterEach(async () => {
    await closeUsageStore()
    Reflect.deleteProperty(process.env, "COPILOT_API_SQLITE_DB_PATH")
    fs.rmSync(home, { recursive: true, force: true })
    for (const dispose of disposers.splice(0)) await dispose()
    setPluginGateway(undefined)
  })

  test("serves connectors apart from the sessions and their totals", async () => {
    const gateway = await startTestGateway([figjam], ["figjam"])
    disposers.push(() => gateway.dispose())
    beginConnectorCall("workiq", "search_mail")

    const view = await fetchSessions()
    expect(view.sessions).toEqual([])
    expect(view.flow_per_min).toBe(0)
    expect(view.connector_activity?.map((c) => c.connector)).toEqual([
      "workiq",
      "figjam",
    ])
    expect(view.connector_activity?.[1]).toMatchObject({
      state: "running",
      last_tool: "get_board",
    })
  })

  test("is empty with nothing in use", async () => {
    const view = await fetchSessions()
    expect(view.connector_activity).toEqual([])
  })
})
