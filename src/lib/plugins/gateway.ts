/**
 * The running plugin gateway, for routes and client sync.
 *
 * Set once at boot (`startPlugins`), cleared at shutdown. Absent in
 * processes that don't serve (CLI commands), so callers treat "no gateway"
 * as "no plugins running here".
 */

import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"

let current: PluginGateway | undefined

export function getPluginGateway(): PluginGateway | undefined {
  return current
}

export function setPluginGateway(gateway: PluginGateway | undefined): void {
  current = gateway
}
