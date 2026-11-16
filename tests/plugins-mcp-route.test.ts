/* eslint-disable max-lines -- one end-to-end harness (gateway, app, MCP client) shared by every /mcp scenario */
/**
 * `/mcp` and `/mcp/<pluginId>` end to end: the real Hono app on a loopback
 * port, a real gateway composed from inline plugins, and the official client.
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
import { notifyPluginAccessChanged } from "~/lib/plugins/access-events"
import { setPluginGateway } from "~/lib/plugins/gateway"
import { state } from "~/lib/runtime-state/state"
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

const other = definePlugin("other", (ctx) => {
  ctx.surface.setStatus({ state: "ready", code: "ready", summary: "Ready" })
  ctx.tools.register({
    name: "echo",
    description: "Echo from the other connector.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    execute: (input) => Promise.resolve(text(`other:${String(input.text)}`)),
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
  pluginId: string | null = "demo",
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
      new URL(
        pluginId === null ?
          `${app.origin}/mcp`
        : `${app.origin}/mcp/${pluginId}`,
      ),
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
    [demo, idle, other, inner],
    ["demo", "idle", "other", "inner"],
  )
  app = await serveApp(server.fetch)
})

const originalShellKey = state.shellApiKey
function useShellKey(key: string): void {
  state.shellApiKey = key
}

afterEach(async () => {
  state.shellApiKey = originalShellKey
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

describe("/mcp: aggregate connector server", () => {
  test("namespaces every connector's tools behind one Maximal server", async () => {
    const client = await connect(null)
    expect(client.getServerVersion()?.name).toBe("maximal")
    expect(await names(client)).toEqual([
      "demo__echo",
      "demo__count",
      "demo__ask",
      "demo__boom",
      "other__echo",
    ])

    const demoResult = await client.callTool({
      name: "demo__echo",
      arguments: { text: "hello" },
    })
    expect(demoResult.content).toEqual([
      { type: "text", text: "hello (session)" },
    ])
    const otherResult = await client.callTool({
      name: "other__echo",
      arguments: { text: "hello" },
    })
    expect(otherResult.content).toEqual([{ type: "text", text: "other:hello" }])
  })

  test("lists tools from the session generation after a cutover", async () => {
    const client = await connect(null)
    const target = plugins.gateway
    const current = new Proxy(target, {
      get(gateway, property) {
        if (property === "list") return () => []
        const value: unknown = Reflect.get(gateway, property)
        if (typeof value !== "function") return value
        return (...args: Array<unknown>): unknown =>
          Reflect.apply(value, gateway, args)
      },
    })
    setPluginGateway(current)
    try {
      expect(await names(client)).toEqual([
        "demo__echo",
        "demo__count",
        "demo__ask",
        "demo__boom",
        "other__echo",
      ])
    } finally {
      setPluginGateway(target)
    }
  })

  test("isolates a connector that races a reload", async () => {
    const target = plugins.gateway
    const racing = new Proxy(target, {
      get(gateway, property) {
        if (property === "acquireGeneration") {
          return () => {
            const lease = gateway.acquireGeneration()
            return {
              ...lease,
              listTools: (pluginId: string) => {
                if (pluginId === "demo") {
                  throw new PluginGatewayError(
                    "unknown-plugin",
                    pluginId,
                    "generation retired",
                  )
                }
                return lease.listTools(pluginId)
              },
            }
          }
        }
        const value: unknown = Reflect.get(gateway, property)
        if (typeof value !== "function") return value
        return (...args: Array<unknown>): unknown =>
          Reflect.apply(value, gateway, args)
      },
    })
    setPluginGateway(racing)
    try {
      expect(await names(await connect(null))).toEqual(["other__echo"])
    } finally {
      setPluginGateway(target)
    }
  })

  test("rejects unnamespaced tools", async () => {
    const client = await connect(null)
    let refused: unknown
    try {
      await client.callTool({ name: "echo", arguments: { text: "hello" } })
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(Error)
  })

  test("updates its list without closing when one connector stops", async () => {
    const client = await connect(null)
    let changed = 0
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      changed += 1
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const next = writeConfig({
      ...getConfig(),
      plugins: {
        idle: { enabled: true },
        other: { enabled: true },
        inner: { enabled: true },
      },
    })
    await plugins.gateway.reconcile(next.plugins)
    await waitFor(() => changed > 0)
    expect(await names(client)).toEqual(["other__echo"])
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
    writeConfig({
      ...getConfig(),
      auth: { apiKeyEntries: [entry("k-cc", "Claude Code")] },
      plugins: { demo: { enabled: true, clients: ["claude-code"] } },
    })
    const asked: Array<string> = []
    const client = await connect("demo", bearer("k-cc"), {
      name: "claude-code",
      elicit: (message) => {
        asked.push(message)
        return { action: "decline" }
      },
    })
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
      plugins: { demo: { clients: ["claude-code"] } },
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

const entry = (id: string, label: string, enabled = true) => ({
  id,
  label,
  key: `${id}-secret-key-123`,
  enabled,
  created_at: "2026-01-01T00:00:00Z",
})
const bearer = (id: string) => ({
  authorization: `Bearer ${id}-secret-key-123`,
})

function configure(
  access: Record<string, "allow" | "ask" | "block"> | undefined,
  clients?: Array<"claude-code" | "codex">,
): void {
  writeConfig({
    ...getConfig(),
    auth: {
      apiKeyEntries: [
        entry("k-cc", "Claude Code"),
        entry("k-codex", "codex"),
        entry("k-ci", "CI runner"),
      ],
    },
    plugins: {
      demo: {
        enabled: true,
        ...(clients ? { clients } : {}),
        ...(access ? { access } : {}),
      },
    },
  })
}

const names = async (client: Client) =>
  (await client.listTools()).tools.map((tool) => tool.name)

describe("/mcp/<pluginId>: App Permissions", () => {
  test("legacy clients: a listed app is allowed, an unlisted app is blocked, connections and keyless callers keep access", async () => {
    configure(undefined, ["codex"])

    expect(await names(await connect("demo", bearer("k-codex")))).toHaveLength(
      4,
    )

    const blocked = await connect("demo", bearer("k-cc"))
    expect(await names(blocked)).toEqual([])
    const refused = await blocked.callTool({
      name: "echo",
      arguments: { text: "hi" },
    })
    expect(refused.isError).toBe(true)
    expect(refused.content).toEqual([
      {
        type: "text",
        text: "DEMO is blocked for Claude Code in Maximal. Change App Permissions in Settings to use it.",
      },
    ])

    expect(await names(await connect("demo", bearer("k-ci")))).toHaveLength(4)
    expect(await names(await connect("demo"))).toHaveLength(4)
  })

  test("an explicit access entry beats the legacy list, for apps and for named connections", async () => {
    configure({ "app:claude-code": "allow", "connection:k-ci": "block" }, [
      "codex",
    ])
    expect(await names(await connect("demo", bearer("k-cc")))).toHaveLength(4)
    const ci = await connect("demo", bearer("k-ci"))
    expect(await names(ci)).toEqual([])
    const refused = await ci.callTool({
      name: "echo",
      arguments: { text: "x" },
    })
    expect(refused.isError).toBe(true)
    expect(refused.content).toEqual([
      {
        type: "text",
        text: "DEMO is blocked for CI runner in Maximal. Change App Permissions in Settings to use it.",
      },
    ])
  })

  test("the aggregate filters and gates each connector independently", async () => {
    writeConfig({
      ...getConfig(),
      auth: { apiKeyEntries: [entry("k-codex", "codex")] },
      plugins: {
        demo: {
          enabled: true,
          access: { "app:codex": "block" },
        },
        other: {
          enabled: true,
          access: { "app:codex": "allow" },
        },
      },
    })
    const client = await connect(null, bearer("k-codex"))
    expect(await names(client)).toEqual(["other__echo"])

    const refused = await client.callTool({
      name: "demo__echo",
      arguments: { text: "x" },
    })
    expect(refused.isError).toBe(true)
    expect(refused.content).toEqual([
      {
        type: "text",
        text: "DEMO is blocked for Codex in Maximal. Change App Permissions in Settings to use it.",
      },
    ])
  })
})

describe("/mcp/<pluginId>: App Permissions, who is calling", () => {
  test("a key Maximal can't attribute is blocked, never exempt", async () => {
    writeConfig({
      ...getConfig(),
      auth: {
        apiKeys: ["legacy-bare-key-123"],
        apiKeyEntries: [entry("k-off", "codex", false)],
      },
      plugins: { demo: { enabled: true, access: { "app:codex": "allow" } } },
    })
    // Not enforcing, so these requests are accepted; each presents a key that
    // matches no enabled entry (disabled, legacy, never configured).
    for (const authorization of [
      "Bearer k-off-secret-key-123",
      "Bearer legacy-bare-key-123",
      "Bearer never-configured-key",
    ]) {
      const client = await connect("demo", { authorization })
      expect(await names(client)).toEqual([])
      const refused = await client.callTool({
        name: "echo",
        arguments: { text: "hi" },
      })
      expect(refused.isError).toBe(true)
      expect(refused.content).toEqual([
        {
          type: "text",
          text: "DEMO is blocked in Maximal for this API key because Maximal doesn't recognize it (it may be turned off or deleted). Use a key from Maximal's Settings.",
        },
      ])
    }
    // No key at all stays compatible, and so does Maximal's own shell key.
    expect(await names(await connect("demo"))).toHaveLength(4)
    useShellKey("shell-key-for-test-123")
    expect(
      await names(
        await connect("demo", {
          authorization: "Bearer shell-key-for-test-123",
        }),
      ),
    ).toHaveLength(4)
  })

  test("Claude Code's own prompt only covers the Claude Code app, and only tools its last list marked", async () => {
    const asked: Array<string> = []
    const elicit = (message: string) => {
      asked.push(message)
      return { action: "decline" as const }
    }
    const declined = (result: Awaited<ReturnType<Client["callTool"]>>) =>
      result.isError === true
      && JSON.stringify(result.content).includes("declined")

    // A client that only says it is Claude Code (keyless, or on another
    // key) is asked by Maximal like any other.
    configure({ "connection:k-ci": "ask" })
    const spoof = await connect("demo", bearer("k-ci"), {
      name: "claude-code",
      elicit,
    })
    await spoof.listTools()
    expect(
      declined(
        await spoof.callTool({ name: "echo", arguments: { text: "x" } }),
      ),
    ).toBe(true)
    const keyless = await connect("demo", {}, { name: "claude-code", elicit })
    await keyless.listTools()
    expect(
      declined(await keyless.callTool({ name: "count", arguments: {} })),
    ).toBe(true)
    expect(asked).toHaveLength(2)

    // The real app, listing first, is covered by its own prompt...
    asked.length = 0
    configure({ "app:claude-code": "allow" })
    const code = await connect("demo", bearer("k-cc"), {
      name: "claude-code",
      elicit,
    })
    const listed = await code.listTools()
    expect(
      listed.tools.some(
        (tool) => tool._meta?.["anthropic/requiresUserInteraction"] === true,
      ),
    ).toBe(true)
    // ...but a policy change it hasn't re-listed for hasn't asked anyone,
    // so Maximal asks (and with no elicitation, refuses).
    configure({ "app:claude-code": "ask" })
    expect(
      declined(await code.callTool({ name: "echo", arguments: { text: "x" } })),
    ).toBe(true)
    expect(asked).toHaveLength(1)
    const staleMute = await connect("demo", bearer("k-cc"), {
      name: "claude-code",
      elicit: false,
    })
    configure({ "app:claude-code": "allow" })
    await staleMute.listTools()
    configure({ "app:claude-code": "ask" })
    const refused = await staleMute.callTool({
      name: "echo",
      arguments: { text: "x" },
    })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain("can't show the question")
    // Re-listing under Ask marks every tool, and then the prompt counts.
    await staleMute.listTools()
    const ran = await staleMute.callTool({
      name: "echo",
      arguments: { text: "x" },
    })
    expect(ran.isError).toBeFalsy()
  })
})

describe("/mcp/<pluginId>: App Permissions, Ask and live changes", () => {
  test("Ask puts the question to the person before every call, even of an allowed tool", async () => {
    configure({ "app:codex": "ask" })
    const asked: Array<string> = []
    let answer: "accept" | "decline" = "accept"
    const client = await connect("demo", bearer("k-codex"), {
      elicit: (message) => {
        asked.push(message)
        return { action: answer }
      },
    })
    const { tools } = await client.listTools()
    // Every tool carries Claude Code's per-call prompt, including read-only echo.
    expect(
      tools.map(
        (tool) => tool._meta?.["anthropic/requiresUserInteraction"] === true,
      ),
    ).toEqual([true, true, true, true])

    const ran = await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
    })
    expect(ran.isError).toBeFalsy()
    expect(asked).toEqual(['Maximal: allow DEMO to run echo?\n{"text":"hi"}'])

    answer = "decline"
    const declined = await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
    })
    expect(declined.isError).toBe(true)
    expect(declined.content).toEqual([
      {
        type: "text",
        text: "You declined DEMO's echo call, so it wasn't run.",
      },
    ])
  })

  test("Ask refuses a client that can't show the question, and doesn't ask Claude Code twice", async () => {
    configure({ "app:codex": "ask", "app:claude-code": "ask" })
    const mute = await connect("demo", bearer("k-codex"), { elicit: false })
    const refused = await mute.callTool({
      name: "echo",
      arguments: { text: "hi" },
    })
    expect(refused.isError).toBe(true)
    expect(refused.content).toEqual([
      {
        type: "text",
        text: "DEMO asks before it runs for Codex in Maximal, and this client can't show the question, so it wasn't run. Change App Permissions in Settings to allow it.",
      },
    ])

    const asked: Array<string> = []
    const code = await connect("demo", bearer("k-cc"), {
      name: "claude-code",
      elicit: (message) => {
        asked.push(message)
        return { action: "decline" }
      },
    })
    await code.listTools()
    const ran = await code.callTool({
      name: "echo",
      arguments: { text: "hi" },
    })
    expect(ran.isError).toBeFalsy()
    expect(asked).toEqual([])
  })

  test("Ask doesn't prompt for a tool that is blocked anyway", async () => {
    configure({ "app:codex": "ask" })
    await plugins.gateway.setToolPermissions("demo", { echo: "block" })
    const asked: Array<string> = []
    const client = await connect("demo", bearer("k-codex"), {
      elicit: (message) => {
        asked.push(message)
        return { action: "accept" }
      },
    })
    const refused = await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
    })
    expect(refused.isError).toBe(true)
    expect(refused.content).toEqual([
      { type: "text", text: blockedToolText("DEMO", "echo") },
    ])
    expect(asked).toEqual([])
  })

  test("changing an App Permission sends list_changed and applies to the open session", async () => {
    configure({ "app:codex": "allow" })
    const client = await connect("demo", bearer("k-codex"))
    const other = await connect("demo", bearer("k-ci"))
    let changed = 0
    let otherChanged = 0
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      changed += 1
    })
    other.setNotificationHandler("notifications/tools/list_changed", () => {
      otherChanged += 1
    })
    // Let each session's standalone stream open before the change.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await names(client)).toHaveLength(4)

    configure({ "app:codex": "block" })
    notifyPluginAccessChanged("demo")
    await waitFor(() => changed > 0 && otherChanged > 0)
    expect(await names(client)).toEqual([])
    const refused = await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
    })
    expect(refused.isError).toBe(true)

    // Allowing it again restores the same session without reconnecting.
    const before = changed
    configure({ "app:codex": "allow" })
    notifyPluginAccessChanged("demo")
    await waitFor(() => changed > before)
    expect(await names(client)).toHaveLength(4)
  })

  test("a session belongs to the caller that opened it", async () => {
    configure(undefined)
    const client = await connect("demo", bearer("k-codex"))
    const sessionId = client.transport?.sessionId
    expect(sessionId).toBeString()
    const response = await fetch(`${app.origin}/mcp/demo`, {
      method: "POST",
      headers: {
        ...bearer("k-ci"),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId ?? "",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(response.status).toBe(404)
  })
})
