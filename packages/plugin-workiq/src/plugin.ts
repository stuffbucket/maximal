import {
  defineRemoteMcpConnector,
  type RemoteMcpConnectorModule,
  type RemoteMcpConnectorOptions,
} from "@stuffbucket/maximal-connector-kit"

import { WORKIQ_MANIFEST } from "./manifest"
import { WORKIQ_THROTTLE } from "./throttle"
import { WORKIQ_ERRORS, WORKIQ_WORDING } from "./wording"

/**
 * Seams for tests, the bench and embedding: `endpoint` (e.g. a local fake),
 * `auth` (e.g. `fakeAuth()` from the kit's testing export), timeouts,
 * retry pacing and `limits`. Production uses the defaults: Microsoft's
 * endpoint, Entra sign-in with the Work IQ app, and the Work IQ throttling
 * hooks (`WORKIQ_THROTTLE`).
 */
export type WorkIqPluginOptions = Omit<
  RemoteMcpConnectorOptions,
  "errors" | "wording"
>

/** Build the Work IQ connector module (the package entry exports the default instance). */
export function createWorkIqPlugin(
  options: WorkIqPluginOptions = {},
): RemoteMcpConnectorModule {
  return defineRemoteMcpConnector(WORKIQ_MANIFEST, {
    throttle: WORKIQ_THROTTLE,
    ...options,
    errors: WORKIQ_ERRORS,
    wording: WORKIQ_WORDING,
  })
}
