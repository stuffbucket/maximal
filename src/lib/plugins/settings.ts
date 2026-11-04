/**
 * The `plugins` section of `config.json`: reading and changing one plugin's
 * entry, and the one-time migration from the parked MCP broker's Work IQ
 * endpoint.
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
 *  (its `config`, unknown keys). Returns the written config. */
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

/** Run the migration against `config.json` once, at boot. Never throws. */
export function migratePluginSettings(): void {
  try {
    const migrated = migrateLegacyWorkIq(getConfig())
    if (!migrated) return
    writeConfig(migrated)
    consola.info("Moved Work IQ's settings from the MCP broker to plugins")
  } catch (error) {
    consola.warn("Could not migrate Work IQ's settings", error)
  }
}
