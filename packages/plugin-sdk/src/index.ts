/**
 * `@stuffbucket/maximal-plugin-sdk` — the maximal plugin contract.
 *
 * Plugins import cordis through this package so every plugin and the host
 * share one cordis runtime identity, and so the `Context` augmentation for
 * the host-provided services (`tools`, `surface`, `storage`, `host`, plus any `AppServices` the app adds)
 * is in scope.
 */
import type { Context } from "@deepseek-ai/cordis"
import type { StandardSchemaV1 } from "@standard-schema/spec"

import type {
  AppServices,
  HostServices,
  PluginManifest,
  PluginStorage,
  PluginSurface,
  ToolDefinitionPublic,
  ToolPermission,
  ToolRegistry,
} from "./types"

export { PluginContractError, type PluginContractErrorCode } from "./errors"
export * from "./types"
export { Context, Service } from "@deepseek-ai/cordis"

export type {
  Disposable,
  Effect,
  Fiber,
  Inject,
  Plugin,
} from "@deepseek-ai/cordis"
export type { StandardSchemaV1 } from "@standard-schema/spec"

/** `inject` export: an array of service names or a cordis `{ name: config }` map. */
export type PluginInject =
  | ReadonlyArray<string>
  | Readonly<Record<string, unknown>>

/**
 * A maximal plugin: an ESM module namespace with these exports.
 *
 * ```ts
 * export const name = "example"                       // === manifest.id
 * export const manifest = {
 *   id: "example", kind: "extension", displayName: "Example", description: "…", settingsVersion: 1,
 * } satisfies PluginManifest
 * export const inject = ["tools", "surface"] as const
 * export const Config = z.object({ greeting: z.string().default("hi") })
 * export function apply(ctx: Context, config: z.output<typeof Config>) { … }
 * ```
 */
export interface PluginModule<C = unknown> {
  /** Stable id matching `PLUGIN_ID_PATTERN`; equals `manifest.id` (cordis needs it as `name`). */
  readonly name: string
  readonly manifest: PluginManifest
  readonly inject: PluginInject
  /** Any Standard Schema (maximal uses zod 4); `{}` must be valid. */
  readonly Config: StandardSchemaV1<unknown, C>
  apply(ctx: Context, config: C): void | Promise<void>
  /**
   * Upgrade a stored config written under settings version `fromVersion`
   * (< `manifest.settingsVersion`) to the current shape. `config` is the raw
   * stored value (`undefined` when none was stored). May return a promise.
   * Without this export the stored config is carried over unchanged.
   */
  migrateSettings?(fromVersion: number, config: unknown): unknown
  /**
   * Default permission for a tool the user has not configured; `undefined`
   * falls back to the host default (`allow`). Must be pure and fast.
   */
  defaultToolPermission?(tool: ToolDefinitionPublic): ToolPermission | undefined
}

declare module "@deepseek-ai/cordis" {
  interface Context extends AppServices {
    tools: ToolRegistry
    surface: PluginSurface
    storage: PluginStorage
    host: HostServices
  }
}
