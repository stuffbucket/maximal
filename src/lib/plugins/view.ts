/**
 * What Settings shows for each plugin: `PluginView` (list item) and
 * `PluginDetailView` (one plugin with its config and full tools), built from
 * the gateway's snapshot plus the user's client connections and the
 * plugin's MCP endpoint URL. Shared by `/settings/api/plugins` and the
 * `plugins.changed` event.
 *
 * Views are built field by field (never by spreading the snapshot), so
 * nothing the wire contract doesn't declare — auth client ids, authorities,
 * scopes — can leak, even on the SSE path that skips `respondValidated`.
 */

import type {
  PluginGateway,
  PluginSnapshot,
  PluginToolView as GatewayToolView,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import type {
  PluginClientView,
  PluginConnectorInfo,
  PluginDetailView,
  PluginManifestView,
  PluginsListResponse,
  PluginToolCounts,
  PluginToolView,
  PluginView,
} from "~/lib/config/settings-types"

import { type AppConfig, getConfig } from "~/lib/config/config"

import { claudeCodePluginClient } from "./clients/claude-code"
import { type PluginClientConfigurator, pluginMcpUrl } from "./clients/sync"
import { pluginClients } from "./settings"

/** The clients a connector's endpoint can be registered with, in UI order. */
export const PLUGIN_CLIENTS: ReadonlyArray<PluginClientConfigurator> = [
  claudeCodePluginClient,
]

interface ClientAvailability {
  configurator: PluginClientConfigurator
  available: boolean
}

async function clientAvailability(): Promise<Array<ClientAvailability>> {
  return Promise.all(
    PLUGIN_CLIENTS.map(async (configurator) => ({
      configurator,
      available: await configurator.available().catch(() => false),
    })),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A connector's upstream URL in effect: its config's `endpoint` override
 *  (the connector-kit config convention) when it is an http(s) URL, else
 *  the manifest default. */
function effectiveEndpoint(snapshot: PluginSnapshot, fallback: string): string {
  const override = isRecord(snapshot.config) ? snapshot.config.endpoint : null
  if (typeof override !== "string") return fallback
  try {
    const { protocol } = new URL(override)
    return protocol === "http:" || protocol === "https:" ? override : fallback
  } catch {
    return fallback
  }
}

function connectorInfo(
  snapshot: PluginSnapshot,
): PluginConnectorInfo | undefined {
  const connector = snapshot.manifest.connector
  if (snapshot.kind !== "connector" || !connector) return undefined
  return {
    transport: connector.transport,
    endpoint: effectiveEndpoint(snapshot, connector.endpoint),
    auth: { type: connector.auth.type },
    ...(connector.terms ?
      {
        terms: {
          url: connector.terms.url,
          ...(connector.terms.label === undefined ?
            {}
          : { label: connector.terms.label }),
        },
      }
    : {}),
  }
}

function manifestView(snapshot: PluginSnapshot): PluginManifestView {
  const { manifest } = snapshot
  const connector = connectorInfo(snapshot)
  return {
    id: manifest.id,
    kind: manifest.kind,
    displayName: manifest.displayName,
    description: manifest.description,
    ...(manifest.homepage === undefined ? {} : { homepage: manifest.homepage }),
    ...(connector ? { connector } : {}),
  }
}

function toolCounts(tools: ReadonlyArray<GatewayToolView>): PluginToolCounts {
  const byGroup = { "read-only": 0, "write-delete": 0, other: 0 }
  for (const tool of tools) byGroup[tool.group] += 1
  return { total: tools.length, byGroup }
}

function toolView(tool: GatewayToolView): PluginToolView {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ?
      {}
    : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined ?
      {}
    : { annotations: { ...tool.annotations } }),
    group: tool.group,
    permission: tool.permission,
    permissionSource: tool.permissionSource,
  }
}

interface ViewContext {
  config: AppConfig
  clients: Array<ClientAvailability>
}

function toView(
  snapshot: PluginSnapshot,
  tools: ReadonlyArray<GatewayToolView>,
  { config, clients }: ViewContext,
): PluginView {
  // Only connectors are served over MCP (`/mcp/<id>`), so only they have an
  // endpoint and client connections.
  const isConnector = snapshot.kind === "connector"
  const selected = pluginClients(config, snapshot.id)
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    // The host loads a static first-party set: every plugin is built in.
    source: "built-in",
    displayName: snapshot.displayName,
    description: snapshot.description,
    ...(snapshot.homepage === undefined ? {} : { homepage: snapshot.homepage }),
    manifest: manifestView(snapshot),
    enabled: snapshot.enabled,
    lifecycle: snapshot.lifecycle,
    ...(snapshot.lifecycle === "failed" && snapshot.error !== undefined ?
      { error: snapshot.error }
    : {}),
    ...(snapshot.status === undefined ? {} : { status: snapshot.status }),
    toolCounts: toolCounts(tools),
    toolsSource: snapshot.toolsSource,
    clients:
      isConnector ?
        clients.map(
          ({ configurator, available }): PluginClientView => ({
            id: configurator.clientId,
            selected: selected.includes(configurator.clientId),
            available,
            ...(available ? {} : { reason: configurator.unavailableReason() }),
          }),
        )
      : [],
    endpoint: isConnector ? pluginMcpUrl(snapshot.id) : "",
  }
}

function toDetail(
  snapshot: PluginSnapshot,
  tools: ReadonlyArray<GatewayToolView>,
  view: PluginView,
): PluginDetailView {
  return {
    ...view,
    settingsVersion: snapshot.settingsVersion,
    ...(isRecord(snapshot.config) ? { config: snapshot.config } : {}),
    ...(snapshot.configSchema === undefined ?
      {}
    : { configSchema: snapshot.configSchema }),
    tools: tools.map((tool) => toolView(tool)),
    ...(snapshot.catalogUpdatedAt === undefined ?
      {}
    : { catalogUpdatedAt: snapshot.catalogUpdatedAt }),
  }
}

function safeToolViews(
  gateway: PluginGateway,
  id: string,
): Array<GatewayToolView> {
  try {
    return gateway.toolViews(id)
  } catch {
    // Raced with an unknown id; the snapshot lookup reports it.
    return []
  }
}

export async function listPluginViews(
  gateway: PluginGateway,
): Promise<PluginsListResponse> {
  const clients = await clientAvailability()
  const config = getConfig()
  return {
    plugins: gateway.list().map((snapshot) =>
      toView(snapshot, safeToolViews(gateway, snapshot.id), {
        config,
        clients,
      }),
    ),
  }
}

export async function pluginDetailView(
  gateway: PluginGateway,
  id: string,
): Promise<PluginDetailView | undefined> {
  const clients = await clientAvailability()
  const snapshot = gateway.get(id)
  if (!snapshot) return undefined
  const tools = safeToolViews(gateway, id)
  return toDetail(
    snapshot,
    tools,
    toView(snapshot, tools, { config: getConfig(), clients }),
  )
}
