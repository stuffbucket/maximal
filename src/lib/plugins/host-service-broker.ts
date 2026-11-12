import type {
  HostServices,
  PluginLogger,
} from "@stuffbucket/maximal-plugin-sdk"

export interface HostServiceSnapshot {
  readonly revision: number
  readonly appVersion: string
  readonly maximalPort: number
}

/** Parent-owned host capabilities suitable for a later reverse-RPC adapter. */
export interface ParentHostServiceBroker {
  snapshot(): HostServiceSnapshot
  openExternal(url: string): Promise<void>
  readonly logger: PluginLogger
}

/** Today's direct loopback adapter; no credentials or mutable parent state move. */
export function hostServicesFromBroker(
  broker: ParentHostServiceBroker,
): HostServices {
  return {
    get appVersion() {
      return broker.snapshot().appVersion
    },
    maximalPort: () => broker.snapshot().maximalPort,
    logger: broker.logger,
    openExternal: (url) => broker.openExternal(url),
  }
}
