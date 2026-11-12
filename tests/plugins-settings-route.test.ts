/**
 * `/settings/api/plugins` through the real app with a real gateway composed
 * from inline plugins: list, detail, enable/clients/config PATCH, tool
 * permissions, actions, plus the plugin counts on `/status` and the
 * `plugins.changed` Settings event.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"

import { getConfig } from "~/lib/config/config"
import { settingsEventBus } from "~/lib/config/settings-events"
import {
  PluginDetailView,
  PluginsListResponse,
  type PluginsListResponse as PluginsListResponseT,
  PluginValidationErrorResponse,
} from "~/lib/config/settings-types"
import { notifyPluginsChanged } from "~/lib/plugins/runtime"
import { server } from "~/server"

import {
  definePlugin,
  startTestGateway,
  type TestGateway,
  waitFor,
} from "./helpers/plugins"

let actionCalls = 0
let alphaApplies = 0
let releaseSlowAction: (() => void) | undefined

const alpha = definePlugin("alpha", (ctx) => {
  alphaApplies += 1
  ctx.surface.setStatus({
    state: "needs-setup",
    code: "signin-needed",
    summary: "Sign in to continue.",
    facts: [{ label: "Account", value: "none" }],
    actions: [{ id: "sign-in", label: "Sign in", kind: "primary" }],
  })
  ctx.surface.registerAction("sign-in", async () => {
    actionCalls += 1
    await new Promise<void>((resolve) => {
      releaseSlowAction = resolve
    })
    ctx.surface.setStatus({
      state: "ready",
      code: "ready",
      summary: "Signed in.",
    })
  })
  ctx.surface.registerAction("open", () =>
    ctx.host.openExternal("https://example.test/terms"),
  )
  ctx.tools.registerAll([
    {
      name: "search",
      description: "Search.",
      inputSchema: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
      annotations: { readOnlyHint: true },
      execute: () => Promise.resolve({ content: [] }),
    },
    {
      name: "delete_item",
      title: "Delete item",
      description: "Delete.",
      inputSchema: { type: "object" },
      annotations: { destructiveHint: true },
      execute: () => Promise.resolve({ content: [] }),
    },
    {
      name: "poke",
      description: "Poke.",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve({ content: [] }),
    },
  ])
})

const beta = definePlugin("beta", () => {
  throw new Error("cannot start")
})

const gamma = definePlugin(
  "gamma",
  (ctx) => {
    ctx.tools.register({
      name: "inner",
      description: "Inner.",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve({ content: [] }),
    })
  },
  { kind: "extension" },
)

let plugins: TestGateway

beforeEach(async () => {
  actionCalls = 0
  alphaApplies = 0
  releaseSlowAction = undefined
  plugins = await startTestGateway([alpha, beta, gamma])
})

afterEach(async () => {
  releaseSlowAction?.()
  await plugins.dispose()
})

async function list(): Promise<PluginsListResponseT> {
  const response = await server.request("/settings/api/plugins")
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  return PluginsListResponse.parse(body)
}

function send(
  method: "PATCH" | "PUT",
  url: string,
  body: unknown,
): Promise<Response> {
  return Promise.resolve(
    server.request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

function patch(id: string, body: unknown): Promise<Response> {
  return send("PATCH", `/settings/api/plugins/${id}`, body)
}

function putPermissions(id: string, body: unknown): Promise<Response> {
  return send("PUT", `/settings/api/plugins/${id}/tool-permissions`, body)
}

async function detail(response: Response): Promise<PluginDetailView> {
  expect(response.status).toBe(200)
  return PluginDetailView.parse(await response.json())
}

async function get(id: string): Promise<PluginDetailView> {
  return detail(await server.request(`/settings/api/plugins/${id}`))
}

async function invalid(
  response: Response,
): Promise<PluginValidationErrorResponse> {
  expect(response.status).toBe(400)
  return PluginValidationErrorResponse.parse(await response.json())
}

async function settingsFile(id: string): Promise<unknown> {
  const file = Bun.file(path.join(plugins.storageRoot, id, "settings.json"))
  return (await file.json()) as unknown
}

const permissionsOf = (view: PluginDetailView) =>
  Object.fromEntries(
    view.tools.map((tool) => [
      tool.name,
      `${tool.permission}/${tool.permissionSource}`,
    ]),
  )

describe("GET /settings/api/plugins", () => {
  test("lists every plugin, off by default, with manifest, counts, clients and endpoint", async () => {
    const response = await server.request("/settings/api/plugins")
    const raw = await response.text()
    // The manifest's auth details never leave the server.
    expect(raw).not.toContain("00000000-0000-4000-8000-000000000001")
    expect(raw).not.toContain("login.example.test")
    expect(raw).not.toContain("api://example")
    const { plugins: views } = PluginsListResponse.parse(JSON.parse(raw))
    expect(views.map((view) => view.id)).toEqual(["alpha", "beta", "gamma"])
    expect(views[0].endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/alpha$/)
    expect(views[0]).toEqual({
      id: "alpha",
      kind: "connector",
      source: "built-in",
      displayName: "ALPHA",
      description: "alpha plugin",
      manifest: {
        id: "alpha",
        kind: "connector",
        displayName: "ALPHA",
        description: "alpha plugin",
        connector: {
          transport: "streamable-http",
          endpoint: "https://alpha.example.test/mcp",
          auth: { type: "entra" },
          terms: { url: "https://example.test/terms", label: "Terms" },
        },
      },
      enabled: false,
      lifecycle: "disabled",
      toolCounts: {
        total: 0,
        byGroup: { "read-only": 0, "write-delete": 0, other: 0 },
      },
      toolsSource: "none",
      clients: [
        {
          id: "claude-code",
          selected: false,
          available: false,
          reason: "Turn on Claude Code in Maximal first.",
        },
        {
          id: "claude-desktop",
          selected: false,
          available: false,
          reason:
            "Claude Desktop only accepts local MCP processes here; Maximal can't add this HTTP connector.",
        },
        {
          id: "codex",
          selected: false,
          available: false,
          reason: "Maximal doesn't add connectors to Codex yet.",
        },
        {
          id: "copilot-cli",
          selected: false,
          available: false,
          reason: "Copilot CLI integration is coming soon.",
        },
      ],
      endpoint: views[0].endpoint,
    })
  })

  test("an extension has no MCP endpoint or client connections", async () => {
    const { plugins: views } = await list()
    expect(views[2]).toMatchObject({
      id: "gamma",
      kind: "extension",
      clients: [],
      endpoint: "",
    })
    expect(views[2].manifest.connector).toBeUndefined()
  })

  test("counts tools per permission group once running", async () => {
    await patch("alpha", { enabled: true })
    const { plugins: views } = await list()
    expect(views[0]).toMatchObject({
      toolsSource: "live",
      toolCounts: {
        total: 3,
        byGroup: { "read-only": 1, "write-delete": 1, other: 1 },
      },
    })
  })
})

describe("GET /settings/api/plugins/:id", () => {
  test("the detail adds config, schema version and every tool with full schemas", async () => {
    await patch("alpha", { enabled: true })
    // The catalog cache is written in the background.
    await waitFor(
      () => plugins.gateway.get("alpha")?.catalogUpdatedAt !== undefined,
    )
    const view = await get("alpha")
    expect(view).toMatchObject({
      id: "alpha",
      lifecycle: "active",
      settingsVersion: 1,
      config: { greeting: "hi" },
      toolsSource: "live",
    })
    expect(view.catalogUpdatedAt).toBeString()
    expect(view.tools).toEqual([
      {
        name: "search",
        description: "Search.",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
        annotations: { readOnlyHint: true },
        group: "read-only",
        permission: "allow",
        permissionSource: "default",
      },
      {
        name: "delete_item",
        title: "Delete item",
        description: "Delete.",
        inputSchema: { type: "object" },
        annotations: { destructiveHint: true },
        group: "write-delete",
        // Anything that may change something asks by default.
        permission: "ask",
        permissionSource: "default",
      },
      {
        name: "poke",
        description: "Poke.",
        inputSchema: { type: "object" },
        group: "other",
        permission: "ask",
        permissionSource: "default",
      },
    ])
  })

  test("a stopped connector shows its cached tool catalog", async () => {
    await patch("alpha", { enabled: true })
    await waitFor(
      () => plugins.gateway.get("alpha")?.catalogUpdatedAt !== undefined,
    )
    await patch("alpha", { enabled: false })
    const view = await get("alpha")
    expect(view.lifecycle).toBe("disabled")
    expect(view.toolsSource).toBe("cache")
    expect(view.catalogUpdatedAt).toBeString()
    expect(view.tools.map((tool) => tool.name)).toEqual([
      "search",
      "delete_item",
      "poke",
    ])
  })

  test("404 for an unknown plugin", async () => {
    const response = await server.request("/settings/api/plugins/nope")
    expect(response.status).toBe(404)
  })
})

describe("PATCH /settings/api/plugins/:id", () => {
  test("turning a plugin on persists, starts it and returns its detail", async () => {
    const view = await detail(await patch("alpha", { enabled: true }))
    expect(view).toMatchObject({
      id: "alpha",
      enabled: true,
      lifecycle: "active",
      status: { state: "needs-setup", code: "signin-needed" },
    })
    expect(view.tools.map((tool) => tool.name)).toContain("search")
    expect(getConfig().plugins?.alpha).toEqual({ enabled: true })
  })

  test("records the client choice", async () => {
    const view = await detail(
      await patch("alpha", { clients: ["claude-code"] }),
    )
    expect(view.clients[0]).toMatchObject({ id: "claude-code", selected: true })
    expect(getConfig().plugins?.alpha).toEqual({ clients: ["claude-code"] })
  })

  test("a valid config goes to the settings file and reloads the plugin", async () => {
    await patch("alpha", { enabled: true })
    expect(alphaApplies).toBe(1)
    const view = await detail(
      await patch("alpha", {
        config: { greeting: "yo", endpoint: "https://override.test/mcp" },
      }),
    )
    expect(view.config).toEqual({
      greeting: "yo",
      endpoint: "https://override.test/mcp",
    })
    // The connector info shows the upstream in effect.
    expect(view.manifest.connector?.endpoint).toBe("https://override.test/mcp")
    expect(alphaApplies).toBe(2)
    expect(await settingsFile("alpha")).toMatchObject({
      $schema: "maximal-plugin-settings/1",
      plugin: "alpha",
      version: 1,
      config: { greeting: "yo", endpoint: "https://override.test/mcp" },
    })
    // config.json keeps on/off and clients only.
    expect(getConfig().plugins?.alpha).toEqual({ enabled: true })
  })

  test("a config the plugin rejects is a 400 with issues and changes nothing", async () => {
    const body = await invalid(
      await patch("alpha", {
        enabled: true,
        config: { endpoint: "not a url", greeting: 3 },
      }),
    )
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.issues.map((issue) => issue.path).sort()).toEqual([
      "config.endpoint",
      "config.greeting",
    ])
    expect(body.error.message).toContain("config.endpoint")
    expect(getConfig().plugins?.alpha).toBeUndefined()
    expect(plugins.gateway.get("alpha")?.lifecycle).toBe("disabled")
  })

  test("a plugin whose apply throws is failed with the reason", async () => {
    const view = await detail(await patch("beta", { enabled: true }))
    expect(view).toMatchObject({ lifecycle: "failed", error: "cannot start" })
  })

  test("rejects bad bodies with issues, and unknown plugins", async () => {
    expect(
      (await invalid(await patch("alpha", { enabled: "yes" }))).issues,
    ).toEqual([{ path: "enabled", message: expect.any(String) as string }])
    await invalid(await patch("alpha", { clients: ["unknown-client"] }))
    await invalid(await patch("alpha", { extra: true }))
    await invalid(await patch("alpha", { config: "x" }))
    const notJson = await server.request("/settings/api/plugins/alpha", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    })
    expect(notJson.status).toBe(400)
    expect((await patch("nope", { enabled: true })).status).toBe(404)
  })
})

describe("PUT /settings/api/plugins/:id/tool-permissions", () => {
  test("blocks and clears tools without reloading the plugin", async () => {
    await patch("alpha", { enabled: true })
    const blocked = await detail(
      await putPermissions("alpha", {
        permissions: { delete_item: "block", poke: "allow" },
      }),
    )
    expect(permissionsOf(blocked)).toEqual({
      search: "allow/default",
      delete_item: "block/user",
      poke: "allow/user",
    })
    expect(await settingsFile("alpha")).toMatchObject({
      tools: { permissions: { delete_item: "block", poke: "allow" } },
    })
    // Blocked tools stay listed, marked so the MCP layer can say they're off.
    expect(
      plugins.gateway
        .listTools("alpha")
        .map((tool) => `${tool.name}:${tool.permission}`),
    ).toEqual(["search:allow", "delete_item:block", "poke:allow"])
    expect(alphaApplies).toBe(1)

    const cleared = await detail(
      await putPermissions("alpha", { permissions: { poke: null } }),
    )
    expect(permissionsOf(cleared).poke).toBe("ask/default")
    expect(permissionsOf(cleared).delete_item).toBe("block/user")
  })

  test("works while the connector is off (choices for cached or future tools)", async () => {
    const view = await detail(
      await putPermissions("alpha", { permissions: { later: "block" } }),
    )
    expect(view.lifecycle).toBe("disabled")
    expect(await settingsFile("alpha")).toMatchObject({
      tools: { permissions: { later: "block" } },
    })
  })

  test("rejects bad bodies with issues, and unknown plugins", async () => {
    const unknown = await invalid(
      await putPermissions("alpha", { permissions: { search: "maybe" } }),
    )
    expect(unknown.issues[0].path).toBe("permissions.search")
    await invalid(
      await putPermissions("alpha", { permissions: { "bad name": "block" } }),
    )
    await invalid(await putPermissions("alpha", { search: "block" }))
    expect(
      (await putPermissions("nope", { permissions: { a: "block" } })).status,
    ).toBe(404)
  })
})

function post(id: string, actionId: string): Promise<Response> {
  return Promise.resolve(
    server.request(`/settings/api/plugins/${id}/actions/${actionId}`, {
      method: "POST",
    }),
  )
}

describe("POST /settings/api/plugins/:id/actions/:actionId", () => {
  test("answers 202 at once while the action runs on", async () => {
    await patch("alpha", { enabled: true })
    const response = await post("alpha", "sign-in")
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ ok: true })
    expect(actionCalls).toBe(1)
    expect(plugins.gateway.get("alpha")?.status?.code).toBe("signin-needed")
    releaseSlowAction?.()
    await waitFor(() => plugins.gateway.get("alpha")?.status?.code === "ready")
  })

  test("actions reach the host services (browser)", async () => {
    await patch("alpha", { enabled: true })
    expect((await post("alpha", "open")).status).toBe(202)
    expect(plugins.opened).toEqual(["https://example.test/terms"])
  })

  test("404 for an unknown plugin or action, 409 when not running", async () => {
    expect((await post("nope", "sign-in")).status).toBe(404)
    expect((await post("alpha", "sign-in")).status).toBe(409)
    await patch("alpha", { enabled: true })
    expect((await post("alpha", "nope")).status).toBe(404)
  })
})

describe("plugin state outside Settings", () => {
  test("/status counts active and failed plugins", async () => {
    await patch("alpha", { enabled: true })
    await patch("beta", { enabled: true })
    const body = (await (await server.request("/status")).json()) as {
      subsystems: { plugins: unknown }
    }
    expect(body.subsystems.plugins).toEqual({ active: 1, failed: 1 })
  })

  test("plugins.changed carries the same shape as the GET", async () => {
    const events: Array<PluginsListResponseT> = []
    const unsubscribe = settingsEventBus.subscribe(
      "plugins.changed",
      (event) => {
        events.push(event)
      },
    )
    try {
      notifyPluginsChanged()
      await waitFor(() => events.length > 0)
      expect(PluginsListResponse.parse(events[0]).plugins).toHaveLength(3)
    } finally {
      unsubscribe()
    }
  })
})
