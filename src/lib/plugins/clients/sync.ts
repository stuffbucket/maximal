/**
 * Keep client apps' own MCP configuration in step with Maximal's connectors.
 *
 * A connector's MCP endpoint (`/mcp/<id>`) is wanted in a client when the
 * connector is on (`plugins.<id>.enabled`), the user chose that client for
 * it (`plugins.<id>.clients`), Maximal's integration for the client is on,
 * and the client doesn't already run the same service without Maximal
 * (`standalone`). The client's configurator owns its file format and which
 * entries are Maximal's; this module only works out what is wanted.
 *
 * `syncPluginClients` is the one way in: file-only, synchronous and
 * idempotent (it writes only when something differs), so it runs whenever
 * something it depends on may have changed: boot, a plugin or Claude Code
 * setting, an API key, a Settings read. It acts only in the process that
 * serves the plugins (the gateway is set): a CLI command must not add
 * entries for a Maximal that may not be running. Uninstall uses
 * `removePluginClientEntries`, which works anywhere.
 */

import type { PluginClientId } from "@stuffbucket/maximal-plugin-sdk/gateway"

import consola from "consola"

import { resolveApiKey } from "~/lib/auth/api-key-helper"
import { type AppConfig, getConfig, writeConfig } from "~/lib/config/config"
import { currentProxyPort } from "~/lib/start/proxy-port"

import { getPluginGateway } from "../gateway"

/** Maximal's URL for a plugin's MCP endpoint, on the port it listens on. */
export function pluginMcpUrl(
  id: string,
  port: number = currentProxyPort(),
): string {
  return `http://127.0.0.1:${port}/mcp/${id}`
}

/** Whether `value` is Maximal's URL for plugin `id` on any port, so an entry
 *  written before the proxy moved ports is still recognized (and rewritten)
 *  rather than mistaken for the user's. */
export function isMaximalMcpUrl(value: unknown, id: string): boolean {
  if (typeof value !== "string") return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === "http:"
    && url.hostname === "127.0.0.1"
    && url.username === ""
    && url.password === ""
    && url.pathname === `/mcp/${id}`
    && url.search === ""
    && url.hash === ""
  )
}

/** One plugin endpoint as a client should see it. */
export interface PluginClientEntry {
  id: string
  url: string
  /** The client's Maximal key; absent when none is configured. */
  apiKey?: string
}

/** The same service already set up in the client without Maximal. */
export interface StandaloneInstall {
  /** Its name in the client (a server name, or `plugin@marketplace`). */
  name: string
  source: "server" | "plugin"
}

export interface PluginClientApplyResult {
  /** Entry names added or rewritten. */
  written: Array<string>
  removed: Array<string>
}

export interface PluginClientConfigurator {
  readonly clientId: PluginClientId
  /** The label that resolves this client's Maximal key (`ClientApp.apiKeyLabel`). */
  readonly apiKeyLabel: string
  /** Whether Maximal's integration for this client is on. */
  available(): boolean
  /** When not `available()`, why, in English, for Settings. */
  unavailableReason(): string
  /** The client's own setup of plugin `id`, if it has one. */
  standalone(id: string): StandaloneInstall | undefined
  /** Make Maximal's entries exactly `desired` and remove the `legacy`
   *  names older versions wrote. File-only and synchronous. */
  apply(
    desired: ReadonlyArray<PluginClientEntry>,
    legacy: ReadonlyArray<string>,
  ): PluginClientApplyResult
}

type LegacyMcpAppKey = "claudeCode" | "claudeDesktop"

const APPS_KEY: Partial<Record<PluginClientId, LegacyMcpAppKey>> = {
  "claude-code": "claudeCode",
}

/** Entry names older versions recorded as written (`apps.<client>.mcpServers`). */
function legacyNames(
  clientId: PluginClientId,
  config: AppConfig,
): Array<string> {
  const key = APPS_KEY[clientId]
  return key ? (config.apps?.[key]?.mcpServers ?? []) : []
}

function clearLegacyNames(clientId: PluginClientId): void {
  const key = APPS_KEY[clientId]
  if (!key) return
  const latest = getConfig()
  const { mcpServers: _dropped, ...rest } = latest.apps?.[key] ?? {}
  writeConfig({ ...latest, apps: { ...latest.apps, [key]: rest } })
}

/** What the client should have: an entry for each connector that is on,
 *  goes to this client, and that the client doesn't already run itself. */
export function desiredEntriesFor(
  configurator: Pick<
    PluginClientConfigurator,
    "clientId" | "apiKeyLabel" | "standalone"
  >,
  config: AppConfig,
  connectorIds: ReadonlySet<string>,
): Array<PluginClientEntry> {
  const appKey = resolveApiKey(configurator.apiKeyLabel, config)
  const entries: Array<PluginClientEntry> = []
  for (const [id, entry] of Object.entries(config.plugins ?? {})) {
    if (!connectorIds.has(id) || entry.enabled !== true) continue
    if (!entry.clients?.includes(configurator.clientId)) continue
    if (configurator.standalone(id)) continue
    entries.push({
      id,
      url: pluginMcpUrl(id),
      ...(appKey.ok ? { apiKey: appKey.key } : {}),
    })
  }
  return entries
}

/** Ids of the connectors (the only plugins served over MCP). */
function connectorIds(): ReadonlySet<string> | undefined {
  const gateway = getPluginGateway()
  return (
    gateway
    && new Set(
      gateway
        .list()
        .filter((plugin) => plugin.kind === "connector")
        .map((plugin) => plugin.id),
    )
  )
}

function run(
  configurator: PluginClientConfigurator,
  desired: ReadonlyArray<PluginClientEntry>,
  legacy: ReadonlyArray<string>,
): boolean {
  const result = configurator.apply(desired, legacy)
  if (legacy.length > 0) clearLegacyNames(configurator.clientId)
  if (result.written.length > 0)
    consola.info(
      `${configurator.clientId}: wrote MCP servers ${result.written.join(", ")}`,
    )
  if (result.removed.length > 0)
    consola.info(
      `${configurator.clientId}: removed MCP servers ${result.removed.join(", ")}`,
    )
  return result.written.length > 0 || result.removed.length > 0
}

/** Bring one client in line with the config; whether anything changed.
 *  No-op outside the serving process. Throws when the client's config
 *  can't be written. */
export function syncPluginClient(
  configurator: PluginClientConfigurator,
): boolean {
  const ids = connectorIds()
  if (!ids) return false
  const config = getConfig()
  const desired =
    configurator.available() ? desiredEntriesFor(configurator, config, ids) : []
  return run(configurator, desired, legacyNames(configurator.clientId, config))
}

/** Remove every entry Maximal wrote (uninstall). Works without a gateway. */
export function removePluginClientEntries(
  configurator: PluginClientConfigurator,
): PluginClientApplyResult {
  const legacy = legacyNames(configurator.clientId, getConfig())
  const result = configurator.apply([], legacy)
  if (legacy.length > 0) clearLegacyNames(configurator.clientId)
  return result
}
