/**
 * Plugin notices (`ctx.surface.notify`) reach the menu-bar shell: the
 * serving process queues each with the plugin's name, and
 * POST /settings/api/notices/plugins hands them over once, oldest first.
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { writeConfig } from "~/lib/config/config"
import { composePluginGateway } from "~/lib/plugins/compose"
import { takePluginNotices } from "~/lib/plugins/notices"
import { startPlugins, stopPlugins } from "~/lib/plugins/runtime"
import { noticesRoutes } from "~/routes/settings/notices"

import { definePlugin, waitFor } from "./helpers/plugins"

const noisy = definePlugin("noisy", (ctx) => {
  ctx.surface.notify({
    code: "connected",
    message: "Noisy is connected as ada@contoso.com.",
    params: { connector: "Noisy", account: "ada@contoso.com" },
  })
  ctx.surface.notify({ code: "custom", message: "Something else." })
})

let storageRoot: string

beforeEach(() => {
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-notices-"))
  takePluginNotices()
})

afterEach(async () => {
  await stopPlugins()
  writeConfig({})
  fs.rmSync(storageRoot, { recursive: true, force: true })
})

async function take(): Promise<unknown> {
  const res = await noticesRoutes.request("/plugins", { method: "POST" })
  expect(res.status).toBe(200)
  return ((await res.json()) as { notices: unknown }).notices
}

test("a plugin's notices are handed to the shell once, with its name", async () => {
  writeConfig({ plugins: { noisy: { enabled: true } } })
  const gateway = composePluginGateway({ plugins: [noisy], storageRoot })
  await startPlugins({ gateway })
  await waitFor(() => gateway.get("noisy")?.lifecycle === "active")

  expect(await take()).toEqual([
    {
      plugin: "noisy",
      name: "NOISY",
      code: "connected",
      message: "Noisy is connected as ada@contoso.com.",
      params: { connector: "Noisy", account: "ada@contoso.com" },
    },
    {
      plugin: "noisy",
      name: "NOISY",
      code: "custom",
      message: "Something else.",
      params: {},
    },
  ])
  expect(await take()).toEqual([])
})

test("an invalid notice is refused and nothing is queued", async () => {
  const bad = definePlugin("bad", (ctx) => {
    ctx.surface.notify({ code: "Not A Code", message: "x" })
  })
  writeConfig({ plugins: { bad: { enabled: true } } })
  const gateway = composePluginGateway({ plugins: [bad], storageRoot })
  await startPlugins({ gateway })
  await waitFor(() => {
    const lifecycle = gateway.get("bad")?.lifecycle
    return lifecycle === "failed" || lifecycle === "active"
  })
  expect(gateway.get("bad")?.lifecycle).toBe("failed")
  expect(await take()).toEqual([])
})
