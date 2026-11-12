import type { PluginInventoryError } from "./errors"

export const PLUGIN_INVENTORY_SCHEMA = "maximal-plugin-inventory/1" as const
export const MAX_INVENTORY_BYTES = 1_048_576
export const MAX_INVENTORY_FILES = 256
export const MAX_INVENTORY_DEPTH = 64
export const MAX_GROUP_DEPTH = 128
export const MAX_GROUP_GRAPH_WORK = 4_096
export const MAX_EXPANDED_PLUGINS = 10_000

export type JsonPrimitive = boolean | number | string | null
export type JsonValue =
  | JsonPrimitive
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export interface PluginModuleIdentity {
  /** Stable catalog identity; inventories never supply executable paths. */
  readonly moduleId: string
  readonly export?: string
}
export interface PluginServiceDependencies {
  /** Services this module makes available to other enabled plugins. */
  readonly provides?: ReadonlyArray<string>
  /** Services this module requires from the host or another enabled plugin. */
  readonly requires?: ReadonlyArray<string>
}
export interface ExternalPackageIdentity {
  readonly name: string
  readonly version?: string
  readonly location: string
}
export interface PluginCompatibility {
  readonly maximal?: string
  readonly pluginApi?: string
  readonly runtime?: string
  readonly platforms?: ReadonlyArray<string>
  readonly architectures?: ReadonlyArray<string>
}
interface PluginDescriptorBase {
  readonly id: string
  readonly module: PluginModuleIdentity
  readonly compatibility?: PluginCompatibility
  readonly services?: PluginServiceDependencies
}
export interface BuiltInPluginDescriptor extends PluginDescriptorBase {
  readonly provenance: "built-in"
}
export interface ExternalPluginDescriptor extends PluginDescriptorBase {
  readonly provenance: "external"
}
export type PluginDescriptor =
  | BuiltInPluginDescriptor
  | ExternalPluginDescriptor
export interface PluginInstallation {
  readonly id: string
  readonly descriptorId: string
  readonly package: ExternalPackageIdentity
}
export interface PluginCatalog {
  readonly descriptors: ReadonlyArray<PluginDescriptor>
  readonly installations: ReadonlyArray<PluginInstallation>
}

export interface PluginDefinition {
  readonly id: string
  readonly descriptorId: string
  readonly installationId?: string
}
export type InventoryMember =
  | { readonly plugin: string }
  | { readonly group: string }
export interface PluginGroupDefinition {
  readonly id: string
  readonly members: ReadonlyArray<InventoryMember>
}
export interface PluginInventoryDocument {
  readonly $schema: typeof PLUGIN_INVENTORY_SCHEMA
  readonly includes?: ReadonlyArray<string>
  readonly plugins?: ReadonlyArray<PluginDefinition>
  readonly groups?: ReadonlyArray<PluginGroupDefinition>
  readonly members?: ReadonlyArray<InventoryMember>
  readonly disabled?: ReadonlyArray<InventoryMember>
}

/** A validated document plus canonical include identities opened by the adapter. */
export interface InventoryDocumentSource {
  readonly source: string
  readonly document: PluginInventoryDocument
  readonly includeSources: ReadonlyArray<string>
}
export interface InventoryOpenedFile {
  readonly canonicalId: string
  readonly text: string
}
export type InventoryReadFailureCode =
  | "not-found"
  | "permission-denied"
  | "too-large"
  | "io"
export class InventoryReadFailure extends Error {
  readonly code: InventoryReadFailureCode
  constructor(
    code: InventoryReadFailureCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = "InventoryReadFailure"
    this.code = code
  }
}
/** Implementations must canonicalize, enforce root containment, and read from the same opened handle. */
export interface InventoryFileSystem {
  openEntry(input: {
    readonly rootDirectory: string
    readonly entry: string
    readonly maxBytes: number
  }): Promise<InventoryOpenedFile>
  openInclude(input: {
    readonly rootDirectory: string
    readonly parentCanonicalId: string
    readonly reference: string
    readonly maxBytes: number
  }): Promise<InventoryOpenedFile>
}

interface ResolvedPluginBase {
  readonly id: string
  readonly descriptorId: string
  readonly definedIn: string
}
export interface ResolvedBuiltInPlugin extends ResolvedPluginBase {
  readonly provenance: "built-in"
  readonly descriptor: BuiltInPluginDescriptor
}
export interface ResolvedExternalPlugin extends ResolvedPluginBase {
  readonly provenance: "external"
  readonly installationId: string
  readonly descriptor: ExternalPluginDescriptor
  readonly installation: PluginInstallation
}
export type ResolvedPlugin = ResolvedBuiltInPlugin | ResolvedExternalPlugin
export interface ResolvedPluginInventory {
  readonly plugins: ReadonlyArray<ResolvedPlugin>
  readonly sources: ReadonlyArray<string>
}
export type InventoryReloadResult =
  | { readonly ok: true; readonly inventory: ResolvedPluginInventory }
  | {
      readonly ok: false
      readonly inventory: ResolvedPluginInventory
      readonly error: PluginInventoryError
    }
