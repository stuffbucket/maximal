/**
 * Keep client apps' own MCP configuration in step with Maximal's connectors.
 *
 * A connector's MCP endpoint (`/mcp/<id>`) is wanted in a client when the
 * connector is on (`plugins.<id>.enabled`), the user chose that client for
 * it (not Block in `plugins.<id>.access`, or listed in the legacy
 * `plugins.<id>.clients`), Maximal's integration for the client is on,
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
import { randomUUID } from "node:crypto"

import { generateApiKey } from "~/lib/auth/api-key-helper"
import {
  type ApiKeyEntry,
  type AppConfig,
  getConfig,
  writeConfig,
} from "~/lib/config/config"
import { currentProxyPort } from "~/lib/start/proxy-port"

import { pluginAccessIdForApiKey, pluginAppAccessId } from "../access"
import { getPluginGateway } from "../gateway"
import { pluginClientPermission } from "../settings"

/** Maximal's aggregate MCP endpoint, on the port it listens on. */
export function pluginAggregateMcpUrl(
  port: number = currentProxyPort(),
): string {
  return `http://127.0.0.1:${port}/mcp`
}

/** Whether `value` is Maximal's aggregate endpoint on any loopback port. */
export function isMaximalAggregateMcpUrl(value: unknown): boolean {
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
    && url.pathname === "/mcp"
    && url.search === ""
    && url.hash === ""
  )
}

/** Maximal's URL for a plugin's MCP endpoint, on the port it listens on. */
export function pluginMcpUrl(
  id: string,
  port: number = currentProxyPort(),
): string {
  return `${pluginAggregateMcpUrl(port)}/${id}`
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
  /** The label of the key the app itself uses for Maximal (`ClientApp.apiKeyLabel`).
   *  Its MCP entries use the key labelled with `clientId` instead; see `appIdentityKey`. */
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

/**
 * The key a client's MCP entries authenticate with. It must be one the MCP
 * route maps back to this app (`app:<client-id>`, see `access.ts`), never the
 * default endpoint key: a key that identifies as a generic connection would
 * let the app skip its own App Permissions (Ask in particular).
 */
function appIdentityKey(
  config: AppConfig,
  clientId: PluginClientId,
): ApiKeyEntry | undefined {
  const target = pluginAppAccessId(clientId)
  return (config.auth?.apiKeyEntries ?? []).find(
    (entry) =>
      entry.enabled
      && entry.key.trim().length > 0
      && pluginAccessIdForApiKey(entry) === target,
  )
}

/** Whether the user holds a key that identifies the app but turned it off.
 *  That is a revocation: Maximal must not replace it behind their back. */
function appIdentityKeyRevoked(
  config: AppConfig,
  clientId: PluginClientId,
): boolean {
  const target = pluginAppAccessId(clientId)
  return (config.auth?.apiKeyEntries ?? []).some(
    (entry) => pluginAccessIdForApiKey(entry) === target,
  )
}

/** Make sure the app has an enabled key that identifies it, unless the user
 *  deliberately disabled the one it had. */
function ensureAppIdentityKey(clientId: PluginClientId): void {
  const config = getConfig()
  if (appIdentityKey(config, clientId)) return
  if (appIdentityKeyRevoked(config, clientId)) return
  const entry: ApiKeyEntry = {
    id: randomUUID(),
    label: clientId,
    key: generateApiKey(),
    enabled: true,
    created_at: new Date().toISOString(),
  }
  writeConfig({
    ...config,
    auth: {
      ...config.auth,
      apiKeyEntries: [...(config.auth?.apiKeyEntries ?? []), entry],
    },
  })
}

/** What the client should have: an entry for each connector that is on,
 *  isn't Blocked for this client, and that the client doesn't already run
 *  itself. (Ask stays: Maximal asks at call time.) Entries carry the app's
 *  identifying key, absent while the app has none; an app whose key the user
 *  turned off gets none at all. */
export function desiredEntriesFor(
  configurator: Pick<PluginClientConfigurator, "clientId" | "standalone">,
  config: AppConfig,
  connectorIds: ReadonlySet<string>,
): Array<PluginClientEntry> {
  const appKey = appIdentityKey(config, configurator.clientId)?.key.trim()
  // Its key was turned off: the app gets no connector entries, and never a
  // keyless one (an unkeyed caller is exempt from App Permissions).
  if (!appKey && appIdentityKeyRevoked(config, configurator.clientId)) return []
  const entries: Array<PluginClientEntry> = []
  for (const [id, entry] of Object.entries(config.plugins ?? {})) {
    if (!connectorIds.has(id) || entry.enabled !== true) continue
    if (pluginClientPermission(config, id, configurator.clientId) === "block")
      continue
    if (configurator.standalone(id)) continue
    entries.push({
      id,
      url: pluginMcpUrl(id),
      ...(appKey ? { apiKey: appKey } : {}),
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
  let config = getConfig()
  let desired =
    configurator.available() ? desiredEntriesFor(configurator, config, ids) : []
  if (desired.some((entry) => !entry.apiKey)) {
    ensureAppIdentityKey(configurator.clientId)
    config = getConfig()
    desired = desiredEntriesFor(configurator, config, ids)
  }
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
