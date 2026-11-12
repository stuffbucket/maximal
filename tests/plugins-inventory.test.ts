/** Production composition of the strict data-only inventory into the mutable host. */

import type { PluginModule } from "@stuffbucket/maximal-plugin-sdk"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { type AppConfig, getConfig, writeConfig } from "~/lib/config/config"
import {
  composePluginGateway,
  reloadComposedPluginInventory,
} from "~/lib/plugins/compose"
import { startPlugins, stopPlugins } from "~/lib/plugins/runtime"

import { definePlugin } from "./helpers/plugins"

const schema = "maximal-plugin-inventory/1"

function plugin(id: string, version: string, toolName = "read"): PluginModule {
  return definePlugin(id, (ctx) => {
    ctx.tools.register({
      name: toolName,
      description: `${id} ${version}`,
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      execute: () => Promise.resolve({ content: [] }),
    })
    ctx.surface.setStatus({
      state: "ready",
      code: version,
      summary: `${id} ${version}`,
    })
  })
}

let root: string
let storageRoot: string
const gateways: Array<ReturnType<typeof composePluginGateway>> = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-inventory-"))
  storageRoot = path.join(root, "storage")
  fs.mkdirSync(storageRoot)
  writeConfig({})
})

afterEach(async () => {
  await stopPlugins()
  await Promise.all(gateways.splice(0).map((gateway) => gateway.dispose()))
  writeConfig({})
  fs.rmSync(root, { recursive: true, force: true })
})

function write(name: string, value: unknown): void {
  fs.writeFileSync(path.join(root, name), JSON.stringify(value))
}

describe("trusted built-in plugin inventory", () => {
  test("production boot applies the configured override before reconcile", async () => {
    const alpha = plugin("alpha", "alpha")
    const beta = plugin("beta", "beta")
    const gateway = composePluginGateway({
      plugins: [alpha, beta],
      storageRoot,
      inventory: { rootDirectory: root },
    })
    gateways.push(gateway)
    write("inventory.json", {
      $schema: schema,
      plugins: [{ id: "alpha", descriptorId: "alpha" }],
    })
    writeConfig({
      pluginInventory: { entry: "inventory.json" },
      plugins: { alpha: { enabled: true }, beta: { enabled: true } },
    })

    const started = await startPlugins({ gateway })

    expect(started?.list().map((item) => item.id)).toEqual(["alpha"])
    expect(started?.get("alpha")?.lifecycle).toBe("active")
  })

  test("expands nested includes/groups and transactionally adds, removes, and replaces", async () => {
    const alphaOld = plugin("alpha", "old")
    const alphaNew = plugin("alpha", "new")
    const beta = plugin("beta", "beta")
    const gamma = plugin("gamma", "gamma")
    const gateway = composePluginGateway({
      plugins: [alphaOld, beta],
      storageRoot,
      inventory: {
        rootDirectory: root,
        catalog: [
          { descriptorId: "alpha-old", module: alphaOld },
          { descriptorId: "alpha-new", module: alphaNew },
          { descriptorId: "beta", module: beta },
          { descriptorId: "gamma", module: gamma },
        ],
      },
    })
    gateways.push(gateway)
    const config: AppConfig = {
      pluginInventory: { entry: "root.json" },
      plugins: {
        alpha: { enabled: true, clients: ["claude-code"] },
        beta: { enabled: true },
        gamma: { enabled: true },
      },
      budget: {
        limits: [
          {
            id: "alpha-budget",
            scope: { kind: "plugin", id: "alpha" },
            limit: 1_000_000_000,
            limitReset: "daily",
            action: "block",
          },
        ],
      },
    }
    writeConfig(config)
    await gateway.reconcile(config.plugins)
    await gateway.updateConfig("alpha", { greeting: "kept" })
    await gateway.setToolPermissions("alpha", { read: "block" })

    write("child.json", {
      $schema: schema,
      plugins: [
        { id: "alpha", descriptorId: "alpha-new" },
        { id: "gamma", descriptorId: "gamma" },
      ],
      groups: [
        {
          id: "inner",
          members: [{ plugin: "alpha" }, { plugin: "gamma" }],
        },
      ],
    })
    write("root.json", {
      $schema: schema,
      includes: ["child.json"],
      plugins: [{ id: "beta", descriptorId: "beta" }],
      groups: [
        {
          id: "outer",
          members: [{ group: "inner" }, { plugin: "beta" }],
        },
      ],
      members: [{ group: "outer" }],
      disabled: [{ plugin: "beta" }],
    })

    await reloadComposedPluginInventory(gateway, config.pluginInventory)

    expect(gateway.list().map((item) => item.id)).toEqual(["alpha", "gamma"])
    expect(gateway.get("alpha")).toMatchObject({
      lifecycle: "active",
      config: { greeting: "kept" },
      source: { type: "built-in" },
      status: { code: "new" },
    })
    expect(gateway.toolViews("alpha")[0]).toMatchObject({
      name: "read",
      permission: "block",
      permissionSource: "user",
    })
    expect(gateway.get("gamma")?.lifecycle).toBe("active")
    expect(gateway.get("beta")).toBeUndefined()
    expect(getConfig().plugins).toEqual(config.plugins)
    expect(getConfig().budget).toEqual(config.budget)
  })

  test("keeps the last good runtime when a reload becomes invalid", async () => {
    const alphaOld = plugin("alpha", "old")
    const alphaNew = plugin("alpha", "new")
    const beta = plugin("beta", "beta")
    const gateway = composePluginGateway({
      plugins: [alphaOld, beta],
      storageRoot,
      inventory: {
        rootDirectory: root,
        catalog: [
          { descriptorId: "alpha-old", module: alphaOld },
          { descriptorId: "alpha-new", module: alphaNew },
          { descriptorId: "beta", module: beta },
        ],
      },
    })
    gateways.push(gateway)
    await gateway.reconcile({
      alpha: { enabled: true },
      beta: { enabled: true },
    })
    write("inventory.json", {
      $schema: schema,
      plugins: [{ id: "alpha", descriptorId: "alpha-new" }],
    })
    const configured = { entry: "inventory.json" }

    await reloadComposedPluginInventory(gateway, configured)
    expect(gateway.list().map((item) => item.id)).toEqual(["alpha"])
    expect(gateway.get("alpha")?.status?.code).toBe("new")

    fs.writeFileSync(path.join(root, "inventory.json"), "{ not json")
    await reloadComposedPluginInventory(gateway, configured)

    expect(gateway.list().map((item) => item.id)).toEqual(["alpha"])
    expect(gateway.get("alpha")?.status?.code).toBe("new")
  })
})
