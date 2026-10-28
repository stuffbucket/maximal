/**
 * Keep client apps' own MCP configuration in step with Maximal's brokered
 * endpoints.
 *
 * Maximal decides what each client gets: an entry is desired when the broker
 * and endpoint are on, the user chose that client for the endpoint
 * (`servers[].clients`), and Maximal's integration for the client is on.
 * Each client's configurator only knows how to read and write its own config;
 * this module computes the desired set and records which entries Maximal
 * wrote (`apps.<client>.mcpServers`) so every toggle can be reverted exactly.
 *
 * Deliberately imports no app modules: each configurator passes itself in,
 * which keeps `src/lib` free of cycles through the app registry.
 */

import type { AppConfig } from "~/lib/config/config"

import { resolveApiKey } from "~/lib/auth/api-key-helper"
import { getConfig, writeConfig } from "~/lib/config/config"
import { currentProxyPort } from "~/lib/start/proxy-port"

import type { McpClientId } from "./types"

/** Maximal's URL for an endpoint, on the port the proxy listens on now. */
export function mcpEndpointUrl(
  id: string,
  port: number = currentProxyPort(),
): string {
  return `http://127.0.0.1:${port}/mcp/${id}`
}

/** Whether `value` is Maximal's URL for endpoint `id` on any port, so an
 *  entry written before the proxy moved ports is still recognized (and
 *  rewritten) rather than mistaken for the user's. */
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

/** One endpoint as a client should see it. Content is Maximal's, not the
 *  MCP server's. */
export interface McpClientEntry {
  id: string
  label: string
  url: string
  /** Endpoint key, else the client's Maximal key; absent when neither. */
  apiKey?: string
}

/** Why a client can't be given an endpoint on this install. */
export type McpClientUnavailableReason =
  /** Claude Desktop runs endpoints through `maximal-mcp-broker`, which
   *  wasn't found. */
  "adapter-missing"

/** Why a client can't be offered endpoints at all right now, when Maximal
 *  can tell more than "its integration is off". */
export type McpClientOfferUnavailableReason =
  /** Claude Desktop has another gateway profile applied. */
  "other-provider-profile"

export interface McpReconcileResult {
  /** Ids Maximal now owns in the client after this pass. */
  owned: Array<string>
  added: Array<string>
  removed: Array<string>
  /** Desired ids left alone because the client already had that name. */
  skipped: Array<string>
  /** Desired ids Maximal couldn't write on this install, and why. */
  unavailable: Array<{ id: string; reason: McpClientUnavailableReason }>
}

export interface McpClientConfigurator {
  readonly clientId: McpClientId
  /** The label that resolves this client's Maximal key (`ClientApp.apiKeyLabel`). */
  readonly apiKeyLabel: string
  /** Whether Maximal takes its entries back out when it shuts down. Right
   *  for a client that reads its config per session (Claude Code), so a
   *  session started while Maximal is down doesn't get a dead server. Wrong
   *  for one that reads it only at launch (Claude Desktop): the running app
   *  wouldn't notice, and its next launch would come up without the server
   *  even though Maximal is back by then. */
  readonly removeOnShutdown: boolean
  /** Whether Maximal's integration for this client is on and usable. */
  available(): Promise<boolean>
  /** When not `available()`, a more specific reason than "integration
   *  off", if the client can tell one cheaply. */
  unavailableReason?(): McpClientOfferUnavailableReason | undefined
  /** Make the client match `desired`, touching only entries in `owned`.
   *  May run the client's own tools (the `claude` CLI), so it's async. */
  reconcile(
    desired: Array<McpClientEntry>,
    owned: Array<string>,
  ): Promise<McpReconcileResult>
  /** Remove every entry in `owned` by editing files only, synchronously:
   *  shutdown's `exit` safety net can't wait on a child process. */
  releaseOffline(owned: Array<string>): McpReconcileResult
  /** Put the right key back into owned entries the client overwrote,
   *  touching nothing else. File-only and cheap enough to run on every
   *  Settings read. */
  repairKeys?(desired: Array<McpClientEntry>, owned: Array<string>): void
  /** The client's own stdio entry named `id` (one Maximal didn't write), so
   *  an endpoint can adopt its command when it is turned on. */
  existingStdioEntry?(
    id: string,
    owned: Array<string>,
  ): McpExistingStdioEntry | undefined
}

export interface McpExistingStdioEntry {
  command: string
  args: Array<string>
  cwd?: string
  env: Record<string, string>
}

const APPS_KEY = {
  "claude-code": "claudeCode",
  "claude-desktop": "claudeDesktop",
} as const satisfies Record<McpClientId, keyof NonNullable<AppConfig["apps"]>>

export function ownedMcpServers(
  clientId: McpClientId,
  config: AppConfig,
): Array<string> {
  return config.apps?.[APPS_KEY[clientId]]?.mcpServers ?? []
}

/** What the client should have: an entry for each endpoint that is on and
 *  goes to this client. */
export function desiredEntriesFor(
  configurator: Pick<McpClientConfigurator, "clientId" | "apiKeyLabel">,
  config: AppConfig,
): Array<McpClientEntry> {
  const broker = config.mcpBroker
  if (broker?.enabled !== true) return []
  const appKey = resolveApiKey(configurator.apiKeyLabel, config)
  const entries: Array<McpClientEntry> = []
  for (const server of broker.servers ?? []) {
    if (server.enabled === false) continue
    if (!server.clients?.includes(configurator.clientId)) continue
    const apiKey = server.apiKey ?? (appKey.ok ? appKey.key : undefined)
    entries.push({
      id: server.id,
      label: server.label,
      url: mcpEndpointUrl(server.id),
      ...(apiKey === undefined ? {} : { apiKey }),
    })
  }
  return entries
}

function emptyResult(): McpReconcileResult {
  return { owned: [], added: [], removed: [], skipped: [], unavailable: [] }
}

export interface SyncMcpClientOptions {
  /** Override the integration check, e.g. `false` while disabling it. */
  active?: boolean
}

/** The pass in progress (or last finished) per client. */
const queues = new Map<McpClientId, Promise<unknown>>()

/**
 * Reconcile one client and persist what Maximal now owns there.
 *
 * Passes for the same client run one after another: each reads the config
 * when it starts, so it sees what the pass before it recorded, and two
 * passes can't interleave `claude mcp remove` / `add-json` for one entry.
 * Different clients don't wait on each other.
 */
export function syncMcpClient(
  configurator: McpClientConfigurator,
  options: SyncMcpClientOptions = {},
): Promise<McpReconcileResult> {
  const previous = queues.get(configurator.clientId) ?? Promise.resolve()
  const pass = previous
    .catch(() => undefined)
    .then(() => reconcileNow(configurator, options))
  queues.set(configurator.clientId, pass)
  return pass
}

async function reconcileNow(
  configurator: McpClientConfigurator,
  options: SyncMcpClientOptions,
): Promise<McpReconcileResult> {
  const config = getConfig()
  const owned = ownedMcpServers(configurator.clientId, config)
  const wanted = desiredEntriesFor(configurator, config)
  // Nothing configured and nothing to revert: don't touch the client at all.
  if (wanted.length === 0 && owned.length === 0) return emptyResult()
  const active = options.active ?? (await configurator.available())
  const desired = active ? wanted : []
  if (desired.length === 0 && owned.length === 0) return emptyResult()
  const result = await configurator.reconcile(desired, owned)
  recordOwned(configurator.clientId, owned, result)
  return result
}

/**
 * Shutdown's version: take every entry Maximal owns back out by editing
 * files, synchronously. Waits for nothing, so an in-flight pass may still
 * finish after it; shutdown runs as the process is leaving anyway.
 */
export function releaseMcpClientOffline(
  configurator: McpClientConfigurator,
): McpReconcileResult {
  const owned = ownedMcpServers(configurator.clientId, getConfig())
  if (owned.length === 0) return emptyResult()
  const result = configurator.releaseOffline(owned)
  recordOwned(configurator.clientId, owned, result)
  return result
}

function recordOwned(
  clientId: McpClientId,
  before: Array<string>,
  result: McpReconcileResult,
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

/** A client's own stdio MCP entry, as Claude Code and Claude Desktop both
 *  write it: `{ command, args?, cwd?, env? }` with an optional
 *  `type: "stdio"`. Anything else (HTTP, malformed) yields undefined. */
export function parseStdioEntry(
  value: unknown,
): McpExistingStdioEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { type, command, args, cwd, env } = value as Record<string, unknown>
  if (type !== undefined && type !== "stdio") return undefined
  if (typeof command !== "string" || command.length === 0) return undefined
  const stringArgs = Array.isArray(args) ? args : []
  if (!stringArgs.every((arg) => typeof arg === "string")) return undefined
  const stringEnv =
    typeof env === "object" && env !== null ?
      Object.fromEntries(
        Object.entries(env).filter(
          (pair): pair is [string, string] => typeof pair[1] === "string",
        ),
      )
    : {}
  return {
    command,
    args: stringArgs,
    ...(typeof cwd === "string" && cwd.length > 0 ? { cwd } : {}),
    env: stringEnv,
  }
}
