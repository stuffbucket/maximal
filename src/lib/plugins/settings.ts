/**
 * The `plugins` section of `config.json`: reading and changing one plugin's
 * entry (`{ enabled, clients }`), the one-time migration from the parked MCP
 * broker's Work IQ endpoint, and finding the legacy `plugins.<id>.config`
 * values that boot moves into each plugin's settings file.
 */

import type {
  PluginClientId,
  PluginSettingsEntry,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import consola from "consola"

import { type AppConfig, getConfig, writeConfig } from "~/lib/config/config"

const PLUGIN_CLIENT_IDS: ReadonlySet<string> = new Set<PluginClientId>([
  "claude-code",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function pluginEntry(
  config: AppConfig,
  id: string,
): PluginSettingsEntry | undefined {
  const plugins = config.plugins
  return plugins && Object.hasOwn(plugins, id) ? plugins[id] : undefined
}

export function pluginClients(
  config: AppConfig,
  id: string,
): Array<PluginClientId> {
  return pluginEntry(config, id)?.clients ?? []
}

/** Persist a change to one plugin's entry, keeping everything else in it
 *  (unknown keys). Returns the written config. */
export function updatePluginEntry(
  id: string,
  change: { enabled?: boolean; clients?: Array<PluginClientId> },
): AppConfig {
  const config = getConfig()
  const current = pluginEntry(config, id) ?? {}
  return writeConfig({
    ...config,
    plugins: {
      ...config.plugins,
      [id]: {
        ...current,
        ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
        ...(change.clients === undefined ?
          {}
        : { clients: [...new Set(change.clients)] }),
      },
    },
  })
}

/**
 * Work IQ used to be an MCP broker endpoint (`mcpBroker.servers[]` entry
 * with `catalog: "workiq"`). When `plugins.workiq` doesn't exist yet, carry
 * its on/off state and its Claude Code choice over. Returns undefined when
 * there is nothing to migrate. The `mcpBroker` block is parked config, so
 * it is read defensively.
 */
export function migrateLegacyWorkIq(config: AppConfig): AppConfig | undefined {
  if (pluginEntry(config, "workiq") !== undefined) return undefined
  const broker = config.mcpBroker
  if (!isRecord(broker) || !Array.isArray(broker.servers)) return undefined
  const server: unknown = broker.servers.find(
    (item: unknown) => isRecord(item) && item.catalog === "workiq",
  )
  if (!isRecord(server)) return undefined
  // The broker served an endpoint only while both switches were on; an
  // endpoint's own switch defaulted to on.
  const enabled = broker.enabled === true && server.enabled !== false
  const clients =
    Array.isArray(server.clients) ?
      server.clients.filter(
        (client: unknown): client is PluginClientId =>
          typeof client === "string" && PLUGIN_CLIENT_IDS.has(client),
      )
    : []
  return {
    ...config,
    plugins: {
      ...config.plugins,
      workiq: { enabled, ...(clients.length > 0 ? { clients } : {}) },
    },
  }
}

/**
 * Plugins that replaced routes Maximal always served (the decisions,
 * SystemOne and image pass-through routes). A plugin's own entry is absent for
 * every existing user, and absent means off, so without this their
 * `/v1/decisions`, `/v1/systemone` and `/v1/images/*` would start answering
 * 404 on upgrade.
 */
export const DEFAULT_ON_PLUGINS: ReadonlyArray<string> = [
  "decisions",
  "systemone",
  "images",
]

/**
 * Turn on each default-on plugin that has no `enabled` choice yet. Runs on
 * every boot but only ever writes the missing key, so a plugin the user
 * turned off stays off. Returns undefined when there is nothing to change.
 */
export function migrateDefaultOnPlugins(
  config: AppConfig,
): AppConfig | undefined {
  const missing = DEFAULT_ON_PLUGINS.filter(
    (id) => pluginEntry(config, id)?.enabled === undefined,
  )
  if (missing.length === 0) return undefined
  return {
    ...config,
    plugins: {
      ...config.plugins,
      ...Object.fromEntries(
        missing.map((id) => [
          id,
          { ...pluginEntry(config, id), enabled: true },
        ]),
      ),
    },
  }
}

/** Run the migrations against `config.json`, at boot. Never throws. */
export function migratePluginSettings(): void {
  try {
    const migrated = migrateLegacyWorkIq(getConfig())
    if (migrated) {
      writeConfig(migrated)
      consola.info("Moved Work IQ's settings from the MCP broker to plugins")
    }
  } catch (error) {
    consola.warn("Could not migrate Work IQ's settings", error)
  }
  try {
    const defaults = migrateDefaultOnPlugins(getConfig())
    if (defaults) {
      writeConfig(defaults)
      consola.info(
        "Turned on the plugins that serve the decisions, SystemOne and image routes",
      )
    }
  } catch (error) {
    consola.warn("Could not turn on the default plugins", error)
  }
}

/**
 * Plugin configs still stored the pre-settings-file way, in `config.json` →
 * `plugins.<id>.config`. The config schema keeps accepting that key (loose
 * entry) so boot can move each value into the plugin's own settings file.
 */
export function legacyPluginConfigs(
  config: AppConfig,
): Array<{ id: string; config: unknown }> {
  return Object.entries(config.plugins ?? {}).flatMap(([id, entry]) => {
    const raw: Record<string, unknown> = isRecord(entry) ? entry : {}
    return Object.hasOwn(raw, "config") ? [{ id, config: raw.config }] : []
  })
}

/** Remove `plugins.<id>.config` from `config.json` (after it moved into the
 *  plugin's settings file). No-op when it isn't there. */
export function dropLegacyPluginConfig(id: string): void {
  const config = getConfig()
  const entry = pluginEntry(config, id)
  if (!isRecord(entry) || !Object.hasOwn(entry, "config")) return
  const { config: _legacy, ...rest } = entry
  writeConfig({ ...config, plugins: { ...config.plugins, [id]: rest } })
}
