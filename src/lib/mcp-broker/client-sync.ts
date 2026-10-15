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

import type { McpClientId } from "./types"

export const MCP_BASE_URL = "http://127.0.0.1:4141/mcp"

/** One endpoint as a client should see it. Content is Maximal's, not the
 *  MCP server's. */
export interface McpClientEntry {
  id: string
  label: string
  url: string
  /** Endpoint key, else the client's Maximal key; absent when neither. */
  apiKey?: string
}

export interface McpReconcileResult {
  /** Ids Maximal now owns in the client after this pass. */
  owned: Array<string>
  added: Array<string>
  removed: Array<string>
  /** Desired ids left alone because the client already had that name. */
  skipped: Array<string>
}

export interface McpReconcileOptions {
  /** Edit files directly instead of spawning client tools (e.g. the `claude`
   *  CLI). Used during shutdown, which has a short synchronous budget. */
  offline?: boolean
}

export interface McpClientConfigurator {
  readonly clientId: McpClientId
  /** The label that resolves this client's Maximal key (`ClientApp.apiKeyLabel`). */
  readonly apiKeyLabel: string
  /** Whether Maximal's integration for this client is on and usable. */
  available(): boolean
  /** Make the client match `desired`, touching only entries in `owned`. */
  reconcile(
    desired: Array<McpClientEntry>,
    owned: Array<string>,
    options?: McpReconcileOptions,
  ): McpReconcileResult
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
      url: `${MCP_BASE_URL}/${server.id}`,
      ...(apiKey === undefined ? {} : { apiKey }),
    })
  }
  return entries
}

export interface SyncMcpClientOptions {
  config?: AppConfig
  /** Override the integration check, e.g. `false` while disabling it. */
  active?: boolean
  offline?: boolean
}

/** Reconcile one client and persist what Maximal now owns there. */
export function syncMcpClient(
  configurator: McpClientConfigurator,
  options: SyncMcpClientOptions = {},
): McpReconcileResult {
  const config = options.config ?? getConfig()
  const owned = ownedMcpServers(configurator.clientId, config)
  const wanted = desiredEntriesFor(configurator, config)
  // Nothing configured and nothing to revert: don't touch the client at all.
  if (wanted.length === 0 && owned.length === 0) {
    return { owned: [], added: [], removed: [], skipped: [] }
  }
  const active = options.active ?? configurator.available()
  const desired = active ? wanted : []
  if (desired.length === 0 && owned.length === 0) {
    return { owned: [], added: [], removed: [], skipped: [] }
  }
  const result = configurator.reconcile(desired, owned, {
    offline: options.offline === true,
  })
  if (!sameIds(result.owned, owned)) {
    // Re-read so a concurrent writer's unrelated changes are kept.
    const latest = getConfig()
    const key = APPS_KEY[configurator.clientId]
    writeConfig({
      ...latest,
      apps: {
        ...latest.apps,
        [key]: { ...latest.apps?.[key], mcpServers: result.owned },
      },
    })
  }
  return result
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
