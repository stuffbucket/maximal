/**
 * The `plugins` section of `config.json`: reading and changing one plugin's
 * entry (`{ enabled, clients }`), the one-time migration from the retired MCP
 * broker's Work IQ endpoint, and finding the legacy `plugins.<id>.config`
 * values that boot moves into each plugin's settings file.
 */

import type {
  PluginClientId,
  PluginSettingsEntry,
  ToolPermission,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import consola from "consola"

import { type AppConfig, getConfig, writeConfig } from "~/lib/config/config"

import {
  PLUGIN_CLIENT_IDS,
  PLUGIN_UNIDENTIFIED_ACCESS_ID,
  pluginAppAccessId,
  pluginConnectionAccessId,
} from "./access"

const LEGACY_PLUGIN_CLIENT_IDS: ReadonlySet<string> = new Set<PluginClientId>([
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

export function pluginAccessPermission(
  config: AppConfig,
  pluginId: string,
  accessId: string | undefined,
): ToolPermission {
  if (accessId === undefined) return "allow"
  if (accessId === PLUGIN_UNIDENTIFIED_ACCESS_ID) return "block"
  const entry = pluginEntry(config, pluginId)
  const explicit = entry?.access?.[accessId]
  if (explicit) return explicit
  if (accessId.startsWith("app:")) {
    const clientId = accessId.slice("app:".length) as PluginClientId
    return entry?.clients?.includes(clientId) ? "allow" : "block"
  }
  // Named API connections could reach MCP endpoints before app permissions
  // existed. Preserve that access until the person chooses otherwise.
  return "allow"
}

export function pluginClientPermission(
  config: AppConfig,
  pluginId: string,
  clientId: PluginClientId,
): ToolPermission {
  return pluginAccessPermission(config, pluginId, pluginAppAccessId(clientId))
}

export function pluginConnectionPermission(
  config: AppConfig,
  pluginId: string,
  connectionId: string,
): ToolPermission {
  return pluginAccessPermission(
    config,
    pluginId,
    pluginConnectionAccessId(connectionId),
  )
}

export function pluginClients(
  config: AppConfig,
  id: string,
): Array<PluginClientId> {
  return PLUGIN_CLIENT_IDS.filter(
    (clientId) => pluginClientPermission(config, id, clientId) !== "block",
  )
}

interface PluginEntryChange {
  enabled?: boolean
  clients?: Array<PluginClientId>
  access?: Record<string, ToolPermission>
}

/**
 * The entry after a change, keeping `clients` (legacy app list) and `access`
 * (per app / connection policy) consistent so an older build reading the same
 * file still sees the apps that can use the connector:
 *  - `access` merges into the existing map (a partial PATCH keeps the rest);
 *  - `clients` alone keeps working for old callers: explicit app policies are
 *    reconciled to it (listed and blocked becomes Allow, unlisted becomes
 *    Block) and an explicit Ask for a listed app survives;
 *  - after an `access` change, `clients` lists every app that isn't Block;
 *  - with both in one change, `clients` is applied first and the `access`
 *    entries then win for the apps they name, so the result is the same
 *    whatever order a caller thinks in.
 */
function changedEntry(
  config: AppConfig,
  id: string,
  change: PluginEntryChange,
): PluginSettingsEntry {
  const current = pluginEntry(config, id) ?? {}
  const next: PluginSettingsEntry = {
    ...current,
    ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
  }
  let access = current.access
  if (change.clients !== undefined) {
    const listed = [...new Set(change.clients)]
    next.clients = listed
    if (access) {
      access = { ...access }
      for (const clientId of PLUGIN_CLIENT_IDS) {
        const key = pluginAppAccessId(clientId)
        if (!Object.hasOwn(access, key)) continue
        if (!listed.includes(clientId)) access[key] = "block"
        else if (access[key] === "block") access[key] = "allow"
      }
    }
  }
  if (change.access !== undefined) {
    // Sent together, `access` is the more specific: it overrides the apps it
    // names, `clients` decides the rest, and the legacy list is then derived
    // so the two never disagree.
    access = { ...access, ...change.access }
    const draft: AppConfig = {
      ...config,
      plugins: { ...config.plugins, [id]: { ...next, access } },
    }
    next.clients = PLUGIN_CLIENT_IDS.filter(
      (clientId) => pluginClientPermission(draft, id, clientId) !== "block",
    )
  }
  if (access !== undefined) next.access = access
  return next
}

/** Persist a change to one plugin's entry, keeping everything else in it
 *  (unknown keys). Returns the written config. */
export function updatePluginEntry(
  id: string,
  change: PluginEntryChange,
): AppConfig {
  const config = getConfig()
  return writeConfig({
    ...config,
    plugins: {
      ...config.plugins,
      [id]: changedEntry(config, id, change),
    },
  })
}

/**
 * Work IQ used to be an MCP broker endpoint (`mcpBroker.servers[]` entry
 * with `catalog: "workiq"`). When `plugins.workiq` doesn't exist yet, carry
 * its on/off state and its Claude Code choice over. Returns undefined when
 * there is nothing to migrate. The `mcpBroker` block is retired config, so
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
          typeof client === "string" && LEGACY_PLUGIN_CLIENT_IDS.has(client),
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

/**
 * `config.plugins` without the `connection:<id>` policies of a deleted API
 * key. Entry ids are never reused, so these entries can only go stale.
 * Undefined when nothing referred to it.
 */
export function pruneConnectionAccess(
  config: AppConfig,
  connectionId: string,
): AppConfig["plugins"] {
  const plugins = config.plugins
  if (!plugins) return undefined
  const key = pluginConnectionAccessId(connectionId)
  let changed = false
  const next: NonNullable<AppConfig["plugins"]> = {}
  for (const [id, entry] of Object.entries(plugins)) {
    if (entry.access && Object.hasOwn(entry.access, key)) {
      const { [key]: _removed, ...rest } = entry.access
      next[id] = { ...entry, access: rest }
      changed = true
    } else {
      next[id] = entry
    }
  }
  return changed ? next : undefined
}
