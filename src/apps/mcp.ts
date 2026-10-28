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
import type {
  CatalogDetectOptions,
  CatalogInstall,
  CatalogInstallHint,
} from "~/lib/mcp-broker/catalog"
import type {
  McpClientOfferUnavailableReason,
  McpClientUnavailableReason,
  McpReconcileResult,
} from "~/lib/mcp-broker/client-sync"
import type { McpClientId } from "~/lib/mcp-broker/types"

import { getConfig, writeConfig } from "~/lib/config/config"
import { findCatalogEntry, MCP_CATALOG } from "~/lib/mcp-broker/catalog"
import {
  desiredEntriesFor,
  ownedMcpServers,
  releaseMcpClientOffline,
  syncMcpClient,
} from "~/lib/mcp-broker/client-sync"
import { isProtectedEnvironmentName } from "~/lib/mcp-broker/configuration"
import {
  type BrokerReadiness,
  getBrokerSupervisorSnapshot,
  reconfigureBroker,
  waitForBrokerReady,
} from "~/lib/mcp-broker/supervisor"
import {
  isHeldBackFromBroker,
  reconfigureBrokerAfterSetupCheck,
} from "~/lib/mcp-broker/workiq"

import type { ClientApp } from "./index"

import { getAllApps } from "./registry"

export interface McpClientOffer {
  id: McpClientId
  name: string
  /** Maximal's integration for the client is on, so it can be offered. */
  available: boolean
  /** When not available, a more specific reason than "integration off". */
  unavailableReason?: McpClientOfferUnavailableReason
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

export interface McpClientUnavailable extends McpClientSkip {
  reason: McpClientUnavailableReason
}

export interface SetMcpEndpointResult {
  endpoint: McpEndpointView
  /** Clients that already had an entry with this name; left unchanged. */
  skipped: Array<McpClientSkip>
  /** Clients Maximal couldn't add the endpoint to on this install. */
  unavailable: Array<McpClientUnavailable>
  /** Clients whose config Maximal changed for this endpoint (added it or
   *  took it out), so the UI can say how each app picks that up. */
  updated: Array<McpClientSkip>
  /** False when no broker runs in this process (e.g. the CLI). */
  brokerReloaded: boolean
  /** Where the broker got to before the apps were updated. Turning an
   *  endpoint on waits (bounded) for it; turning one off doesn't.
   *  `setup-needed`: it's on, but held back from the broker until its setup
   *  is done (Work IQ's terms and sign-in), so there was nothing to wait for. */
  broker: BrokerReadiness | "setup-needed"
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

export async function listMcpEndpoints(
  config: AppConfig = getConfig(),
): Promise<Array<McpEndpointView>> {
  const clients = await Promise.all(
    mcpApps().map(async (app) => {
      const available = await app.mcp.available()
      const reason = available ? undefined : app.mcp.unavailableReason?.()
      return {
        id: app.mcp.clientId,
        name: app.name,
        available,
        ...(reason === undefined ? {} : { unavailableReason: reason }),
      }
    }),
  )
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

/** Reconcile every client app with the current config, all at once. */
export function syncAllMcpClients(): Promise<
  Array<{ client: McpClientId; name: string; result: McpReconcileResult }>
> {
  return Promise.all(
    mcpApps().map(async (app) => ({
      client: app.mcp.clientId,
      name: app.name,
      result: await syncMcpClient(app.mcp),
    })),
  )
}

/** Put the right key back into owned entries a client overwrote (a running
 *  Claude Code writes back the copy it read before Maximal swapped the
 *  placeholder for the key). File-only; never adds or removes an entry. */
export function repairMcpClientKeys(config: AppConfig = getConfig()): void {
  for (const app of mcpApps()) {
    if (!app.mcp.repairKeys) continue
    try {
      app.mcp.repairKeys(
        desiredEntriesFor(app.mcp, config),
        ownedMcpServers(app.mcp.clientId, config),
      )
    } catch (error) {
      consola.warn(`Could not check the ${app.name} MCP server keys`, error)
    }
  }
}

/**
 * How long a toggle or boot waits for the broker to serve before pointing
 * apps at it anyway. A new broker probes each server first, and Work IQ's
 * startup timeout is 30s; this leaves margin over that.
 */
export const BROKER_READY_TIMEOUT_MS = 45_000

/** The broker and client-sync steps, injectable for tests. */
export interface McpBrokerSteps {
  reconfigure?: typeof reconfigureBroker
  waitForBroker?: (timeoutMs: number) => Promise<BrokerReadiness>
  syncClients?: typeof syncAllMcpClients
  /** Whether an endpoint that is on is held back from the broker. */
  heldBack?: (server: McpServerConfig) => boolean
}

/** What each client's sync did with endpoint `id`. */
function clientOutcome(
  id: string,
  synced: Awaited<ReturnType<typeof syncAllMcpClients>>,
): Pick<SetMcpEndpointResult, "skipped" | "unavailable" | "updated"> {
  const skipped: Array<McpClientSkip> = []
  const unavailable: Array<McpClientUnavailable> = []
  const updated: Array<McpClientSkip> = []
  for (const { client, name, result } of synced) {
    if (result.skipped.includes(id)) skipped.push({ client, name })
    const missing = result.unavailable.find((entry) => entry.id === id)
    if (missing) unavailable.push({ client, name, reason: missing.reason })
    if (result.added.includes(id) || result.removed.includes(id)) {
      updated.push({ client, name })
    }
  }
  return { skipped, unavailable, updated }
}

const DEFAULT_STEPS: Required<McpBrokerSteps> = {
  // Reads Work IQ's setup first, so one that isn't done stays held back.
  reconfigure: (config) => reconfigureBrokerAfterSetupCheck(config),
  waitForBroker: waitForBrokerReady,
  syncClients: syncAllMcpClients,
  heldBack: (server) => isHeldBackFromBroker(server),
}

/**
 * Turn an endpoint on or off and record which clients it should reach.
 * Turning one on waits (up to BROKER_READY_TIMEOUT_MS) for the broker to
 * serve before the apps are updated, so an app that connects right away
 * isn't turned away while the broker probes. The apps are updated either
 * way; `broker` says how far it got. Returns undefined when no endpoint has
 * that id.
 */
export async function setMcpEndpoint(
  id: string,
  change: { enabled: boolean; clients?: Array<McpClientId> },
  steps: McpBrokerSteps = {},
): Promise<SetMcpEndpointResult | undefined> {
  const { reconfigure, waitForBroker, syncClients, heldBack } = {
    ...DEFAULT_STEPS,
    ...steps,
  }
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

  const brokerReloaded = await reconfigure(next.mcpBroker ?? {})
  let broker: SetMcpEndpointResult["broker"]
  if (!change.enabled) broker = brokerReadiness()
  else if (heldBack(server)) broker = "setup-needed"
  else broker = await waitForBroker(BROKER_READY_TIMEOUT_MS)
  const outcome = clientOutcome(id, await syncClients())
  const endpoint = (await listMcpEndpoints()).find((view) => view.id === id)
  if (!endpoint) return undefined
  return {
    endpoint,
    ...outcome,
    brokerReloaded,
    broker,
    ...(adoption ?
      { adoptedFrom: adoption.from, droppedEnvironment: adoption.dropped }
    : {}),
  }
}

/** On shutdown, take the entries Maximal wrote back out of the clients that
 *  read their config per session, so a new session doesn't point at a
 *  Maximal that isn't running; boot puts them back from the recorded
 *  choices. Clients that read their config only at launch (Claude Desktop)
 *  keep theirs. Synchronous and file-only, for the shutdown budget and the
 *  `exit` safety net. */
export function removeMcpClientsOnShutdown(): void {
  for (const app of mcpApps()) {
    if (!app.mcp.removeOnShutdown) continue
    try {
      releaseMcpClientOffline(app.mcp)
    } catch (error) {
      consola.warn(
        `Could not remove ${app.name} MCP servers on shutdown`,
        error,
      )
    }
  }
}

/** The broker's readiness right now, without waiting. */
function brokerReadiness(): BrokerReadiness {
  switch (mcpBrokerHealth().state) {
    case "running": {
      return "ready"
    }
    case "off": {
      return "off"
    }
    case "stuck":
    case "unavailable": {
      return "failed"
    }
    default: {
      return "starting"
    }
  }
}

/** Repair client entries to match config.json, each client in the
 *  background (it may run the `claude` CLI). Skipped entirely when the broker
 *  was never configured; a client that fails is logged, not thrown. */
function syncMcpClientsOnBoot(config: AppConfig): void {
  if (config.mcpBroker === undefined) return
  for (const app of mcpApps()) {
    syncMcpClient(app.mcp).catch((error: unknown) => {
      consola.warn(`Could not update ${app.name} MCP servers`, error)
    })
  }
}

/**
 * At boot, wait (bounded) for the broker to serve, then repair client
 * entries from the config in effect by then. Run detached: the HTTP
 * listener and ordinary proxying never wait on the broker. Never rejects.
 */
export async function syncMcpClientsWhenBrokerReady(
  steps: {
    waitForBroker?: McpBrokerSteps["waitForBroker"]
    sync?: (config: AppConfig) => void
  } = {},
): Promise<void> {
  if (getConfig().mcpBroker === undefined) return
  const { waitForBroker = waitForBrokerReady, sync = syncMcpClientsOnBoot } =
    steps
  try {
    const readiness = await waitForBroker(BROKER_READY_TIMEOUT_MS)
    if (readiness === "starting") {
      consola.warn(
        "MCP broker still starting; updating client apps without waiting longer",
      )
    }
    sync(getConfig())
  } catch (error) {
    consola.warn("Could not update client MCP servers", error)
  }
}

// ── Finding, adding, and removing endpoints ────────────────────────────

/** A known MCP server from the catalog that isn't an endpoint yet. */
export interface McpCatalogView {
  id: string
  label: string
  status: "ready" | "not-installed"
  /** Absolute path of the executable Maximal found. */
  command?: string
  version?: string
  install: CatalogInstallHint
}

export type McpEndpointErrorCode =
  | "exists"
  | "not-installed"
  | "unknown-catalog"

export class McpEndpointError extends Error {
  readonly code: McpEndpointErrorCode

  constructor(code: McpEndpointErrorCode, message: string) {
    super(message)
    this.name = "McpEndpointError"
    this.code = code
  }
}

/** Detection options with config.json's catalog settings filled in. */
function catalogOptions(
  config: AppConfig,
  options: CatalogDetectOptions = {},
): CatalogDetectOptions {
  const npmRegistry = config.mcpBroker?.catalog?.npmRegistry
  return npmRegistry === undefined ? options : { npmRegistry, ...options }
}

/** Catalog servers not yet added, each with whether it's installed. */
export function listMcpCatalog(
  config: AppConfig = getConfig(),
  options?: CatalogDetectOptions,
): Array<McpCatalogView> {
  const detect = catalogOptions(config, options)
  const added = new Set((config.mcpBroker?.servers ?? []).map((s) => s.id))
  return MCP_CATALOG.filter((entry) => !added.has(entry.id)).map((entry) => {
    const found = entry.locate(detect)
    return {
      id: entry.id,
      label: entry.label,
      status: found ? "ready" : "not-installed",
      ...(found ? { command: found.command } : {}),
      ...(found?.version ? { version: found.version } : {}),
      install: entry.install(detect),
    }
  })
}

/** The endpoint config for a catalog server found on this machine. */
export function catalogServer(
  id: string,
  options?: CatalogDetectOptions,
): McpServerConfig {
  const entry = findCatalogEntry(id)
  if (!entry) {
    throw new McpEndpointError("unknown-catalog", `No known MCP server "${id}"`)
  }
  const found = entry.locate(options)
  if (!found) {
    const hint = entry.install(catalogOptions(getConfig(), options))
    throw new McpEndpointError(
      "not-installed",
      `${entry.label} isn't installed. Install it with: ${hint.command}`,
    )
  }
  return entry.template(found, options)
}

/**
 * Add an endpoint, off. Turning it on goes through `setMcpEndpoint`, which
 * asks which apps get it. An endpoint that is off isn't served, so the
 * broker keeps running untouched.
 */
export async function addMcpEndpoint(
  server: McpServerConfig,
): Promise<{ endpoint: McpEndpointView; brokerReloaded: boolean }> {
  const config = getConfig()
  const servers = config.mcpBroker?.servers ?? []
  if (servers.some((existing) => existing.id === server.id)) {
    throw new McpEndpointError(
      "exists",
      `An MCP endpoint "${server.id}" already exists`,
    )
  }
  const next = writeConfig({
    ...config,
    mcpBroker: {
      ...config.mcpBroker,
      servers: [...servers, { ...server, enabled: false }],
    },
  })
  const brokerReloaded = await reconfigureBroker(next.mcpBroker ?? {})
  const endpoint = (await listMcpEndpoints(next)).find(
    (view) => view.id === server.id,
  )
  if (!endpoint) throw new Error(`MCP endpoint "${server.id}" was not saved`)
  return { endpoint, brokerReloaded }
}

/**
 * Remove an endpoint and every entry Maximal wrote for it into client apps.
 * Config goes first: the apps' desired entries come from `servers`, while
 * the ids Maximal owns are kept per app, so the sync that follows removes
 * exactly what Maximal added. Undefined when no endpoint has that id.
 */
export async function removeMcpEndpoint(
  id: string,
): Promise<
  { removedFrom: Array<McpClientSkip>; brokerReloaded: boolean } | undefined
> {
  const config = getConfig()
  const servers = config.mcpBroker?.servers ?? []
  if (!servers.some((server) => server.id === id)) return undefined
  const next = writeConfig({
    ...config,
    mcpBroker: {
      ...config.mcpBroker,
      servers: servers.filter((server) => server.id !== id),
    },
  })
  const brokerReloaded = await reconfigureBroker(next.mcpBroker ?? {})
  const removedFrom = (await syncAllMcpClients()).flatMap(
    ({ client, name, result }) =>
      result.removed.includes(id) ? [{ client, name }] : [],
  )
  return { removedFrom, brokerReloaded }
}

/**
 * Keep each catalog endpoint on the newest install of its server. Package
 * managers install upgrades into new versioned directories and may keep the
 * old ones, so the saved path goes stale either way. Runs at boot and on
 * every Settings list. Returns the config in effect (the same object when
 * nothing changed); an uninstalled server keeps its last path.
 */
export function refreshCatalogCommands(
  config: AppConfig = getConfig(),
  options?: CatalogDetectOptions,
): AppConfig {
  const servers = config.mcpBroker?.servers
  if (!servers) return config
  const next = servers.map((server) => {
    const entry = server.catalog ? findCatalogEntry(server.catalog) : undefined
    if (!entry) return server
    const found: CatalogInstall | undefined = entry.locate(options)
    if (!found || found.command === server.transport.command) return server
    const version = found.version ? ` ${found.version}` : ""
    consola.info(`${server.label}: now running${version} at ${found.command}`)
    return {
      ...server,
      transport: { ...server.transport, command: found.command },
    }
  })
  if (next.every((server, i) => server === servers[i])) return config
  try {
    return writeConfig({
      ...config,
      mcpBroker: { ...config.mcpBroker, servers: next },
    })
  } catch (error) {
    consola.warn("Could not save the updated MCP server paths", error)
    return config
  }
}
