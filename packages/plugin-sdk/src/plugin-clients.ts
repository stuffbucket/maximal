/**
 * Data-only client destinations contributed through the plugin runtime.
 *
 * Contributions describe what Settings may offer. The filesystem writer named
 * by `driverId` stays in the parent app and is never part of this contract.
 */
import type { PluginDisposer } from "./types"

export type PluginClientId =
  | "claude-code"
  | "claude-desktop"
  | "codex"
  | "copilot-cli"

export interface PluginClientContribution {
  readonly clientId: PluginClientId
  /** Opaque parent-owned writer identity. Never shown in Settings responses. */
  readonly driverId?: string
  /** Static reason for catalog entries without a parent writer. */
  readonly unavailableReason?: string
}

/** Cordis service `pluginClients`; registrations follow the calling fiber. */
export interface PluginClientRegistry {
  register(contribution: PluginClientContribution): PluginDisposer
  list(): ReadonlyArray<PluginClientContribution>
}

declare module "./types" {
  interface AppServices {
    pluginClients: PluginClientRegistry
  }
}
