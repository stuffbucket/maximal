/** Error codes for plugin-contract violations (cordis-free). */
export type PluginContractErrorCode =
  | "invalid-module"
  | "invalid-manifest"
  | "missing-service"
  | "invalid-config"
  | "invalid-settings"
  | "not-a-plugin"
  | "invalid-tool"
  | "duplicate-tool"
  | "invalid-action"
  | "duplicate-action"
  | "invalid-status"
  | "invalid-notice"
  | "invalid-storage-name"
  | "invalid-url"
  | "invalid-operation"
  | "duplicate-operation"
  | "invalid-provider"
  | "duplicate-provider"

/**
 * Thrown when a plugin (or a plugin list) violates the plugin contract:
 * malformed module, unknown injected service, invalid config, bad tool or
 * action registration, etc.
 */
export class PluginContractError extends Error {
  readonly code: PluginContractErrorCode
  readonly pluginId: string | undefined

  constructor(
    code: PluginContractErrorCode,
    message: string,
    options?: { pluginId?: string; cause?: unknown },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = "PluginContractError"
    this.code = code
    this.pluginId = options?.pluginId
  }
}
