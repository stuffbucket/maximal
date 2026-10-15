/**
 * Brokered MCP endpoints across client apps: the one place the Settings API,
 * the `maximal mcp` CLI, and boot go through to toggle an endpoint and keep
 * every client's own MCP configuration in step.
 *
 * Toggling persists the user's choice in `config.json`, restarts the broker
 * with it, then lets each client's configurator add or revert its entries.
 */

import consola from "consola"
import path from "node:path"

import type { AppConfig, McpServerConfig } from "~/lib/config/config"
import type { McpBrokerHealth } from "~/lib/config/settings-types"
import type { McpReconcileResult } from "~/lib/mcp-broker/client-sync"
import type { McpClientId } from "~/lib/mcp-broker/types"

import { getConfig, writeConfig } from "~/lib/config/config"
import { ownedMcpServers, syncMcpClient } from "~/lib/mcp-broker/client-sync"
import { isProtectedEnvironmentName } from "~/lib/mcp-broker/configuration"
import {
  getBrokerSupervisorSnapshot,
  reconfigureBroker,
} from "~/lib/mcp-broker/supervisor"

import type { ClientApp } from "./index"

import { getAllApps } from "./registry"

export interface McpClientOffer {
  id: McpClientId
  name: string
  /** Maximal's integration for the client is on, so it can be offered. */
  available: boolean
  /** Maximal currently has this endpoint written into the client. */
  configured: boolean
}

export interface McpEndpointView {
  id: string
  label: string
  enabled: boolean
  /** The user's remembered client choices. */
  clients: Array<McpClientId>
  offered: Array<McpClientOffer>
}

export interface McpClientSkip {
  client: McpClientId
  name: string
}

export interface SetMcpEndpointResult {
  endpoint: McpEndpointView
  /** Clients that already had an entry with this name; left unchanged. */
  skipped: Array<McpClientSkip>
  /** False when no broker runs in this process (e.g. the CLI). */
  brokerReloaded: boolean
  /** The app whose own entry for this id the endpoint now runs. */
  adoptedFrom?: string
  /** Environment names from that entry not copied (they look like secrets). */
  droppedEnvironment?: Array<string>
}

interface Adoption {
  server: McpServerConfig
  from: string
  dropped: Array<string>
}

const ENVIRONMENT_NAME = /^[A-Za-z_]\w*$/u

/** Same rules config.json enforces: plain names, nothing secret-looking. */
function copyable(name: string): boolean {
  return ENVIRONMENT_NAME.test(name) && !isProtectedEnvironmentName(name)
}

/** The broker adapter itself is never a server to adopt. */
function runsBroker(command: string): boolean {
  return /^maximal-mcp-broker(?:\.exe)?$/iu.test(
    path.basename(command.replaceAll("\\", "/")),
  )
}

/**
 * When an app already has its own stdio entry with this id (say, a Work IQ
 * server the user set up in Claude Desktop), copy its command, args, working
 * directory, and non-secret environment into the endpoint, so the broker
 * runs the same thing. Copied once, when the endpoint is turned on; the
 * app's own entry is left as it is.
 */
function adoptExistingEntry(
  server: McpServerConfig,
  config: AppConfig,
): Adoption | undefined {
  for (const app of mcpApps()) {
    const existing = app.mcp.existingStdioEntry?.(
      server.id,
      ownedMcpServers(app.mcp.clientId, config),
    )
    if (!existing || runsBroker(existing.command)) continue
    const dropped = Object.keys(existing.env).filter((name) => !copyable(name))
    const values = Object.fromEntries(
      Object.entries(existing.env).filter(([name]) => copyable(name)),
    )
    return {
      from: app.name,
      dropped,
      server: {
        ...server,
        transport: {
          type: "stdio",
          command: existing.command,
          args: existing.args,
          ...(existing.cwd === undefined ? {} : { cwd: existing.cwd }),
        },
        environment: { ...server.environment, values },
      },
    }
  }
  return undefined
}

type McpApp = ClientApp & { mcp: NonNullable<ClientApp["mcp"]> }

function mcpApps(): Array<McpApp> {
  return getAllApps().filter((app): app is McpApp => app.mcp !== undefined)
}

/** The broker's supervisor state, collapsed to what the Settings UI acts on
 *  (see McpBrokerHealth): is it fine, is Maximal already fixing it, or does
 *  the user need to do something. */
export function mcpBrokerHealth(): McpBrokerHealth {
  const { state, problem } = getBrokerSupervisorSnapshot()
  switch (state) {
    case "disabled": {
      return { state: "off", problem: null }
    }
    case "starting":
    case "stopping": {
      return { state: "starting", problem: null }
    }
    case "ready": {
      return { state: "running", problem: null }
    }
    case "degraded":
    case "backoff": {
      return { state: "recovering", problem: null }
    }
    case "circuit-open": {
      return { state: "stuck", problem: null }
    }
    case "unavailable": {
      return { state: "unavailable", problem }
    }
    default: {
      // Exhaustive: a new supervisor state is a compile error here.
      state satisfies never
      return { state: "unavailable", problem }
    }
  }
}

export function listMcpEndpoints(
  config: AppConfig = getConfig(),
): Array<McpEndpointView> {
  const clients = mcpApps().map((app) => ({
    id: app.mcp.clientId,
    name: app.name,
    available: app.mcp.available(),
  }))
  const brokerOn = config.mcpBroker?.enabled === true
  return (config.mcpBroker?.servers ?? []).map((server) => ({
    id: server.id,
    label: server.label,
    enabled: brokerOn && server.enabled !== false,
    clients: server.clients ?? [],
    offered: clients.map((client) => ({
      ...client,
      configured: ownedMcpServers(client.id, config).includes(server.id),
    })),
  }))
}

/** Reconcile every client app with the current config. */
export function syncAllMcpClients(
  config: AppConfig = getConfig(),
): Array<{ client: McpClientId; name: string; result: McpReconcileResult }> {
  return mcpApps().map((app) => ({
    client: app.mcp.clientId,
    name: app.name,
    result: syncMcpClient(app.mcp, { config }),
  }))
}

/**
 * Turn an endpoint on or off and record which clients it should reach.
 * Returns undefined when no endpoint has that id.
 */
export async function setMcpEndpoint(
  id: string,
  change: { enabled: boolean; clients?: Array<McpClientId> },
): Promise<SetMcpEndpointResult | undefined> {
  const config = getConfig()
  const servers = config.mcpBroker?.servers ?? []
  const index = servers.findIndex((server) => server.id === id)
  if (index === -1) return undefined

  const chosen = {
    ...servers[index],
    enabled: change.enabled,
    ...(change.clients ? { clients: [...new Set(change.clients)] } : {}),
  }
  const adoption =
    change.enabled ? adoptExistingEntry(chosen, config) : undefined
  const server = adoption?.server ?? chosen
  const next = writeConfig({
    ...config,
    mcpBroker: {
      ...config.mcpBroker,
      // Turning an endpoint on implies the broker; turning one off leaves it.
      enabled: change.enabled || config.mcpBroker?.enabled === true,
      servers: servers.with(index, server),
    },
  })

  const brokerReloaded = await reconfigureBroker(next.mcpBroker ?? {})
  const skipped = syncAllMcpClients(next).flatMap(({ client, name, result }) =>
    result.skipped.includes(id) ? [{ client, name }] : [],
  )
  const endpoint = listMcpEndpoints().find((view) => view.id === id)
  if (!endpoint) return undefined
  return {
    endpoint,
    skipped,
    brokerReloaded,
    ...(adoption ?
      { adoptedFrom: adoption.from, droppedEnvironment: adoption.dropped }
    : {}),
  }
}

/** On shutdown, take every entry Maximal wrote back out of the clients so
 *  nothing points at a Maximal that isn't running; boot puts them back from
 *  the recorded choices. Synchronous and file-only, for the shutdown budget
 *  and the `exit` safety net. */
export function removeMcpClientsOnShutdown(): void {
  for (const app of mcpApps()) {
    try {
      syncMcpClient(app.mcp, { active: false, offline: true })
    } catch (error) {
      consola.warn(
        `Could not remove ${app.name} MCP servers on shutdown`,
        error,
      )
    }
  }
}

/** At boot, repair client entries to match config.json. Skipped entirely
 *  when the broker was never configured, and never blocks startup. */
export function syncMcpClientsOnBoot(config: AppConfig): void {
  if (config.mcpBroker === undefined) return
  for (const app of mcpApps()) {
    try {
      syncMcpClient(app.mcp, { config })
    } catch (error) {
      consola.warn(`Could not update ${app.name} MCP servers`, error)
    }
  }
}
