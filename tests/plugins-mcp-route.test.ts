/**
 * `/mcp/<pluginId>` end to end: the real Hono app on a loopback port, a real
 * gateway composed from an inline plugin, and the official MCP client.
 */

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { getConfig, writeConfig } from "~/lib/config/config"
import { pluginMcpRoutes } from "~/routes/plugins/mcp"
import { server } from "~/server"

import {
  definePlugin,
  serveApp,
  startTestGateway,
  type TestGateway,
  waitFor,
} from "./helpers/plugins"

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
})

const demo = definePlugin("demo", (ctx) => {
  ctx.surface.setStatus({ state: "ready", code: "ready", summary: "Ready" })
  ctx.surface.registerAction("add-tool", () => {
    ctx.tools.register({
      name: "extra",
      description: "Added later.",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve(text("extra")),
    })
    return Promise.resolve()
  })
  ctx.tools.register({
    name: "echo",
    title: "Echo",
    description: "Echo the text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: true },
    execute: (input, call) =>
      Promise.resolve(
        text(`${String(input.text)} (${call.sessionId ? "session" : "none"})`),
      ),
  })
  ctx.tools.register({
    name: "count",
    description: "Reports progress.",
    inputSchema: { type: "object" },
    execute: (_input, call) => {
      for (let step = 1; step <= 3; step += 1) {
        call.progress?.({ progress: step, total: 3, message: `step ${step}` })
      }
      return Promise.resolve(text(call.progress ? "counted" : "no-progress"))
    },
  })
  ctx.tools.register({
    name: "ask",
    description: "Asks the user.",
    inputSchema: { type: "object" },
    async execute(_input, call) {
      if (!call.elicit) return text("no-elicit")
      const answer = await call.elicit({
        message: "Your name?",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      })
      return text(`${answer.action}:${String(answer.content?.name)}`)
    },
  })
  ctx.tools.register({
    name: "boom",
    description: "Throws.",
    inputSchema: { type: "object" },
    execute: () => Promise.reject(new Error("it broke")),
  })
})

const idle = definePlugin("idle", (ctx) => {
  ctx.surface.setStatus({
    state: "needs-setup",
    code: "signin-needed",
    summary: "Sign in first.",
  })
})

let plugins: TestGateway
let app: Awaited<ReturnType<typeof serveApp>>
const clients: Array<Client> = []

async function connect(
  pluginId = "demo",
  headers: Record<string, string> = {},
): Promise<Client> {
  const client = new Client(
    { name: "test", version: "1.0.0" },
    { capabilities: { elicitation: {} } },
  )
  client.setRequestHandler("elicitation/create", () =>
    Promise.resolve({ action: "accept" as const, content: { name: "Ada" } }),
  )
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`${app.origin}/mcp/${pluginId}`),
      {
        requestInit: { headers },
      },
    ),
  )
  clients.push(client)
  return client
}

beforeEach(async () => {
  plugins = await startTestGateway([demo, idle], ["demo", "idle"])
  app = await serveApp(server.fetch)
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await pluginMcpRoutes.closeAll()
  await app.close()
  await plugins.dispose()
})

describe("/mcp/<pluginId>", () => {
  test("lists the plugin's tools with schemas and annotations", async () => {
    const client = await connect()
    expect(client.getServerVersion()?.name).toBe("demo")
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual([
      "echo",
      "count",
      "ask",
      "boom",
    ])
    expect(tools[0]).toMatchObject({
      name: "echo",
      title: "Echo",
      inputSchema: { type: "object", required: ["text"] },
      annotations: { readOnlyHint: true },
    })
  })

  test("calls a tool with the downstream session id", async () => {
    const client = await connect()
    const result = await client.callTool({
      name: "echo",
      arguments: { text: "hello" },
    })
    expect(result.content).toEqual([{ type: "text", text: "hello (session)" }])
    expect(pluginMcpRoutes.sessionCount("demo")).toBe(1)
  })

  test("relays progress to a client that asked for it", async () => {
    const client = await connect()
    const updates: Array<{ progress: number; message?: string }> = []
    const result = await client.callTool(
      { name: "count", arguments: {} },
      { onprogress: (update) => updates.push(update) },
    )
    expect(result.content).toEqual([{ type: "text", text: "counted" }])
    await waitFor(() => updates.length === 3)
    expect(updates.map((u) => u.message)).toEqual([
      "step 1",
      "step 2",
      "step 3",
    ])
  })

  test("routes elicitation to the downstream client", async () => {
    const client = await connect()
    const result = await client.callTool({ name: "ask", arguments: {} })
    expect(result.content).toEqual([{ type: "text", text: "accept:Ada" }])
  })

  test("a throwing tool is an error result; an unknown tool a protocol error", async () => {
    const client = await connect()
    const result = await client.callTool({ name: "boom", arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: "text", text: "it broke" }])
    let refused: unknown
    try {
      await client.callTool({ name: "nope", arguments: {} })
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(Error)
  })

  test("sends tools/list_changed when the plugin's tools change", async () => {
    const client = await connect()
    let changed = 0
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      changed += 1
    })
    // Give the client's standalone SSE stream a moment to open.
    await new Promise((resolve) => setTimeout(resolve, 100))
    await plugins.gateway.runAction("demo", "add-tool")
    await waitFor(() => changed > 0)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toContain("extra")
  })

  test("a plugin that registered no tools yet lists none", async () => {
    const client = await connect("idle")
    expect((await client.listTools()).tools).toEqual([])
  })

  test("turning the plugin off closes its sessions and 404s the endpoint", async () => {
    await connect()
    expect(pluginMcpRoutes.sessionCount("demo")).toBe(1)
    const next = writeConfig({
      ...getConfig(),
      plugins: { idle: { enabled: true } },
    })
    await plugins.gateway.reconcile(next.plugins)
    await waitFor(() => pluginMcpRoutes.sessionCount("demo") === 0)
    const response = await fetch(`${app.origin}/mcp/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: "MCP_ENDPOINT_NOT_FOUND" },
    })
  })

  test("unknown plugins are 404", async () => {
    const response = await fetch(`${app.origin}/mcp/nope`, { method: "POST" })
    expect(response.status).toBe(404)
  })

  test("rejects a foreign Origin", async () => {
    const response = await fetch(`${app.origin}/mcp/demo`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    })
    expect(response.status).toBe(403)
  })

  test("a request without a session that is not initialize leaves none behind", async () => {
    const response = await fetch(`${app.origin}/mcp/demo`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(response.status).toBe(400)
    expect(pluginMcpRoutes.sessionCount()).toBe(0)
  })

  test("an unknown session id is 404 so the client re-initializes", async () => {
    const response = await fetch(`${app.origin}/mcp/demo`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "not-a-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(response.status).toBe(404)
  })

  test("applies the main port's API-key rules", async () => {
    writeConfig({
      ...getConfig(),
      auth: {
        enforce: true,
        apiKeyEntries: [
          {
            id: "k1",
            label: "claude-code",
            key: "test-key-123456",
            enabled: true,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    })
    const denied = await fetch(`${app.origin}/mcp/demo`, { method: "POST" })
    expect(denied.status).toBe(401)
    const client = await connect("demo", {
      authorization: "Bearer test-key-123456",
    })
    expect((await client.listTools()).tools.length).toBe(4)
  })
})
