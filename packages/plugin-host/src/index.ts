/**
 * `@stuffbucket/maximal-plugin-host` — the cordis-backed `PluginGateway`.
 * Only the composition root (`src/lib/plugins/compose.ts`) imports this.
 */
export {
  createPluginHost,
  type PluginHostGateway,
  type PluginHostOptions,
} from "./host"
export {
  type DurableCommitState,
  handoffPluginResources,
  HostGenerationResourceLifecycle,
  ManagedPluginResourceLifecycle,
  type PluginResourceHandoffOptions,
  type ResourceHandoffDurableState,
  ResourceHandoffError,
} from "./resource-lifecycle"
export {
  type HostServices,
  PluginContractError,
  type PluginManifest,
  type PluginModule,
} from "@stuffbucket/maximal-plugin-sdk"
export {
  type PluginGateway,
  PluginGatewayError,
  type PluginSource,
} from "@stuffbucket/maximal-plugin-sdk/gateway"
export {
  createFileStorage,
  operationsService,
  type PluginServiceFactory,
  providersService,
  serverToolsService,
} from "@stuffbucket/maximal-plugin-sdk/runtime"
