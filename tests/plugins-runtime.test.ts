/**
 * Plugin boot in the serving process (`startPlugins`): the one-shot move of
 * legacy `config.json` → `plugins.<id>.config` values into each plugin's
 * settings file, and `plugins.changed` on every kind of gateway event.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { PluginsListResponse } from "~/lib/config/settings-types"

import { getConfig, writeConfig } from "~/lib/config/config"
import { validateAppConfig } from "~/lib/config/config-schema"
import { settingsEventBus } from "~/lib/config/settings-events"
import { composePluginGateway } from "~/lib/plugins/compose"
import { startPlugins, stopPlugins } from "~/lib/plugins/runtime"

import { definePlugin, waitFor } from "./helpers/plugins"

const alpha = definePlugin("alpha", (ctx) => {
  ctx.tools.register({
    name: "search",
    description: "Search.",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
    execute: () => Promise.resolve({ content: [] }),
  })
})
const beta = definePlugin("beta", () => undefined)

let storageRoot: string

/** What the boot migration adds for the default-on plugins. */
const DEFAULT_ON = {
  decisions: { enabled: true },
  systemone: { enabled: true },
}

function settingsPath(id: string): string {
  return path.join(storageRoot, id, "settings.json")
}

function boot() {
  return startPlugins({
    gateway: composePluginGateway({ plugins: [alpha, beta], storageRoot }),
  })
}

beforeEach(() => {
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-runtime-"))
})

afterEach(async () => {
  await stopPlugins()
  writeConfig({})
  fs.rmSync(storageRoot, { recursive: true, force: true })
})

describe("startPlugins", () => {
  test("moves a legacy config.json config into the settings file, once", async () => {
    writeConfig(
      validateAppConfig({
        plugins: {
          alpha: { enabled: true, config: { greeting: "legacy" } },
          beta: { enabled: false, clients: ["claude-code"] },
          ghost: { config: { kept: true } },
        },
      }),
    )
    const gateway = await boot()
    expect(gateway?.get("alpha")).toMatchObject({
      lifecycle: "active",
      config: { greeting: "legacy" },
    })
    const file: unknown = await Bun.file(settingsPath("alpha")).json()
    expect(file).toMatchObject({ version: 1, config: { greeting: "legacy" } })
    const plugins: unknown = getConfig().plugins
    expect(plugins).toEqual({
      alpha: { enabled: true },
      beta: { enabled: false, clients: ["claude-code"] },
      // Unknown ids are left alone.
      ghost: { config: { kept: true } },
      ...DEFAULT_ON,
    })
  })

  test("the settings file wins over a stale legacy value", async () => {
    fs.mkdirSync(path.join(storageRoot, "alpha"), { recursive: true })
    fs.writeFileSync(
      settingsPath("alpha"),
      JSON.stringify({
        $schema: "maximal-plugin-settings/1",
        plugin: "alpha",
        version: 1,
        config: { greeting: "file" },
      }),
    )
    writeConfig(
      validateAppConfig({
        plugins: { alpha: { enabled: true, config: { greeting: "legacy" } } },
      }),
    )
    const gateway = await boot()
    expect(gateway?.get("alpha")?.config).toEqual({ greeting: "file" })
    expect(getConfig().plugins).toEqual({
      alpha: { enabled: true },
      ...DEFAULT_ON,
    })
  })

  test("an unreadable settings file keeps the legacy value for next time", async () => {
    fs.mkdirSync(path.join(storageRoot, "alpha"), { recursive: true })
    fs.writeFileSync(settingsPath("alpha"), "{ not json")
    writeConfig(
      validateAppConfig({
        plugins: { alpha: { enabled: true, config: { greeting: "legacy" } } },
      }),
    )
    const gateway = await boot()
    expect(gateway?.get("alpha")?.lifecycle).toBe("failed")
    const plugins: unknown = getConfig().plugins
    expect(plugins).toEqual({
      alpha: { enabled: true, config: { greeting: "legacy" } },
      ...DEFAULT_ON,
    })
    expect(fs.readFileSync(settingsPath("alpha"), "utf8")).toBe("{ not json")
  })

  test("Settings hears about settings changes (plugins.changed)", async () => {
    writeConfig({ plugins: { alpha: { enabled: true } } })
    const gateway = await boot()
    if (!gateway) throw new Error("no gateway")
    // Let the boot burst's notification go out first.
    await new Promise((resolve) => setTimeout(resolve, 250))
    const events: Array<PluginsListResponse> = []
    const unsubscribe = settingsEventBus.subscribe(
      "plugins.changed",
      (event) => {
        events.push(event)
      },
    )
    try {
      await gateway.setToolPermissions("alpha", { search: "block" })
      await waitFor(() => events.length > 0)
      const view = events.at(-1)?.plugins.find((p) => p.id === "alpha")
      expect(view?.toolCounts.total).toBe(1)

      const seen = events.length
      await gateway.updateConfig("alpha", { greeting: "new" })
      await waitFor(() => events.length > seen)
    } finally {
      unsubscribe()
    }
  })
})
