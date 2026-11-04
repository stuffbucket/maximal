/**
 * What Settings shows for each plugin (`PluginView`): the gateway's snapshot
 * plus the user's client connections and the plugin's MCP endpoint URL.
 * Shared by `GET /settings/api/plugins` and the `plugins.changed` event.
 */

import type {
  PluginGateway,
  PluginSnapshot,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import type {
  PluginClientView,
  PluginsListResponse,
  PluginView,
} from "~/lib/config/settings-types"

import { type AppConfig, getConfig } from "~/lib/config/config"

import { claudeCodePluginClient } from "./clients/claude-code"
import { type PluginClientConfigurator, pluginMcpUrl } from "./clients/sync"
import { pluginClients } from "./settings"

/** The clients a plugin's endpoint can be registered with, in UI order. */
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

function toView(
  snapshot: PluginSnapshot,
  config: AppConfig,
  clients: Array<ClientAvailability>,
): PluginView {
  const selected = pluginClients(config, snapshot.id)
  return {
    ...snapshot,
    clients: clients.map(
      ({ configurator, available }): PluginClientView => ({
        id: configurator.clientId,
        selected: selected.includes(configurator.clientId),
        available,
        ...(available ? {} : { reason: configurator.unavailableReason() }),
      }),
    ),
    endpoint: pluginMcpUrl(snapshot.id),
  }
}

export async function listPluginViews(
  gateway: PluginGateway,
): Promise<PluginsListResponse> {
  const clients = await clientAvailability()
  const config = getConfig()
  return {
    plugins: gateway
      .list()
      .map((snapshot) => toView(snapshot, config, clients)),
  }
}

export async function pluginView(
  gateway: PluginGateway,
  id: string,
): Promise<PluginView | undefined> {
  const snapshot = gateway.get(id)
  if (!snapshot) return undefined
  return toView(snapshot, getConfig(), await clientAvailability())
}
