/**
 * The running plugin gateway, for routes and client sync.
 *
 * Set once at boot (`startPlugins`), cleared at shutdown. Absent in
 * processes that don't serve (CLI commands), so callers treat "no gateway"
 * as "no plugins running here".
 */

import {
  type OperationDispatch,
  OperationUnavailableError,
  type PluginGateway,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

let current: PluginGateway | undefined

export function getPluginGateway(): PluginGateway | undefined {
  return current
}

export function setPluginGateway(gateway: PluginGateway | undefined): void {
  current = gateway
}

const noUnsubscribe = (): void => {}

/**
 * The running gateway's operation dispatch, looked up at each call so a route
 * built at import time follows the gateway that boot sets later. With no
 * gateway (it hasn't started, or this process doesn't serve plugins) nothing
 * resolves: every operation is unavailable.
 */
export const pluginOperations: OperationDispatch = {
  resolve: (operation, model) =>
    current?.operations().resolve(operation, model),
  dispatch: (request) =>
    current ?
      current.operations().dispatch(request)
    : Promise.reject(
        new OperationUnavailableError(request.operation, request.model),
      ),
  servedModels: () => current?.operations().servedModels() ?? [],
  subscribe: (listener) =>
    current?.operations().subscribe(listener) ?? noUnsubscribe,
}
