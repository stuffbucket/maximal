/**
 * `GET /settings/api/plugins/attention` through the real app: which enabled
 * plugins ask for the person now, which the tray polls. A disabled plugin is
 * never listed; the action runs through the existing actions route.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { PluginsAttentionResponse } from "~/lib/config/settings-types"
import { setPluginGateway } from "~/lib/plugins/gateway"
import { server } from "~/server"

import {
  definePlugin,
  startTestGateway,
  type TestGateway,
  waitFor,
} from "./helpers/plugins"

let approved = 0

const asks = definePlugin(
  "asks",
  (ctx) => {
    const actions = [
      { id: "approve-lynx", label: 'Approve "lynx"', kind: "primary" as const },
      { id: "deny-lynx", label: 'Deny "lynx"' },
    ]
    ctx.surface.setStatus({
      state: "ready",
      code: "ready",
      summary: "Ready",
      actions,
      attention: { summary: 'A panel ("lynx") wants to connect', actions },
    })
    ctx.surface.registerAction("approve-lynx", () => {
      approved += 1
      ctx.surface.setStatus({ state: "ready", code: "ready", summary: "Ready" })
      return Promise.resolve()
    })
    ctx.surface.registerAction("deny-lynx", () => Promise.resolve())
  },
  { kind: "extension" },
)

const quiet = definePlugin(
  "quiet",
  (ctx) => {
    ctx.surface.setStatus({ state: "ready", code: "ready", summary: "Ready" })
  },
  { kind: "extension" },
)

let plugins: TestGateway

beforeEach(() => {
  approved = 0
})

afterEach(async () => {
  await plugins.dispose()
})

async function attention() {
  const response = await server.request("/settings/api/plugins/attention")
  expect(response.status).toBe(200)
  return PluginsAttentionResponse.parse(await response.json()).attention
}

describe("GET /settings/api/plugins/attention", () => {
  test("lists an enabled plugin that asks, with its actions, and skips one that does not", async () => {
    plugins = await startTestGateway([asks, quiet], ["asks", "quiet"])
    expect(await attention()).toEqual([
      {
        plugin: "asks",
        name: "ASKS",
        summary: 'A panel ("lynx") wants to connect',
        actions: [
          { id: "approve-lynx", label: 'Approve "lynx"', kind: "primary" },
          { id: "deny-lynx", label: 'Deny "lynx"' },
        ],
      },
    ])
  })

  test("a disabled plugin does not appear, and appears once enabled", async () => {
    plugins = await startTestGateway([asks, quiet], ["quiet"])
    expect(await attention()).toEqual([])

    await plugins.gateway.reconcile({
      asks: { enabled: true },
      quiet: { enabled: true },
    })
    expect((await attention()).map((item) => item.plugin)).toEqual(["asks"])

    await plugins.gateway.reconcile({ quiet: { enabled: true } })
    expect(await attention()).toEqual([])
  })

  test("running an action through the actions route clears the attention", async () => {
    plugins = await startTestGateway([asks], ["asks"])
    const response = await server.request(
      "/settings/api/plugins/asks/actions/approve-lynx",
      { method: "POST" },
    )
    expect(response.status).toBe(202)
    await waitFor(
      () => plugins.gateway.get("asks")?.status?.attention === undefined,
    )
    expect(await attention()).toEqual([])
    expect(approved).toBe(1)
  })

  test("is empty, not an error, when plugins are not running", async () => {
    plugins = await startTestGateway([asks], ["asks"])
    setPluginGateway(undefined)
    expect(await attention()).toEqual([])
  })
})
