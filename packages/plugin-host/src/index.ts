/**
 * `@stuffbucket/maximal-plugin-host` — the cordis-backed `PluginGateway`.
 * Only the composition root (`src/lib/plugins/compose.ts`) imports this.
 */
export { createPluginHost, type PluginHostOptions } from "./host"
export {
  type HostServices,
  PluginContractError,
  type PluginManifest,
  type PluginModule,
} from "@stuffbucket/maximal-plugin-sdk"
export {
  type PluginGateway,
  PluginGatewayError,
} from "@stuffbucket/maximal-plugin-sdk/gateway"
export {
  createFileStorage,
  operationsService,
  type PluginServiceFactory,
  providersService,
  serverToolsService,
} from "@stuffbucket/maximal-plugin-sdk/runtime"
