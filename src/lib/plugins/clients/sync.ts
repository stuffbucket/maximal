/**
 * Keep client apps' own MCP configuration in step with Maximal's plugins.
 *
 * A plugin's MCP endpoint (`/mcp/<id>`) is desired in a client when the
 * plugin is on (`plugins.<id>.enabled`), the user chose that client for it
 * (`plugins.<id>.clients`), and Maximal's integration for the client is on.
 * The client's configurator only knows how to read and write its own config;
 * this module computes the desired set and records which entries Maximal
 * wrote (`apps.claudeCode.mcpServers`) so every toggle can be reverted
 * exactly, and an entry the user owns is never touched.
 *
 * Runs only in the process that serves the plugins (the gateway is set): a
 * CLI command must not add entries for a Maximal that may not be running,
 * nor remove the ones the running one wrote. Uninstall uses
 * `releasePluginClientOffline`, which works anywhere.
 */

import type { PluginClientId } from "@stuffbucket/maximal-plugin-sdk/gateway"

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

export interface PluginReconcileResult {
  /** Ids Maximal owns in the client after this pass. */
  owned: Array<string>
  added: Array<string>
  removed: Array<string>
  /** Desired ids left alone because the client already had that name. */
  skipped: Array<string>
}

export interface PluginClientConfigurator {
  readonly clientId: PluginClientId
  /** The label that resolves this client's Maximal key (`ClientApp.apiKeyLabel`). */
  readonly apiKeyLabel: string
  /** Whether Maximal's integration for this client is on and usable. */
  available(): Promise<boolean>
  /** When not `available()`, why, in English, for Settings. */
  unavailableReason(): string
  /** Make the client match `desired`, touching only entries in `owned`. */
  reconcile(
    desired: Array<PluginClientEntry>,
    owned: Array<string>,
  ): Promise<PluginReconcileResult>
  /** Remove every entry in `owned` by editing files only, synchronously:
   *  shutdown's `exit` safety net can't wait on a child process. */
  releaseOffline(owned: Array<string>): PluginReconcileResult
  /** Put the right key back into owned entries the client overwrote,
   *  touching nothing else. File-only. */
  repairKeys?(desired: Array<PluginClientEntry>, owned: Array<string>): void
}

const APPS_KEY = {
  "claude-code": "claudeCode",
} as const satisfies Record<
  PluginClientId,
  keyof NonNullable<AppConfig["apps"]>
>

export function ownedPluginServers(
  clientId: PluginClientId,
  config: AppConfig,
): Array<string> {
  return config.apps?.[APPS_KEY[clientId]]?.mcpServers ?? []
}

/** What the client should have: an entry for each known plugin that is on
 *  and goes to this client. */
export function desiredEntriesFor(
  configurator: Pick<PluginClientConfigurator, "clientId" | "apiKeyLabel">,
  config: AppConfig,
  knownIds: ReadonlySet<string>,
): Array<PluginClientEntry> {
  const appKey = resolveApiKey(configurator.apiKeyLabel, config)
  const entries: Array<PluginClientEntry> = []
  for (const [id, entry] of Object.entries(config.plugins ?? {})) {
    if (!knownIds.has(id) || entry.enabled !== true) continue
    if (!entry.clients?.includes(configurator.clientId)) continue
    entries.push({
      id,
      url: pluginMcpUrl(id),
      ...(appKey.ok ? { apiKey: appKey.key } : {}),
    })
  }
  return entries
}

function emptyResult(): PluginReconcileResult {
  return { owned: [], added: [], removed: [], skipped: [] }
}

export interface SyncPluginClientOptions {
  /** Override the integration check, e.g. `false` while disabling it. */
  active?: boolean
}

/** The pass in progress (or last finished) per client. */
const queues = new Map<PluginClientId, Promise<unknown>>()

/**
 * Reconcile one client and persist what Maximal now owns there. No-op
 * outside the serving process (no gateway).
 *
 * Passes for the same client run one after another: each reads the config
 * when it starts, so it sees what the pass before it recorded, and two
 * passes can't interleave `claude mcp remove` / `add-json` for one entry.
 */
export function syncPluginClient(
  configurator: PluginClientConfigurator,
  options: SyncPluginClientOptions = {},
): Promise<PluginReconcileResult> {
  const previous = queues.get(configurator.clientId) ?? Promise.resolve()
  const pass = previous
    .catch(() => undefined)
    .then(() => reconcileNow(configurator, options))
  queues.set(configurator.clientId, pass)
  return pass
}

function knownPluginIds(): ReadonlySet<string> | undefined {
  const gateway = getPluginGateway()
  return gateway && new Set(gateway.list().map((plugin) => plugin.id))
}

async function reconcileNow(
  configurator: PluginClientConfigurator,
  options: SyncPluginClientOptions,
): Promise<PluginReconcileResult> {
  const known = knownPluginIds()
  if (!known) return emptyResult()
  const config = getConfig()
  const owned = ownedPluginServers(configurator.clientId, config)
  const wanted = desiredEntriesFor(configurator, config, known)
  // Nothing configured and nothing to revert: don't touch the client at all.
  if (wanted.length === 0 && owned.length === 0) return emptyResult()
  const active = options.active ?? (await configurator.available())
  const desired = active ? wanted : []
  if (desired.length === 0 && owned.length === 0) return emptyResult()
  const result = await configurator.reconcile(desired, owned)
  recordOwned(configurator.clientId, owned, result)
  return result
}

/** Put keys back into owned entries (cheap, file-only); see `repairKeys`. */
export function repairPluginClientKeys(
  configurator: PluginClientConfigurator,
): void {
  const known = knownPluginIds()
  if (!known || !configurator.repairKeys) return
  const config = getConfig()
  configurator.repairKeys(
    desiredEntriesFor(configurator, config, known),
    ownedPluginServers(configurator.clientId, config),
  )
}

/**
 * Take every entry Maximal owns back out by editing files, synchronously
 * (shutdown, uninstall). Waits for nothing, so an in-flight pass may still
 * finish after it; shutdown runs as the process is leaving anyway.
 */
export function releasePluginClientOffline(
  configurator: PluginClientConfigurator,
): PluginReconcileResult {
  const owned = ownedPluginServers(configurator.clientId, getConfig())
  if (owned.length === 0) return emptyResult()
  const result = configurator.releaseOffline(owned)
  recordOwned(configurator.clientId, owned, result)
  return result
}

function recordOwned(
  clientId: PluginClientId,
  before: Array<string>,
  result: PluginReconcileResult,
): void {
  if (sameIds(result.owned, before)) return
  // Re-read so a concurrent writer's unrelated changes are kept.
  const latest = getConfig()
  const key = APPS_KEY[clientId]
  writeConfig({
    ...latest,
    apps: {
      ...latest.apps,
      [key]: { ...latest.apps?.[key], mcpServers: result.owned },
    },
  })
}

function sameIds(left: Array<string>, right: Array<string>): boolean {
  return (
    left.length === right.length
    && [...left].sort().join("\n") === [...right].sort().join("\n")
  )
}
