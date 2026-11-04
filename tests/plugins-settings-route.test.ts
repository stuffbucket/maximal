/**
 * `/settings/api/plugins` through the real app with a real gateway composed
 * from inline plugins, plus the plugin counts on `/status` and the
 * `plugins.changed` Settings event.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { getConfig, writeConfig } from "~/lib/config/config"
import { settingsEventBus } from "~/lib/config/settings-events"
import {
  PluginsListResponse,
  type PluginsListResponse as PluginsListResponseT,
  PluginView,
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
let releaseSlowAction: (() => void) | undefined

const alpha = definePlugin("alpha", (ctx) => {
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
  ctx.tools.register({
    name: "search",
    description: "Search.",
    inputSchema: { type: "object" },
    execute: () => Promise.resolve({ content: [] }),
  })
})

const beta = definePlugin("beta", () => {
  throw new Error("cannot start")
})

let plugins: TestGateway

beforeEach(async () => {
  actionCalls = 0
  releaseSlowAction = undefined
  plugins = await startTestGateway([alpha, beta])
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

function patch(id: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    server.request(`/settings/api/plugins/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

describe("GET /settings/api/plugins", () => {
  test("lists every plugin, off by default, with clients and endpoint", async () => {
    const { plugins: views } = await list()
    expect(views.map((view) => view.id)).toEqual(["alpha", "beta"])
    expect(views[0].endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/alpha$/)
    expect(views[0]).toEqual({
      id: "alpha",
      displayName: "ALPHA",
      description: "alpha plugin",
      enabled: false,
      lifecycle: "disabled",
      tools: [],
      clients: [
        {
          id: "claude-code",
          selected: false,
          available: false,
          reason: "Turn on Claude Code in Maximal first.",
        },
      ],
      endpoint: views[0].endpoint,
    })
  })
})

describe("PATCH /settings/api/plugins/:id", () => {
  test("turning a plugin on persists, starts it and returns its view", async () => {
    const response = await patch("alpha", { enabled: true })
    expect(response.status).toBe(200)
    const view = PluginView.parse(await response.json())
    expect(view).toMatchObject({
      id: "alpha",
      enabled: true,
      lifecycle: "active",
      status: { state: "needs-setup", code: "signin-needed" },
      tools: [{ name: "search", description: "Search." }],
    })
    expect(getConfig().plugins?.alpha).toEqual({ enabled: true })
  })

  test("records the client choice and keeps the plugin's own config", async () => {
    writeConfig({
      ...getConfig(),
      plugins: { alpha: { enabled: false, config: { greeting: "yo" } } },
    })
    const response = await patch("alpha", { clients: ["claude-code"] })
    expect(response.status).toBe(200)
    const view = PluginView.parse(await response.json())
    expect(view.clients[0]).toMatchObject({ id: "claude-code", selected: true })
    expect(getConfig().plugins?.alpha).toEqual({
      enabled: false,
      config: { greeting: "yo" },
      clients: ["claude-code"],
    })
  })

  test("a plugin whose apply throws is failed with the reason", async () => {
    const view = PluginView.parse(
      await (await patch("beta", { enabled: true })).json(),
    )
    expect(view).toMatchObject({ lifecycle: "failed", error: "cannot start" })
  })

  test("rejects bad bodies and unknown plugins", async () => {
    expect((await patch("alpha", { enabled: "yes" })).status).toBe(400)
    expect((await patch("alpha", { clients: ["claude-desktop"] })).status).toBe(
      400,
    )
    expect((await patch("alpha", { extra: true })).status).toBe(400)
    expect((await patch("nope", { enabled: true })).status).toBe(404)
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
      expect(PluginsListResponse.parse(events[0]).plugins).toHaveLength(2)
    } finally {
      unsubscribe()
    }
  })
})
