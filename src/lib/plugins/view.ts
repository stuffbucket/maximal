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
  PluginClientId,
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

/** Clients Maximal can currently write connector entries to. */
export const PLUGIN_CLIENTS: ReadonlyArray<PluginClientConfigurator> = [
  claudeCodePluginClient,
]

interface ClientOption {
  clientId: PluginClientId
  configurator?: PluginClientConfigurator
  unavailableReason?: string
}

/** Every Maximal app, in the same order as the Apps page. Apps without a
 * connector writer stay visible but unavailable rather than disappearing. */
const CLIENT_OPTIONS: ReadonlyArray<ClientOption> = [
  { clientId: "claude-code", configurator: claudeCodePluginClient },
  {
    clientId: "claude-desktop",
    unavailableReason:
      "Claude Desktop only accepts local MCP processes here; Maximal can't add this HTTP connector.",
  },
  {
    clientId: "codex",
    unavailableReason: "Maximal doesn't add connectors to Codex yet.",
  },
  {
    clientId: "copilot-cli",
    unavailableReason: "Copilot CLI integration is coming soon.",
  },
]

interface ClientAvailability {
  option: ClientOption
  available: boolean
}

function clientAvailability(): Array<ClientAvailability> {
  return CLIENT_OPTIONS.map((option) => {
    let available = false
    try {
      available = option.configurator?.available() ?? false
    } catch {
      // Unreadable config: shown as unavailable.
    }
    return { option, available }
  })
}

/** The client's own setup of the connector, which Maximal defers to. */
function standaloneIn(
  configurator: PluginClientConfigurator | undefined,
  id: string,
): PluginClientView["standalone"] {
  try {
    return configurator?.standalone(id)
  } catch {
    return undefined
  }
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
        clients.map(({ option, available }): PluginClientView => {
          const { clientId, configurator, unavailableReason } = option
          const standalone = standaloneIn(configurator, snapshot.id)
          return {
            id: clientId,
            selected: selected.includes(clientId),
            available,
            ...(available ?
              {}
            : {
                reason:
                  unavailableReason
                  ?? configurator?.unavailableReason()
                  ?? "This app can't receive connectors from Maximal yet.",
              }),
            ...(standalone ? { standalone } : {}),
          }
        })
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

export function listPluginViews(
  gateway: PluginGateway,
): Promise<PluginsListResponse> {
  const clients = clientAvailability()
  const config = getConfig()
  return Promise.resolve({
    plugins: gateway.list().map((snapshot) =>
      toView(snapshot, safeToolViews(gateway, snapshot.id), {
        config,
        clients,
      }),
    ),
  })
}

export function pluginDetailView(
  gateway: PluginGateway,
  id: string,
): Promise<PluginDetailView | undefined> {
  const clients = clientAvailability()
  const snapshot = gateway.get(id)
  if (!snapshot) return Promise.resolve(undefined)
  const tools = safeToolViews(gateway, id)
  return Promise.resolve(
    toDetail(
      snapshot,
      tools,
      toView(snapshot, tools, { config: getConfig(), clients }),
    ),
  )
}
