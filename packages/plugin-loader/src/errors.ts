export type PluginInventoryErrorCode =
  | "invalid-document"
  | "invalid-json"
  | "read-failed"
  | "read-not-found"
  | "read-permission-denied"
  | "read-too-large"
  | "resolution-failed"
  | "expansion-limit"
  | "unsafe-include"
  | "missing-include"
  | "include-cycle"
  | "duplicate-plugin"
  | "duplicate-group"
  | "duplicate-descriptor"
  | "duplicate-installation"
  | "duplicate-module"
  | "missing-member"
  | "missing-descriptor"
  | "missing-installation"
  | "provenance-mismatch"
  | "installation-mismatch"
  | "group-cycle"
  | "group-depth-limit"
  | "group-work-limit"

export interface PluginInventoryErrorOptions {
  readonly source?: string
  readonly path?: string
  readonly member?: string
  readonly cycle?: ReadonlyArray<string>
  readonly cause?: unknown
}

/** A stable, machine-readable inventory validation or resolution failure. */
export class PluginInventoryError extends Error {
  readonly code: PluginInventoryErrorCode
  readonly source: string | undefined
  readonly path: string | undefined
  readonly member: string | undefined
  readonly cycle: ReadonlyArray<string> | undefined

  constructor(
    code: PluginInventoryErrorCode,
    message: string,
    options: PluginInventoryErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = "PluginInventoryError"
    this.code = code
    this.source = options.source
    this.path = options.path
    this.member = options.member
    this.cycle = options.cycle
  }
}

export type PluginModuleLoadErrorCode =
  | "invalid-generation"
  | "missing-export"
  | "module-load-failed"
  | "invalid-generation-artifact"

export type PluginGenerationErrorCode =
  | "invalid-manifest"
  | "incompatible-generation"
  | "incompatible-plugin"
  | "missing-provider"
  | "duplicate-provider"
  | "dependency-cycle"
  | "untrusted-path"
  | "artifact-changed"
  | "hash-mismatch"
  | "missing-export"
  | "module-metadata-mismatch"
  | "invalid-selection"
  | "commit-corrupt"
  | "generation-in-use"
  | "generation-not-found"
  | "gc-failed"

export class PluginGenerationError extends Error {
  readonly code: PluginGenerationErrorCode
  readonly generationId: string | undefined
  readonly pluginId: string | undefined

  constructor(
    code: PluginGenerationErrorCode,
    message: string,
    options: {
      readonly generationId?: string
      readonly pluginId?: string
      readonly cause?: unknown
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = "PluginGenerationError"
    this.code = code
    this.generationId = options.generationId
    this.pluginId = options.pluginId
  }
}

export class PluginModuleLoadError extends Error {
  readonly code: PluginModuleLoadErrorCode
  readonly pluginId: string | undefined
  readonly specifier: string | undefined

  constructor(
    code: PluginModuleLoadErrorCode,
    message: string,
    options: {
      readonly pluginId?: string
      readonly specifier?: string
      readonly cause?: unknown
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = "PluginModuleLoadError"
    this.code = code
    this.pluginId = options.pluginId
    this.specifier = options.specifier
  }
}
