/**
 * Test helpers for plugin authors: run a plugin under a real cordis
 * `Context` with the same `tools` / `surface` services the host uses, an
 * in-memory `storage`, and a recording fake `host`.
 *
 * ```ts
 * const plugin = await loadPlugin(myPlugin, { greeting: "hi" })
 * try {
 *   expect(plugin.tools().map((t) => t.name)).toEqual(["hello"])
 *   expect(await plugin.callTool("hello", {})).toEqual({ content: [{ type: "text", text: "hi" }] })
 * } finally {
 *   await plugin.dispose()
 * }
 * ```
 */
import { Context, type Fiber } from "@deepseek-ai/cordis"

import type { PluginModule } from "../index"
import type {
  HostServices,
  PluginLogger,
  PluginStatus,
  ToolCallContext,
  ToolDefinition,
  ToolResult,
} from "../types"

import { PluginContractError } from "../errors"
import {
  activatePlugin,
  assertPluginDependencies,
  deactivatePlugin,
  installPluginServices,
  invokeTool,
  parsePluginConfig,
  PluginRuntime,
  toCordisPlugin,
  validatePluginModule,
  type PluginRuntimeEvent,
  type PluginStorageBackend,
} from "../runtime"
import { PLUGIN_SERVICE_NAMES } from "../types"

export type { PluginRuntimeEvent } from "../runtime"

export interface LogRecord {
  level: keyof PluginLogger
  message: string
  args: Array<unknown>
}

/** Recording `ctx.host`. */
export interface FakeHost extends HostServices {
  /** URLs passed to `openExternal`, in order. */
  readonly opened: Array<string>
  readonly logs: Array<LogRecord>
}

/** In-memory `ctx.storage` backend, inspectable per plugin id. */
export interface MemoryStorage extends PluginStorageBackend {
  /** Snapshot of a plugin's files. */
  files(pluginId: string): Record<string, string>
  /** Seed or overwrite a file directly (bypasses the plugin). */
  seed(pluginId: string, name: string, text: string): void
}

export interface TestbedOptions {
  appVersion?: string
  /** Called after the URL is recorded, e.g. to drive a loopback OAuth redirect. */
  openExternal?: (url: string) => void | Promise<void>
  /** Initial storage: `{ [pluginId]: { [name]: text } }`. */
  storage?: Record<string, Record<string, string>>
}

export interface LoadedPlugin {
  readonly id: string
  readonly fiber: Fiber
  tools(): Array<ToolDefinition>
  tool(name: string): ToolDefinition | undefined
  /**
   * Call a registered tool like the gateway does (throw → `isError`
   * result). `call.signal` defaults to a signal that aborts on dispose.
   * Throws if the tool is not registered.
   */
  callTool(
    name: string,
    input?: Record<string, unknown>,
    call?: Partial<ToolCallContext>,
  ): Promise<ToolResult>
  status(): PluginStatus | undefined
  /** Registered surface action ids. */
  actions(): Array<string>
  /** Throws if the action is not registered; rejects if the handler does. */
  runAction(id: string, signal?: AbortSignal): Promise<void>
  /** Dispose the plugin fiber; its contributions vanish. Idempotent. */
  dispose(): Promise<void>
}

export interface Testbed {
  /** The root context (services are provided here). */
  readonly ctx: Context
  readonly runtime: PluginRuntime
  readonly host: FakeHost
  readonly storage: MemoryStorage
  /** Every `tools` / `status` change, in order. */
  readonly events: Array<PluginRuntimeEvent>
  /**
   * Validate the module (shape, injected services), validate `config`
   * (`undefined` ⇒ `{}`), and start it. Rejects with a
   * `PluginContractError` (`invalid-module` / `missing-service` /
   * `invalid-config`) or with whatever `apply` threw.
   */
  load<C>(module: PluginModule<C>, config?: unknown): Promise<LoadedPlugin>
  /** Dispose every loaded plugin and the root context. Idempotent. */
  dispose(): Promise<void>
}

function createFakeHost(options: TestbedOptions): FakeHost {
  const opened: Array<string> = []
  const logs: Array<LogRecord> = []
  const record =
    (level: keyof PluginLogger) =>
    (message: string, ...args: Array<unknown>) => {
      logs.push({ level, message, args })
    }
  return {
    opened,
    logs,
    appVersion: options.appVersion ?? "0.0.0-test",
    logger: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
    async openExternal(url: string) {
      opened.push(url)
      await options.openExternal?.(url)
    },
  }
}

function createMemoryStorage(
  initial: TestbedOptions["storage"],
): MemoryStorage {
  const data = new Map<string, Map<string, string>>()
  const bucket = (pluginId: string) => {
    let files = data.get(pluginId)
    if (!files) {
      files = new Map<string, string>()
      data.set(pluginId, files)
    }
    return files
  }
  for (const [pluginId, files] of Object.entries(initial ?? {})) {
    for (const [name, text] of Object.entries(files))
      bucket(pluginId).set(name, text)
  }
  return {
    dir: (pluginId) => `/memory/plugins/${pluginId}`,
    readText: (pluginId, name) =>
      Promise.resolve(data.get(pluginId)?.get(name)),
    writeText: (pluginId, name, text) => {
      bucket(pluginId).set(name, text)
      return Promise.resolve()
    },
    delete: (pluginId, name) => {
      data.get(pluginId)?.delete(name)
      return Promise.resolve()
    },
    files: (pluginId) => Object.fromEntries(data.get(pluginId) ?? []),
    seed: (pluginId, name, text) => {
      bucket(pluginId).set(name, text)
    },
  }
}

/** A root cordis context with the plugin services installed. */
export function createTestbed(options: TestbedOptions = {}): Testbed {
  const events: Array<PluginRuntimeEvent> = []
  const runtime = new PluginRuntime({ onChange: (event) => events.push(event) })
  const ctx = new Context()
  const host = createFakeHost(options)
  const storage = createMemoryStorage(options.storage)
  installPluginServices(ctx, runtime, { host, storage })
  const loaded = new Set<LoadedPlugin>()
  let disposing: Promise<void> | undefined

  async function load<C>(
    module: PluginModule<C>,
    config?: unknown,
  ): Promise<LoadedPlugin> {
    if (disposing) throw new Error("Testbed is disposed.")
    const plugin = validatePluginModule(module)
    assertPluginDependencies(plugin, PLUGIN_SERVICE_NAMES)
    const parsed = await parsePluginConfig(plugin, config)
    if (!parsed.ok)
      throw new PluginContractError("invalid-config", parsed.message, {
        pluginId: plugin.name,
      })
    const id = plugin.name
    const lifetime = new AbortController()
    const fiber = await activatePlugin(
      ctx,
      runtime,
      id,
      toCordisPlugin(plugin),
      parsed.value,
    )
    let stopped: Promise<void> | undefined
    const handle: LoadedPlugin = {
      id,
      fiber,
      tools: () => runtime.tools(id),
      tool: (name) => runtime.tool(id, name),
      async callTool(name, input = {}, call = {}) {
        const tool = runtime.tool(id, name)
        if (!tool) throw new Error(`Plugin "${id}" has no tool "${name}".`)
        const signal =
          call.signal ?
            AbortSignal.any([call.signal, lifetime.signal])
          : lifetime.signal
        return await invokeTool(tool, input, { ...call, signal })
      },
      status: () => runtime.status(id),
      actions: () => runtime.actionIds(id),
      async runAction(actionId, signal) {
        const handler = runtime.action(id, actionId)
        if (!handler)
          throw new Error(`Plugin "${id}" has no action "${actionId}".`)
        await handler(
          signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
        )
      },
      dispose() {
        stopped ??= (async () => {
          loaded.delete(handle)
          lifetime.abort(new Error(`Plugin "${id}" stopped.`))
          await deactivatePlugin(runtime, id, fiber)
        })()
        return stopped
      },
    }
    loaded.add(handle)
    return handle
  }

  return {
    ctx,
    runtime,
    host,
    storage,
    events,
    load,
    dispose() {
      disposing ??= (async () => {
        await Promise.all([...loaded].map((plugin) => plugin.dispose()))
        await ctx.fiber.dispose()
      })()
      return disposing
    },
  }
}

/** Load one plugin into a fresh testbed; `dispose()` tears both down. */
export async function loadPlugin<C>(
  module: PluginModule<C>,
  config?: unknown,
  options?: TestbedOptions,
): Promise<LoadedPlugin & { readonly testbed: Testbed }> {
  const testbed = createTestbed(options)
  let plugin: LoadedPlugin
  try {
    plugin = await testbed.load(module, config)
  } catch (error) {
    await testbed.dispose()
    throw error
  }
  return {
    ...plugin,
    testbed,
    async dispose() {
      await plugin.dispose()
      await testbed.dispose()
    },
  }
}

/** Poll `predicate` until it holds (default 2 s timeout, 5 ms interval). */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 2000)
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline)
      throw new Error(
        options.message ?? "waitFor: condition not met before timeout",
      )
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 5))
  }
}
