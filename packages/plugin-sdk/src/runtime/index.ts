/**
 * Shared plugin runtime for plugin hosts and the `/testing` harness.
 *
 * Plugins must not import this subpath: it is the machinery behind the
 * services they receive on `ctx`, shared so that the testing harness behaves
 * exactly like `@stuffbucket/maximal-plugin-host`.
 */
import type { Context, Fiber, Plugin } from "@deepseek-ai/cordis"

import type { PluginModule } from "../index"
import type { ToolCallContext, ToolDefinition, ToolResult } from "../types"
import type { PluginRuntime } from "./state"

import { isInjectList } from "./validate"

export {
  createStorageSettingsAuthority,
  isPluginSettingsConflictError,
  type PluginSettingsAuthority,
  type PluginSettingsCommit,
  PluginSettingsConflictError,
  type PluginSettingsProposal,
  type PluginSettingsProposalKind,
  type PluginSettingsRevision,
  type PluginSettingsTransaction,
} from "./authority"
export { createFileStorage } from "./file-storage"
export { nonJsonPath, normalizeManifest } from "./manifest"
export { operationDispatchOf, operationsService } from "./operations"
export { providersService } from "./providers"
export { serverToolsService } from "./server-tools"
export {
  installPluginServices,
  type PluginServiceFactory,
  type PluginServiceOptions,
  type PluginStorageBackend,
} from "./services"
export {
  applyPermissionChanges,
  type LoadedPluginSettings,
  loadPluginSettings,
  migrateSettingsDocument,
  newSettingsDocument,
  parseSettingsDocument,
  permissionChangesError,
  PLUGIN_SETTINGS_SCHEMA,
  type PluginSettingsDocument,
  PluginSettingsFileError,
  type PluginSettingsTools,
  resolveToolPermission,
  serializeSettingsDocument,
  setToolCatalog,
  storedPermissions,
  type ToolCatalog,
  toolView,
  toPublicTool,
  writePluginSettings,
} from "./settings"
export {
  PluginRuntime,
  type PluginRuntimeEvent,
  type PluginRuntimeEventType,
  type PluginRuntimeOptions,
  PluginSlot,
} from "./state"
export {
  assertPluginDependencies,
  formatConfigIssues,
  injectedServices,
  isInjectList,
  normalizeNotice,
  normalizeStatus,
  normalizeToolDefinition,
  type ParsedPluginConfig,
  parsePluginConfig,
  providedServices,
  toConfigIssues,
  validatePluginList,
  validatePluginModule,
} from "./validate"

/** cordis `FiberState.ACTIVE` (a `const enum`, not importable under isolatedModules). */
const FIBER_ACTIVE = 2

/**
 * The cordis plugin object for a validated module. Carries no `Config`:
 * config is validated once by the host (path-qualified errors, async
 * schemas) and the parsed value is handed to `apply` as-is.
 */
export function toCordisPlugin(
  module: PluginModule,
  onApplyResult?: (result: unknown) => unknown,
): Plugin.Object<unknown> {
  return {
    name: module.name,
    inject:
      isInjectList(module.inject) ? [...module.inject] : { ...module.inject },
    ...(module.provides === undefined ? {} : { provide: [...module.provides] }),
    apply: async (ctx: Context, config: unknown) => {
      const result = await module.apply(ctx, config)
      if (onApplyResult !== undefined) return await onApplyResult(result)
    },
  }
}

/**
 * Mount `plugin` under `root` and attach its runtime slot. The returned fiber
 * may legally be PENDING while Cordis waits for declared services; callers
 * choose separately whether and when to await a lifecycle settlement.
 */
// eslint-disable-next-line max-params -- exported host entry point; its positional signature is part of the runtime API
export async function mountPlugin(
  root: Context,
  runtime: PluginRuntime,
  id: string,
  plugin: Plugin.Object<unknown>,
  config: unknown,
): Promise<Fiber> {
  const handle = root.plugin(plugin, config)
  const fiber = handle.ctx.fiber
  try {
    runtime.attach(id, handle)
    return fiber
  } catch (error) {
    try {
      await fiber.dispose()
    } catch {
      // Preserve the attach failure; cordis reports disposer failures itself.
    }
    throw error
  }
}

/** Wait for the fiber's current Cordis lifecycle work to settle. */
export async function settlePlugin(fiber: Fiber): Promise<Fiber> {
  return await fiber.await()
}

/**
 * Compatibility helper for testbeds that require immediate activation. The
 * mutable host uses `mountPlugin` directly so PENDING fibers remain mounted.
 */
// eslint-disable-next-line max-params -- exported host entry point; its positional signature is part of the runtime API
export async function activatePlugin(
  root: Context,
  runtime: PluginRuntime,
  id: string,
  plugin: Plugin.Object<unknown>,
  config: unknown,
): Promise<Fiber> {
  const fiber = await mountPlugin(root, runtime, id, plugin, config)
  try {
    const settled = await settlePlugin(fiber)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- FiberState is a const enum and cannot be imported under isolatedModules (see FIBER_ACTIVE)
    if (settled.state !== FIBER_ACTIVE) {
      throw new Error(
        `Plugin "${id}" did not become active (missing services?).`,
      )
    }
    return settled
  } catch (error) {
    await deactivatePlugin(runtime, id, fiber)
    throw error
  }
}

/** Dispose a plugin fiber and release its runtime slot. Never throws. */
export async function deactivatePlugin(
  runtime: PluginRuntime,
  id: string,
  fiber: Fiber | undefined,
): Promise<void> {
  try {
    await fiber?.dispose()
  } catch {
    // cordis already reports disposer failures through its logger.
  } finally {
    runtime.release(id)
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return typeof error === "string" ? error : String(error)
}

function isToolResult(value: unknown): value is ToolResult {
  return (
    value !== null
    && typeof value === "object"
    && Array.isArray((value as { content?: unknown }).content)
  )
}

/** Run a tool; a throw or malformed result becomes an MCP `isError` result. */
export async function invokeTool(
  tool: Readonly<ToolDefinition>,
  input: Record<string, unknown>,
  call: ToolCallContext,
): Promise<ToolResult> {
  try {
    const result: unknown = await tool.execute(input, call)
    if (!isToolResult(result)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool "${tool.name}" returned an invalid result.`,
          },
        ],
      }
    }
    return result
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: errorMessage(error) }],
    }
  }
}
