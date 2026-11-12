import { Service, type Context } from "@deepseek-ai/cordis"

import type {
  HostServices,
  PluginActionHandler,
  PluginDisposer,
  PluginLogger,
  PluginNotice,
  PluginStatus,
  PluginStorage,
  PluginSurface,
  ToolDefinition,
  ToolRegistry,
} from "../types"
import type { PluginRuntime } from "./state"

import { PluginContractError } from "../errors"
import { PLUGIN_SERVICE_NAMES } from "../types"
import {
  assertActionId,
  assertHttpUrl,
  assertStorageName,
  normalizeNotice,
  normalizeStatus,
  normalizeToolDefinition,
} from "./validate"

/** Backend for `ctx.storage` (filesystem in the host, memory in tests). */
export interface PluginStorageBackend {
  dir(pluginId: string): string
  readText(pluginId: string, name: string): Promise<string | undefined>
  writeText(pluginId: string, name: string, text: string): Promise<void>
  delete(pluginId: string, name: string): Promise<void>
}

// Services are reached through cordis' tracing proxy, where `this.ctx` is the
// *calling* plugin's context. `#private` fields do not survive that proxy, so
// internals live under module-private symbols. Methods must stay prototype
// methods (not arrow properties) so `this` is the proxy.
const kRuntime = Symbol("maximal.plugin.runtime")
const kBackend = Symbol("maximal.plugin.storage")
const kHost = Symbol("maximal.plugin.host")

class ToolRegistryService extends Service implements ToolRegistry {
  declare [kRuntime]: PluginRuntime

  constructor(ctx: Context, runtime: PluginRuntime) {
    super(ctx, "tools")
    this[kRuntime] = runtime
  }

  register(definition: ToolDefinition): PluginDisposer {
    const runtime = this[kRuntime]
    const slot = runtime.slotOf(this.ctx, "tools")
    const tool = normalizeToolDefinition(slot.id, definition)
    return runtime.bind(
      slot,
      this.ctx,
      `tools.register(${tool.name})`,
      (registration) => {
        runtime.addTool(slot, tool, registration)
      },
    ).dispose
  }

  registerAll(definitions: ReadonlyArray<ToolDefinition>): PluginDisposer {
    const runtime = this[kRuntime]
    const slot = runtime.slotOf(this.ctx, "tools")
    if (!Array.isArray(definitions)) {
      throw new PluginContractError(
        "invalid-tool",
        `Plugin "${slot.id}" registerAll() needs an array.`,
        { pluginId: slot.id },
      )
    }
    const tools = definitions.map((definition) =>
      normalizeToolDefinition(slot.id, definition),
    )
    const names = new Set<string>()
    for (const tool of tools) {
      if (names.has(tool.name)) {
        throw new PluginContractError(
          "duplicate-tool",
          `Plugin "${slot.id}" registerAll() lists tool "${tool.name}" twice.`,
          {
            pluginId: slot.id,
          },
        )
      }
      names.add(tool.name)
    }
    const previousOwners = new Set(
      [...slot.tools.values()].map((entry) => entry.owner),
    )
    const { registration, dispose } = runtime.bind(
      slot,
      this.ctx,
      "tools.registerAll()",
      (owner) => {
        runtime.replaceTools(slot, tools, owner)
      },
    )
    runtime.retireRegistrations(slot, previousOwners, registration)
    return dispose
  }

  list(): Array<ToolDefinition> {
    const runtime = this[kRuntime]
    return runtime.tools(runtime.slotOf(this.ctx, "tools").id)
  }
}

class SurfaceService extends Service implements PluginSurface {
  declare [kRuntime]: PluginRuntime

  constructor(ctx: Context, runtime: PluginRuntime) {
    super(ctx, "surface")
    this[kRuntime] = runtime
  }

  setStatus(status: PluginStatus): void {
    const runtime = this[kRuntime]
    const slot = runtime.slotOf(this.ctx, "surface")
    runtime.setStatus(slot, normalizeStatus(slot.id, status))
  }

  notify(notice: PluginNotice): void {
    const runtime = this[kRuntime]
    const slot = runtime.slotOf(this.ctx, "surface")
    runtime.notice(slot, normalizeNotice(slot.id, notice))
  }

  registerAction(id: string, handler: PluginActionHandler): PluginDisposer {
    const runtime = this[kRuntime]
    const slot = runtime.slotOf(this.ctx, "surface")
    assertActionId(slot.id, id)
    if (typeof handler !== "function") {
      throw new PluginContractError(
        "invalid-action",
        `Plugin "${slot.id}" action "${id}" needs a handler.`,
        { pluginId: slot.id },
      )
    }
    return runtime.bind(
      slot,
      this.ctx,
      `surface.registerAction(${id})`,
      (registration) => {
        runtime.addAction(slot, id, handler, registration)
      },
    ).dispose
  }
}

class StorageService extends Service implements PluginStorage {
  declare [kRuntime]: PluginRuntime;
  declare [kBackend]: PluginStorageBackend

  constructor(
    ctx: Context,
    runtime: PluginRuntime,
    backend: PluginStorageBackend,
  ) {
    super(ctx, "storage")
    this[kRuntime] = runtime
    this[kBackend] = backend
  }

  get dir(): string {
    return this[kBackend].dir(this[kRuntime].slotOf(this.ctx, "storage").id)
  }

  async readText(name: string): Promise<string | undefined> {
    const id = this[kRuntime].slotOf(this.ctx, "storage").id
    assertStorageName(id, name)
    return await this[kBackend].readText(id, name)
  }

  async writeText(name: string, text: string): Promise<void> {
    const id = this[kRuntime].slotOf(this.ctx, "storage").id
    assertStorageName(id, name)
    if (typeof text !== "string") {
      throw new PluginContractError(
        "invalid-storage-name",
        `Plugin "${id}" can only store text.`,
        { pluginId: id },
      )
    }
    await this[kBackend].writeText(id, name, text)
  }

  async delete(name: string): Promise<void> {
    const id = this[kRuntime].slotOf(this.ctx, "storage").id
    assertStorageName(id, name)
    await this[kBackend].delete(id, name)
  }
}

class HostService extends Service implements HostServices {
  declare [kRuntime]: PluginRuntime;
  declare [kHost]: HostServices

  constructor(ctx: Context, runtime: PluginRuntime, host: HostServices) {
    super(ctx, "host")
    this[kRuntime] = runtime
    this[kHost] = host
  }

  get appVersion(): string {
    return this[kHost].appVersion
  }

  /** The app logger, prefixed with the calling plugin's id. */
  get logger(): PluginLogger {
    return prefixedLogger(
      this[kHost].logger,
      this[kRuntime].slotOf(this.ctx, "host").id,
    )
  }

  async openExternal(url: string): Promise<void> {
    const id = this[kRuntime].slotOf(this.ctx, "host").id
    assertHttpUrl(id, url)
    await this[kHost].openExternal(url)
  }
}

function prefixedLogger(logger: PluginLogger, pluginId: string): PluginLogger {
  const prefix = `[plugin:${pluginId}]`
  return {
    debug: (message, ...args) => logger.debug(`${prefix} ${message}`, ...args),
    info: (message, ...args) => logger.info(`${prefix} ${message}`, ...args),
    warn: (message, ...args) => logger.warn(`${prefix} ${message}`, ...args),
    error: (message, ...args) => logger.error(`${prefix} ${message}`, ...args),
  }
}

/**
 * Builds an app-provided service on the root context. The service registers
 * itself under its own name (`super(root, "name")`), and plugins reach it with
 * that name in `inject`. `runtime` identifies the calling plugin
 * (`runtime.slotOf(this.ctx, "<name>")`).
 */
export type PluginServiceFactory = (
  root: Context,
  runtime: PluginRuntime,
) => Service

export interface PluginServiceOptions {
  storage: PluginStorageBackend
  host: HostServices
  /** App-provided services, installed after the built-in ones. */
  extra?: ReadonlyArray<PluginServiceFactory>
}

/**
 * Provide `tools`, `surface`, `storage` and `host` on `root`, then the
 * `extra` services. The services live as long as the root fiber. Returns
 * every service name now available to plugins.
 */
export function installPluginServices(
  root: Context,
  runtime: PluginRuntime,
  options: PluginServiceOptions,
): Array<string> {
  new ToolRegistryService(root, runtime)
  new SurfaceService(root, runtime)
  new StorageService(root, runtime, options.storage)
  new HostService(root, runtime, options.host)
  // cordis itself refuses a name that is already registered.
  return [
    ...PLUGIN_SERVICE_NAMES,
    ...(options.extra ?? []).map((create) => create(root, runtime).name),
  ]
}
