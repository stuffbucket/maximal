/**
 * `/mcp/<pluginId>` end to end: the real Hono app on a loopback port, a real
 * gateway composed from an inline plugin, and the official MCP client.
 */

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import {
  blockedToolText,
  PluginGatewayError,
  unapprovedToolText,
} from "@stuffbucket/maximal-plugin-sdk/gateway"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { getConfig, writeConfig } from "~/lib/config/config"
import { setPluginGateway } from "~/lib/plugins/gateway"
import { createPluginMcpRoutes, pluginMcpRoutes } from "~/routes/plugins/mcp"
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

const inner = definePlugin(
  "inner",
  (ctx) => {
    ctx.tools.register({
      name: "secret",
      description: "Not for MCP clients.",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve(text("secret")),
    })
  },
  { kind: "extension" },
)

let plugins: TestGateway
let app: Awaited<ReturnType<typeof serveApp>>
const clients: Array<Client> = []

interface ConnectOptions {
  /** MCP `clientInfo.name` (default `test`). */
  name?: string
  /** Answers elicitations; `false`: the client doesn't support them. */
  elicit?:
    | false
    | ((message: string) => { action: "accept" | "decline" | "cancel" })
}

async function connect(
  pluginId = "demo",
  headers: Record<string, string> = {},
  options: ConnectOptions = {},
): Promise<Client> {
  const elicit = options.elicit
  const client = new Client(
    { name: options.name ?? "test", version: "1.0.0" },
    elicit === false ? {} : { capabilities: { elicitation: {} } },
  )
  if (elicit !== false)
    client.setRequestHandler("elicitation/create", (request) =>
      Promise.resolve(
        elicit ?
          elicit(request.params.message)
        : { action: "accept" as const, content: { name: "Ada" } },
      ),
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
  plugins = await startTestGateway(
    [demo, idle, inner],
    ["demo", "idle", "inner"],
  )
  app = await serveApp(server.fetch)
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await pluginMcpRoutes.closeAll()
  await app.close()
  await plugins.dispose()
})

describe("/mcp/<pluginId>", () => {
  test("subscribes the mandatory generation lifecycle wiring", async () => {
    let cutover: ((generationId: string, deadline: number) => void) | undefined
    let unsubscribed = 0
    const routes = createPluginMcpRoutes({
      generationLifecycle: {
        releaseUpstreamSession: () => Promise.resolve(),
        subscribeCutovers: (listener) => {
          cutover = listener
          return () => {
            unsubscribed += 1
          }
        },
      },
    })

    expect(cutover).toBeFunction()
    cutover?.("n+1", Date.now() + 1000)
    expect(routes.affinityDiagnostics()).toEqual({
      pinnedSessions: [],
      drainBlockers: [],
    })
    await routes.closeAll()
    expect(unsubscribed).toBe(1)
  })

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

  test("turns a listTools lifecycle race into an empty catalog", async () => {
    const target = plugins.gateway
    const racing = new Proxy(target, {
      get(gateway, property) {
        if (property === "acquireGeneration") {
          return () => {
            const lease = gateway.acquireGeneration()
            return {
              ...lease,
              listTools: () => {
                throw new PluginGatewayError(
                  "unknown-plugin",
                  "demo",
                  "generation retired",
                )
              },
            }
          }
        }
        const value: unknown = Reflect.get(gateway, property)
        if (typeof value !== "function") return value
        return (...args: Array<unknown>): unknown => {
          const result: unknown = Reflect.apply(value, gateway, args)
          return result
        }
      },
    })
    setPluginGateway(racing)
    try {
      const client = await connect()
      expect(await client.listTools()).toEqual({ tools: [] })
    } finally {
      setPluginGateway(target)
    }
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
})

describe("/mcp/<pluginId>: permissions, kinds, setup and access", () => {
  test("blocked tools stay listed as turned off (with list_changed) and refuse calls, saying where to turn them on", async () => {
    const client = await connect()
    let changed = 0
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      changed += 1
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await plugins.gateway.setToolPermissions("demo", { echo: "block" })
    await waitFor(() => changed > 0)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual([
      "echo",
      "count",
      "ask",
      "boom",
    ])
    const off = blockedToolText("DEMO", "echo")
    expect(tools[0].description).toStartWith(off)
    const refused = await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
    })
    expect(refused.isError).toBe(true)
    expect(refused.content).toEqual([{ type: "text", text: off }])

    const before = changed
    await plugins.gateway.setToolPermissions("demo", { echo: null })
    await waitFor(() => changed > before)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      "echo",
    )
    const allowed = await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
    })
    expect(allowed.isError).toBeFalsy()
  })
})

describe("/mcp/<pluginId>: ask permission", () => {
  test("ask tools carry Claude Code's per-call prompt, and Claude Code isn't asked again", async () => {
    const asked: Array<string> = []
    const client = await connect(
      "demo",
      {},
      {
        name: "claude-code",
        elicit: (message) => {
          asked.push(message)
          return { action: "decline" }
        },
      },
    )
    const { tools } = await client.listTools()
    const meta = (name: string) =>
      tools.find((tool) => tool.name === name)?._meta?.[
        "anthropic/requiresUserInteraction"
      ]
    // `count` isn't read-only, so it asks by default; `echo` is read-only.
    expect(meta("count")).toBe(true)
    expect(meta("echo")).toBeUndefined()
    const result = await client.callTool({ name: "count", arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(asked).toEqual([])
  })

  test("other clients are asked by Maximal before an ask tool runs", async () => {
    const asked: Array<string> = []
    let answer: "accept" | "decline" | "cancel" = "accept"
    const client = await connect(
      "demo",
      {},
      {
        elicit: (message) => {
          asked.push(message)
          return { action: answer }
        },
      },
    )
    expect(
      (await client.callTool({ name: "count", arguments: {} })).isError,
    ).toBeFalsy()
    expect(asked).toEqual(["Maximal: allow DEMO to run count?\n{}"])

    answer = "decline"
    const declined = await client.callTool({ name: "count", arguments: {} })
    expect(declined.isError).toBe(true)
    expect(declined.content).toEqual([
      {
        type: "text",
        text: "You declined DEMO's count call, so it wasn't run.",
      },
    ])
    // A read-only tool is allowed by default: nobody is asked.
    const before = asked.length
    await client.callTool({ name: "echo", arguments: { text: "hi" } })
    expect(asked).toHaveLength(before)
  })

  test("a client that can't ask gets an ask tool refused, saying how to allow it", async () => {
    const client = await connect("demo", {}, { elicit: false })
    const result = await client.callTool({ name: "count", arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      { type: "text", text: unapprovedToolText("DEMO", "count") },
    ])
  })

  test("a plugin that isn't a connector has no MCP endpoint", async () => {
    expect(plugins.gateway.get("inner")?.lifecycle).toBe("active")
    const response = await fetch(`${app.origin}/mcp/inner`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: "MCP_ENDPOINT_NOT_FOUND" },
    })
  })

  test("a plugin that registered no tools yet lists none", async () => {
    const client = await connect("idle")
    expect((await client.listTools()).tools).toEqual([])
  })

  test("calling a remembered tool while the connector needs setup says why", async () => {
    const client = await connect("idle")
    const result = await client.callTool({ name: "retrieve", arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      { type: "text", text: "IDLE isn't ready in Maximal: Sign in first." },
    ])
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
