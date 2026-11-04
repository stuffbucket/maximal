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
  installPluginServices,
  type PluginServiceOptions,
  type PluginStorageBackend,
} from "./services"
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
  normalizeStatus,
  normalizeToolDefinition,
  type ParsedPluginConfig,
  parsePluginConfig,
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
export function toCordisPlugin(module: PluginModule): Plugin.Object<unknown> {
  return {
    name: module.name,
    inject:
      isInjectList(module.inject) ? [...module.inject] : { ...module.inject },
    apply: (ctx: Context, config: unknown) => module.apply(ctx, config),
  }
}

/**
 * Start `plugin` under `root` with an already-validated config, attach the
 * fiber to `runtime`, and wait for `apply`. On failure the fiber is disposed,
 * the slot released, and the error rethrown.
 */
// eslint-disable-next-line max-params -- exported host entry point; its positional signature is part of the runtime API
export async function activatePlugin(
  root: Context,
  runtime: PluginRuntime,
  id: string,
  plugin: Plugin.Object<unknown>,
  config: unknown,
): Promise<Fiber> {
  const fiber = root.plugin(plugin, config)
  runtime.attach(id, fiber)
  try {
    // `root.plugin()` returns the fiber wrapped as a thenable that settles
    // to the underlying fiber once startup finished (or throws its error).
    const settled = await fiber
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
