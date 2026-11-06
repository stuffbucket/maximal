import type {
  ToolDefinitionPublic,
  ToolPermission,
} from "@stuffbucket/maximal-plugin-sdk"

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

/**
 * Work IQ's own defaults on top of the host's (read-only tools allowed,
 * everything else asks): deleting from Microsoft 365 is off until turned
 * on in Settings. Microsoft marks updates and deletes alike as destructive,
 * so the annotations alone can't tell them apart.
 */
function workiqDefaultPermission(
  tool: ToolDefinitionPublic,
): ToolPermission | undefined {
  return WORKIQ_BLOCKED_BY_DEFAULT.has(tool.name) ? "block" : undefined
}

/** Tools that are off until the user turns them on. */
const WORKIQ_BLOCKED_BY_DEFAULT: ReadonlySet<string> = new Set([
  "delete_entity",
])

/** Build the Work IQ connector module (the package entry exports the default instance). */
export function createWorkIqPlugin(
  options: WorkIqPluginOptions = {},
): RemoteMcpConnectorModule {
  return defineRemoteMcpConnector(WORKIQ_MANIFEST, {
    throttle: WORKIQ_THROTTLE,
    defaultToolPermission: workiqDefaultPermission,
    ...options,
    errors: WORKIQ_ERRORS,
    wording: WORKIQ_WORDING,
  })
}
