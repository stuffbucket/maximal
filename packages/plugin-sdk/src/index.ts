/**
 * `@stuffbucket/maximal-plugin-sdk` — the maximal plugin contract.
 *
 * Plugins import cordis through this package so every plugin and the host
 * share one cordis runtime identity, and so the `Context` augmentation for
 * the host-provided services (`tools`, `surface`, `storage`, `host`) is in
 * scope.
 */
import type { Context } from "@deepseek-ai/cordis"
import type { StandardSchemaV1 } from "@standard-schema/spec"

import type {
  HostServices,
  PluginMeta,
  PluginStorage,
  PluginSurface,
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
 * export const name = "example"
 * export const meta: PluginMeta = { displayName: "Example", description: "…" }
 * export const inject = ["tools", "surface"] as const
 * export const Config = z.object({ greeting: z.string().default("hi") })
 * export function apply(ctx: Context, config: z.output<typeof Config>) { … }
 * ```
 */
export interface PluginModule<C = unknown> {
  /** Stable id matching `PLUGIN_ID_PATTERN`. */
  readonly name: string
  readonly meta: PluginMeta
  readonly inject: PluginInject
  /** Any Standard Schema (maximal uses zod 4); `{}` must be valid. */
  readonly Config: StandardSchemaV1<unknown, C>
  apply(ctx: Context, config: C): void | Promise<void>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    tools: ToolRegistry
    surface: PluginSurface
    storage: PluginStorage
    host: HostServices
  }
}
