import type { Fiber, Plugin } from "@deepseek-ai/cordis"
import type {
  PluginGateway,
  PluginGatewayEvent,
  PluginLifecycle,
  PluginSettings,
  PluginSettingsEntry,
  PluginSnapshot,
  ToolCallContext,
  ToolDefinitionPublic,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { Context } from "@deepseek-ai/cordis"
import {
  PLUGIN_SERVICE_NAMES,
  type HostServices,
  type PluginModule,
} from "@stuffbucket/maximal-plugin-sdk"
import { PluginGatewayError } from "@stuffbucket/maximal-plugin-sdk/gateway"
import {
  activatePlugin,
  deactivatePlugin,
  errorMessage,
  installPluginServices,
  invokeTool,
  parsePluginConfig,
  PluginRuntime,
  toCordisPlugin,
  validatePluginList,
  type PluginStorageBackend,
} from "@stuffbucket/maximal-plugin-sdk/runtime"

import { createFileStorage } from "./storage"

export interface PluginHostOptions {
  /** The static first-party plugin set (module namespaces). */
  plugins: ReadonlyArray<PluginModule>
  services: {
    host: HostServices
    /** `<app dir>/plugins`; each plugin gets `<storageRoot>/<id>/`. */
    storageRoot: string
    /** Override the filesystem storage backend (tests). */
    storage?: PluginStorageBackend
  }
}

interface PluginRecord {
  readonly id: string
  readonly module: PluginModule
  readonly plugin: Plugin.Object<unknown>
  enabled: boolean
  lifecycle: PluginLifecycle
  error: string | undefined
  /** Settings key (stable JSON of the raw config) of the current activation attempt. */
  appliedKey: string | undefined
  fiber: Fiber | undefined
  lifetime: AbortController | undefined
}

/** JSON with sorted object keys, so equal configs compare equal. */
function stableKey(value: unknown): string {
  return (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify returns undefined for undefined/functions/symbols despite its `string` type
    JSON.stringify(value, (_key, item: unknown) => {
      if (item === null || typeof item !== "object" || Array.isArray(item))
        return item
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(item).sort())
        sorted[key] = (item as Record<string, unknown>)[key]
      return sorted
    }) ?? "undefined"
  )
}

function settingsEntry(
  settings: PluginSettings | undefined,
  id: string,
): PluginSettingsEntry | undefined {
  if (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- settings come from a user-edited config file; guard against a non-object at runtime
    settings === null
    || typeof settings !== "object"
    || !Object.hasOwn(settings, id)
  )
    return undefined
  const entry: unknown = settings[id]
  return entry !== null && typeof entry === "object" ? entry : undefined
}

const ERROR_LOG_TYPES = new Set(["error", "warn"])

class PluginHost implements PluginGateway {
  readonly #root = new Context()
  readonly #runtime: PluginRuntime
  readonly #records = new Map<string, PluginRecord>()
  readonly #listeners = new Set<(event: PluginGatewayEvent) => void>()
  readonly #host: HostServices
  #queue: Promise<void> = Promise.resolve()
  #disposed = false
  #disposing: Promise<void> | undefined

  constructor(options: PluginHostOptions) {
    const plugins = validatePluginList(options.plugins, PLUGIN_SERVICE_NAMES)
    this.#host = options.services.host
    this.#runtime = new PluginRuntime({
      onChange: (event) => this.#emit(event),
    })
    // cordis reports apply/disposer failures through its own logger; surface them.
    this.#root.logger.exporter({
      export: (message) => {
        if (!ERROR_LOG_TYPES.has(message.type)) return
        const text = message.args
          .map((arg: unknown) => errorMessage(arg))
          .join(" ")
        this.#host.logger[message.type === "error" ? "error" : "warn"](
          `[plugins] ${message.name}: ${text}`,
        )
      },
    })
    installPluginServices(this.#root, this.#runtime, {
      host: options.services.host,
      storage:
        options.services.storage
        ?? createFileStorage(options.services.storageRoot),
    })
    for (const module of plugins) {
      this.#records.set(module.name, {
        id: module.name,
        module,
        plugin: toCordisPlugin(module),
        enabled: false,
        lifecycle: "disabled",
        error: undefined,
        appliedKey: undefined,
        fiber: undefined,
        lifetime: undefined,
      })
    }
  }

  reconcile(settings: PluginSettings | undefined): Promise<void> {
    const run = this.#queue.then(() => this.#reconcileNow(settings))
    this.#queue = run.catch(() => {})
    return run
  }

  list(): Array<PluginSnapshot> {
    return [...this.#records.values()].map((record) => this.#snapshot(record))
  }

  get(id: string): PluginSnapshot | undefined {
    const record = this.#records.get(id)
    return record ? this.#snapshot(record) : undefined
  }

  listTools(pluginId: string): Array<ToolDefinitionPublic> {
    const record = this.#record(pluginId)
    if (record.lifecycle !== "active") return []
    return this.#runtime.tools(pluginId).map((tool) => ({
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: tool.description,
      inputSchema: structuredClone(tool.inputSchema),
      ...(tool.outputSchema === undefined ?
        {}
      : { outputSchema: structuredClone(tool.outputSchema) }),
      ...(tool.annotations === undefined ?
        {}
      : { annotations: { ...tool.annotations } }),
    }))
  }

  // eslint-disable-next-line max-params -- implements the PluginGateway.callTool contract
  async callTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    const record = this.#activeRecord(pluginId)
    const tool = this.#runtime.tool(pluginId, name)
    if (!tool)
      throw new PluginGatewayError(
        "unknown-tool",
        pluginId,
        `Plugin "${pluginId}" has no tool "${name}".`,
      )
    const lifetime = record.lifetime?.signal
    const signal =
      lifetime ? AbortSignal.any([call.signal, lifetime]) : call.signal
    return await invokeTool(tool, input, { ...call, signal })
  }

  async runAction(
    pluginId: string,
    actionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const record = this.#activeRecord(pluginId)
    const handler = this.#runtime.action(pluginId, actionId)
    if (!handler) {
      throw new PluginGatewayError(
        "unknown-action",
        pluginId,
        `Plugin "${pluginId}" has no action "${actionId}".`,
      )
    }
    const signals = [signal, record.lifetime?.signal].filter(
      (item): item is AbortSignal => item !== undefined,
    )
    await handler(
      signals.length > 0 ?
        AbortSignal.any(signals)
      : new AbortController().signal,
    )
  }

  subscribe(listener: (event: PluginGatewayEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  dispose(): Promise<void> {
    this.#disposing ??= (async () => {
      this.#disposed = true
      await this.#queue
      await Promise.all(
        [...this.#records.values()].map(async (record) => {
          await this.#stop(record)
          // `dispose` waits for the reconcile queue to drain and sets
          // `#disposed`, so nothing else writes this record concurrently.
          /* eslint-disable require-atomic-updates -- see above */
          record.enabled = false
          record.error = undefined
          record.appliedKey = undefined
          /* eslint-enable require-atomic-updates */
          this.#setLifecycle(record, "disabled")
        }),
      )
      try {
        await this.#root.fiber.dispose()
      } finally {
        this.#listeners.clear()
      }
    })()
    return this.#disposing
  }

  async #reconcileNow(settings: PluginSettings | undefined): Promise<void> {
    if (this.#disposed) return
    await Promise.all(
      [...this.#records.values()].map((record) =>
        this.#reconcileOne(record, settingsEntry(settings, record.id)),
      ),
    )
  }

  // Reconciles are serialized through `#queue`, so each record has a single
  // writer: the read-then-write across an await the rule flags cannot interleave.
  /* eslint-disable require-atomic-updates -- see above */
  async #reconcileOne(
    record: PluginRecord,
    entry: PluginSettingsEntry | undefined,
  ): Promise<void> {
    const enabled = entry?.enabled === true
    const enabledChanged = record.enabled !== enabled
    record.enabled = enabled
    if (!enabled) {
      if (record.lifecycle === "disabled") {
        if (enabledChanged)
          this.#emit({ type: "lifecycle", pluginId: record.id })
        return
      }
      await this.#stop(record)
      record.error = undefined
      record.appliedKey = undefined
      this.#setLifecycle(record, "disabled")
      return
    }
    const raw = entry.config ?? {}
    const key = stableKey(raw)
    if (
      (record.lifecycle === "active" || record.lifecycle === "failed")
      && record.appliedKey === key
    )
      return
    await this.#stop(record)
    await this.#start(record, raw, key)
  }

  async #start(record: PluginRecord, raw: unknown, key: string): Promise<void> {
    record.appliedKey = key
    record.error = undefined
    const parsed = await parsePluginConfig(record.module, raw)
    if (!parsed.ok) {
      record.error = parsed.message
      this.#host.logger.warn(
        `[plugins] ${record.id}: invalid config\n${parsed.message}`,
      )
      this.#setLifecycle(record, "failed", true)
      return
    }
    const lifetime = new AbortController()
    record.lifetime = lifetime
    this.#setLifecycle(record, "starting")
    try {
      record.fiber = await activatePlugin(
        this.#root,
        this.#runtime,
        record.id,
        record.plugin,
        parsed.value,
      )
      this.#setLifecycle(record, "active")
    } catch (error) {
      lifetime.abort(error)
      record.lifetime = undefined
      // cordis already logged the apply error through the exporter above.
      record.error = errorMessage(error)
      this.#setLifecycle(record, "failed")
    }
  }

  /** Dispose the plugin's fiber; its tools, actions and status vanish. */
  async #stop(record: PluginRecord): Promise<void> {
    const { fiber, lifetime } = record
    record.fiber = undefined
    record.lifetime = undefined
    lifetime?.abort(new Error(`Plugin "${record.id}" stopped.`))
    if (fiber) await deactivatePlugin(this.#runtime, record.id, fiber)
  }

  /* eslint-enable require-atomic-updates */

  #setLifecycle(
    record: PluginRecord,
    lifecycle: PluginLifecycle,
    force = false,
  ): void {
    if (record.lifecycle === lifecycle && !force) return
    record.lifecycle = lifecycle
    this.#emit({ type: "lifecycle", pluginId: record.id })
  }

  #record(pluginId: string): PluginRecord {
    const record = this.#records.get(pluginId)
    if (!record)
      throw new PluginGatewayError(
        "unknown-plugin",
        pluginId,
        `Unknown plugin "${pluginId}".`,
      )
    return record
  }

  #activeRecord(pluginId: string): PluginRecord {
    const record = this.#record(pluginId)
    if (record.lifecycle !== "active") {
      throw new PluginGatewayError(
        "plugin-inactive",
        pluginId,
        `Plugin "${pluginId}" is ${record.lifecycle}.`,
      )
    }
    return record
  }

  #snapshot(record: PluginRecord): PluginSnapshot {
    const { meta } = record.module
    const active =
      record.lifecycle === "active" || record.lifecycle === "starting"
    const status = active ? this.#runtime.status(record.id) : undefined
    return {
      id: record.id,
      displayName: meta.displayName,
      description: meta.description,
      ...(meta.homepage === undefined ? {} : { homepage: meta.homepage }),
      enabled: record.enabled,
      lifecycle: record.lifecycle,
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(status === undefined ? {} : { status: structuredClone(status) }),
      tools:
        record.lifecycle !== "active" ?
          []
        : this.#runtime.tools(record.id).map((tool) => ({
            name: tool.name,
            ...(tool.title === undefined ? {} : { title: tool.title }),
            description: tool.description,
            ...(tool.annotations === undefined ?
              {}
            : { annotations: { ...tool.annotations } }),
          })),
    }
  }

  #emit(event: PluginGatewayEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch (error) {
        this.#host.logger.warn(
          `[plugins] event listener failed: ${errorMessage(error)}`,
        )
      }
    }
  }
}

/**
 * Create the cordis-backed plugin gateway. Validates every module (shape,
 * id, duplicates, injected services) up front and throws
 * `PluginContractError` on a bad plugin list. All plugins start disabled;
 * call `reconcile(settings)` to start them.
 */
export function createPluginHost(options: PluginHostOptions): PluginGateway {
  return new PluginHost(options)
}
