import type { Fiber, Plugin } from "@deepseek-ai/cordis"
import type {
  PluginGateway,
  PluginGatewayEvent,
  PluginLifecycle,
  PluginSettings,
  PluginSettingsEntry,
  PluginSnapshot,
  PluginToolsSource,
  PluginToolListing,
  PluginToolView,
  ToolCallContext,
  ToolDefinitionPublic,
  ToolPermission,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { Context } from "@deepseek-ai/cordis"
import {
  PLUGIN_SETTINGS_FILE,
  type HostServices,
  type PluginManifest,
  type PluginModule,
} from "@stuffbucket/maximal-plugin-sdk"
import {
  blockedToolText,
  PluginGatewayError,
  unapprovedToolText,
} from "@stuffbucket/maximal-plugin-sdk/gateway"
import {
  activatePlugin,
  applyPermissionChanges,
  createFileStorage,
  deactivatePlugin,
  errorMessage,
  installPluginServices,
  invokeTool,
  loadPluginSettings,
  migrateSettingsDocument,
  newSettingsDocument,
  nonJsonPath,
  normalizeManifest,
  parsePluginConfig,
  parseSettingsDocument,
  permissionChangesError,
  PluginRuntime,
  resolveToolPermission,
  serializeSettingsDocument,
  setToolCatalog,
  storedPermissions,
  toCordisPlugin,
  toConfigIssues,
  toolView,
  toPublicTool,
  validatePluginList,
  writePluginSettings,
  type LoadedPluginSettings,
  type PluginSettingsDocument,
  type PluginServiceFactory,
  type PluginStorageBackend,
} from "@stuffbucket/maximal-plugin-sdk/runtime"
import path from "node:path"

/** The size the SDK refuses to read a settings file above (1 MiB). */
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024

export interface PluginHostOptions {
  /** The static first-party plugin set (module namespaces). */
  plugins: ReadonlyArray<PluginModule>
  services: {
    host: HostServices
    /**
     * `<app dir>/plugins`; each plugin gets `<storageRoot>/<id>/` for
     * `ctx.storage` and the host-owned `<storageRoot>/<id>/settings.json`.
     */
    storageRoot: string
    /** Override the filesystem storage backend (tests). */
    storage?: PluginStorageBackend
    /**
     * App-provided services beyond `tools`, `surface`, `storage` and `host`.
     * Each factory builds a cordis `Service` on the root; its name becomes an
     * allowed entry in plugins' `inject`.
     */
    extra?: ReadonlyArray<PluginServiceFactory>
  }
}

interface PluginRecord {
  readonly id: string
  readonly module: PluginModule
  readonly manifest: Readonly<PluginManifest>
  readonly plugin: Plugin.Object<unknown>
  enabled: boolean
  lifecycle: PluginLifecycle
  error: string | undefined
  /** `#desiredKey` of the current activation attempt. */
  appliedKey: string | undefined
  fiber: Fiber | undefined
  lifetime: AbortController | undefined
  /** Last load of the settings file; `undefined` until the first load finished. */
  settings: LoadedPluginSettings | undefined
  /** Serialises every read and write of this plugin's settings file. */
  io: Promise<void>
  /** A catalog refresh is queued on `io` and has not started yet. */
  catalogQueued: boolean
}

function refused(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] }
}

/**
 * What `@stuffbucket/maximal-plugin-host/testing` observes of a host: its
 * root cordis context (fiber `internal/status` events, root effects), the
 * shared runtime (contributions per plugin) and each plugin's current fiber.
 * Not exported from the package root; production code never reads it.
 */
export interface PluginHostInternals {
  readonly root: Context
  readonly runtime: PluginRuntime
  fiber(pluginId: string): Fiber | undefined
  /** Resolves once queued reconciles and settings reads/writes have run. */
  idle(): Promise<void>
}

const hostInternals = new WeakMap<PluginGateway, PluginHostInternals>()

/** The internals of a gateway made by `createPluginHost` (testing only). */
export function pluginHostInternals(
  gateway: PluginGateway,
): PluginHostInternals | undefined {
  return hostInternals.get(gateway)
}

/** A settings-file edit: mutate `document`; `undefined` = nothing to write. */
type SettingsChange = (
  document: PluginSettingsDocument,
) =>
  | Partial<Pick<Extract<LoadedPluginSettings, { ok: true }>, "parsed">>
  | undefined
  | Promise<
      | Partial<Pick<Extract<LoadedPluginSettings, { ok: true }>, "parsed">>
      | undefined
    >

const noop = () => {}

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

/** A JSON-safe copy of a parsed config (schemas may produce class instances). */
function jsonCopy(value: unknown): unknown {
  try {
    const text = JSON.stringify(value) as string | undefined
    return text === undefined ? undefined : (JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
}

function configView(settings: LoadedPluginSettings | undefined): unknown {
  if (!settings?.ok) return undefined
  if (settings.parsed.ok) {
    const copy = jsonCopy(settings.parsed.value)
    if (copy !== undefined) return copy
  }
  return structuredClone(settings.document.config)
}

/** What a reconcile compares to decide whether the plugin must (re)start. */
function settingsKey(settings: LoadedPluginSettings | undefined): string {
  if (!settings) return "!unloaded"
  if (!settings.ok) return `!${settings.error}`
  if (!settings.parsed.ok) return `!${settings.parsed.message}`
  return stableKey(settings.document.config ?? {})
}

function settingsFailure(
  settings: LoadedPluginSettings | undefined,
): string | undefined {
  if (!settings) return "Plugin settings have not been loaded."
  if (!settings.ok) return settings.error
  return settings.parsed.ok ? undefined : settings.parsed.message
}

function permissionsKey(settings: LoadedPluginSettings | undefined): string {
  return stableKey(settings?.ok ? storedPermissions(settings.document) : {})
}

class PluginHost implements PluginGateway {
  readonly #root = new Context()
  readonly #runtime: PluginRuntime
  readonly #records = new Map<string, PluginRecord>()
  readonly #listeners = new Set<(event: PluginGatewayEvent) => void>()
  readonly #host: HostServices
  readonly #storage: PluginStorageBackend
  #queue: Promise<void> = Promise.resolve()
  #disposed = false
  #disposing: Promise<void> | undefined

  constructor(options: PluginHostOptions) {
    this.#host = options.services.host
    this.#runtime = new PluginRuntime({
      onChange: (event) => {
        if (event.type === "tools") this.#scheduleCatalog(event.pluginId)
        this.#emit(event)
      },
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
    this.#storage =
      options.services.storage
      ?? createFileStorage(options.services.storageRoot)
    const available = installPluginServices(this.#root, this.#runtime, {
      host: options.services.host,
      storage: this.#storage,
      extra: options.services.extra,
    })
    const plugins = validatePluginList(options.plugins, available)
    for (const module of plugins) {
      this.#records.set(module.name, {
        id: module.name,
        module,
        manifest: normalizeManifest(module.name, module.manifest),
        plugin: toCordisPlugin(module),
        enabled: false,
        lifecycle: "disabled",
        error: undefined,
        appliedKey: undefined,
        fiber: undefined,
        lifetime: undefined,
        settings: undefined,
        io: Promise.resolve(),
        catalogQueued: false,
      })
    }
    hostInternals.set(this, {
      root: this.#root,
      runtime: this.#runtime,
      fiber: (id) => this.#records.get(id)?.fiber,
      idle: () => this.#idle(),
    })
    // Read every settings file up front so snapshots and cached tool views
    // are available before the first reconcile; later calls queue behind it.
    this.#queue = Promise.all(
      [...this.#records.values()].map((record) => this.#load(record)),
    ).then(noop, noop)
  }

  reconcile(settings: PluginSettings | undefined): Promise<void> {
    return this.#enqueue(() => this.#reconcileNow(settings))
  }

  list(): Array<PluginSnapshot> {
    return [...this.#records.values()].map((record) => this.#snapshot(record))
  }

  get(id: string): PluginSnapshot | undefined {
    const record = this.#records.get(id)
    return record ? this.#snapshot(record) : undefined
  }

  listTools(pluginId: string): Array<PluginToolListing> {
    const record = this.#record(pluginId)
    if (record.lifecycle !== "active") return []
    const explicit = storedPermissions(this.#document(record))
    return this.#runtime.tools(pluginId).map((tool) => ({
      ...toPublicTool(tool),
      permission: resolveToolPermission(record.module, tool, explicit)
        .permission,
    }))
  }

  toolViews(pluginId: string): Array<PluginToolView> {
    const record = this.#record(pluginId)
    const explicit = storedPermissions(this.#document(record))
    const tools: ReadonlyArray<ToolDefinitionPublic> =
      this.#toolsSource(record) === "live" ?
        this.#runtime.tools(pluginId)
      : (this.#document(record)?.tools?.catalog?.tools ?? [])
    return tools.map((tool) => toolView(record.module, tool, explicit))
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
    const explicit = storedPermissions(this.#document(record))
    const { permission } = resolveToolPermission(record.module, tool, explicit)
    const displayName = record.module.manifest.displayName
    if (permission === "block")
      return refused(blockedToolText(displayName, name))
    if (permission === "ask" && call.approved !== true)
      return refused(unapprovedToolText(displayName, name))
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

  async updateConfig(pluginId: string, config: unknown): Promise<void> {
    const record = this.#record(pluginId)
    await this.#enqueue(() => this.#updateConfigNow(record, config))
  }

  async setToolPermissions(
    pluginId: string,
    changes: Record<string, ToolPermission | null>,
  ): Promise<void> {
    const record = this.#record(pluginId)
    const invalid = permissionChangesError(changes)
    if (invalid !== undefined)
      throw new PluginGatewayError("invalid-permissions", pluginId, invalid)
    const changed = await this.#mutate(record, (document) =>
      applyPermissionChanges(document, changes) ? {} : undefined,
    )
    if (!changed) return
    this.#emit({ type: "tools", pluginId })
    this.#emit({ type: "settings", pluginId })
  }

  async importLegacyConfig(
    pluginId: string,
    config: unknown,
  ): Promise<boolean> {
    const record = this.#record(pluginId)
    return await this.#enqueue(async () => {
      const written = await this.#importLegacyNow(record, config)
      if (written) {
        this.#emit({ type: "settings", pluginId })
        await this.#converge(record)
      }
      return written
    })
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
        await Promise.all([...this.#records.values()].map((r) => r.io))
      } finally {
        this.#listeners.clear()
      }
    })()
    return this.#disposing
  }

  async #idle(): Promise<void> {
    for (;;) {
      const queue = this.#queue
      const io = [...this.#records.values()].map((record) => record.io)
      await queue
      await Promise.all(io)
      if (
        queue === this.#queue
        && [...this.#records.values()].every((record, i) => record.io === io[i])
      )
        return
    }
  }

  // Lifecycle changes are serialized through `#queue` and settings-file
  // reads/writes through each record's `io` chain, so every field has a
  // single writer: the read-then-write across an await that the rule flags
  // cannot interleave.
  /* eslint-disable require-atomic-updates -- see above */
  /** Run `task` after every queued reconcile/config change. */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task)
    this.#queue = run.then(noop, noop)
    return run
  }

  /** Run `step` after every queued read/write of the record's settings file. */
  #io<T>(record: PluginRecord, step: () => Promise<T>): Promise<T> {
    const run = record.io.then(step)
    record.io = run.then(noop, noop)
    return run
  }

  #document(record: PluginRecord): PluginSettingsDocument | undefined {
    return record.settings?.ok ? record.settings.document : undefined
  }

  /** Throws `settings-unreadable` unless the last load succeeded (never overwrite such a file). */
  #writable(record: PluginRecord): void {
    const { settings } = record
    if (!settings?.ok) {
      throw new PluginGatewayError(
        "settings-unreadable",
        record.id,
        settingsFailure(settings) ?? "Plugin settings are unavailable.",
      )
    }
  }

  /** (Re)read the settings file; emits `settings` (and `tools`) when it changed. */
  #load(record: PluginRecord): Promise<void> {
    return this.#io(record, async () => {
      const previous = record.settings
      const next = await loadPluginSettings(
        this.#storage,
        record.module,
        record.manifest,
      )
      record.settings = next
      if (next.ok && next.writeError !== undefined) {
        this.#host.logger.warn(
          `[plugins] ${record.id}: could not write migrated settings: ${next.writeError}`,
        )
      }
      if (previous === undefined) return
      if (permissionsKey(previous) !== permissionsKey(next))
        this.#emit({ type: "tools", pluginId: record.id })
      if (
        settingsKey(previous) !== settingsKey(next)
        || permissionsKey(previous) !== permissionsKey(next)
      )
        this.#emit({ type: "settings", pluginId: record.id })
    })
  }

  /** Cache the live tool set once the current burst of registrations settles. */
  #scheduleCatalog(pluginId: string): void {
    const record = this.#records.get(pluginId)
    if (!record || record.catalogQueued) return
    record.catalogQueued = true
    this.#io(record, async () => {
      record.catalogQueued = false
      const tools = this.#runtime.tools(pluginId)
      if (!record.settings?.ok || tools.length === 0) return
      await this.#mutateNow(record, (document) => {
        setToolCatalog(document, tools)
        // A settings file over the read limit is refused at the next start
        // (failing the plugin), so a catalog that would push it over is
        // dropped; the cache is a convenience, the file must stay loadable.
        const bytes = Buffer.byteLength(serializeSettingsDocument(document))
        if (bytes > MAX_SETTINGS_FILE_BYTES) {
          document.tools = { ...document.tools }
          delete document.tools.catalog
          this.#host.logger.warn(
            `[plugins] ${pluginId}: the tool catalog (${tools.length} tools) would make the settings file ${bytes} bytes, over the ${MAX_SETTINGS_FILE_BYTES}-byte limit; not caching it`,
          )
        }
        return {}
      })
    }).catch((error: unknown) => {
      this.#host.logger.warn(
        `[plugins] ${pluginId}: could not cache the tool catalog: ${errorMessage(error)}`,
      )
    })
  }

  #toolsSource(record: PluginRecord): PluginToolsSource {
    if (
      record.lifecycle === "active"
      && this.#runtime.tools(record.id).length > 0
    )
      return "live"
    const cached = this.#document(record)?.tools?.catalog
    return cached && cached.tools.length > 0 ? "cache" : "none"
  }

  async #updateConfigNow(record: PluginRecord, config: unknown): Promise<void> {
    const { id } = record
    const badPath = config === undefined ? undefined : nonJsonPath(config)
    if (badPath !== undefined) {
      const path = badPath === "(root)" ? "" : badPath
      throw new PluginGatewayError(
        "invalid-config",
        id,
        `${id}${path ? `.${path}` : ""}: not a JSON value`,
        { issues: [{ path, message: "not a JSON value" }] },
      )
    }
    const value: unknown = jsonCopy(config)
    const parsed = await parsePluginConfig(record.module, value)
    if (!parsed.ok) {
      throw new PluginGatewayError("invalid-config", id, parsed.message, {
        issues: toConfigIssues(parsed.issues),
      })
    }
    await this.#mutate(record, (document) => {
      if (value === undefined) delete document.config
      else document.config = value
      return { parsed }
    })
    this.#emit({ type: "settings", pluginId: id })
    await this.#converge(record)
  }

  /** Migrate a legacy (settings version 1) config to the current shape. */
  async #migrateLegacy(
    record: PluginRecord,
    config: unknown,
  ): Promise<unknown> {
    if (nonJsonPath(config) !== undefined) {
      throw new PluginGatewayError(
        "invalid-config",
        record.id,
        `Legacy config for "${record.id}" is not a JSON value.`,
      )
    }
    try {
      const { document } = await migrateSettingsDocument(
        record.module,
        record.manifest,
        {
          ...newSettingsDocument({ id: record.id, settingsVersion: 1 }),
          config: jsonCopy(config),
        },
      )
      return document.config
    } catch (error) {
      throw new PluginGatewayError(
        "invalid-config",
        record.id,
        errorMessage(error),
        { cause: error },
      )
    }
  }

  #importLegacyNow(record: PluginRecord, config: unknown): Promise<boolean> {
    return this.#mutate(record, async (document) => {
      if (document.config !== undefined || config === undefined) return
      const migrated = await this.#migrateLegacy(record, config)
      if (migrated === undefined) return
      document.config = migrated
      return { parsed: await parsePluginConfig(record.module, migrated) }
    })
  }

  /**
   * Read-modify-write the settings file on the record's `io` chain. `change`
   * mutates a fresh copy read from disk (so edits made there since the last
   * load survive) and returns `undefined` for "nothing to write", or what
   * else to update in memory. Resolves whether the file was written.
   */
  #mutate(record: PluginRecord, change: SettingsChange): Promise<boolean> {
    return this.#io(record, () => this.#mutateNow(record, change))
  }

  /** `#mutate` body; only call from a step already on the record's `io` chain. */
  async #mutateNow(
    record: PluginRecord,
    change: SettingsChange,
  ): Promise<boolean> {
    this.#writable(record)
    const document = await this.#reread(record)
    const update = await change(document)
    if (update === undefined) return false
    await writePluginSettings(this.#storage, document)
    const current = record.settings
    if (!current?.ok) return true
    // The re-read may carry a config edited on disk since the last load.
    const parsed =
      update.parsed
      ?? (stableKey(document.config) === stableKey(current.document.config) ?
        current.parsed
      : await parsePluginConfig(record.module, document.config))
    record.settings = { ...current, document, exists: true, parsed }
    return true
  }

  /** The settings file as it is on disk now; throws `settings-unreadable`. */
  async #reread(record: PluginRecord): Promise<PluginSettingsDocument> {
    const unreadable = (detail: string) =>
      new PluginGatewayError("settings-unreadable", record.id, detail)
    let text: string | undefined
    try {
      text = await this.#storage.readText(record.id, PLUGIN_SETTINGS_FILE)
    } catch (error) {
      throw unreadable(
        `Plugin settings file for "${record.id}" could not be read (${errorMessage(error)}).`,
      )
    }
    if (text === undefined) return newSettingsDocument(record.manifest)
    let document: PluginSettingsDocument
    try {
      document = parseSettingsDocument(
        record.id,
        text,
        path.join(this.#storage.dir(record.id), PLUGIN_SETTINGS_FILE),
      )
    } catch (error) {
      throw unreadable(errorMessage(error))
    }
    if (document.version !== record.manifest.settingsVersion) {
      throw unreadable(
        `Plugin settings file for "${record.id}" changed on disk to version ${document.version}; reload plugins before changing settings.`,
      )
    }
    return document
  }

  async #reconcileNow(settings: PluginSettings | undefined): Promise<void> {
    if (this.#disposed) return
    await Promise.all(
      [...this.#records.values()].map(async (record) => {
        const entry = settingsEntry(settings, record.id)
        const enabled = entry?.enabled === true
        const enabledChanged = record.enabled !== enabled
        record.enabled = enabled
        await this.#load(record)
        await this.#converge(record, enabledChanged)
      }),
    )
  }

  /** Start/stop/reload the plugin to match `enabled` and its settings. */
  async #converge(record: PluginRecord, enabledChanged = false): Promise<void> {
    if (this.#disposed) return
    if (!record.enabled) {
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
    const key = settingsKey(record.settings)
    if (
      (record.lifecycle === "active" || record.lifecycle === "failed")
      && record.appliedKey === key
    )
      return
    await this.#stop(record)
    await this.#start(record, key)
  }

  async #start(record: PluginRecord, key: string): Promise<void> {
    record.appliedKey = key
    record.error = undefined
    const failure = settingsFailure(record.settings)
    if (
      failure !== undefined
      || !record.settings?.ok
      || !record.settings.parsed.ok
    ) {
      record.error = failure
      this.#host.logger.warn(`[plugins] ${record.id}: ${failure}`)
      this.#setLifecycle(record, "failed", true)
      return
    }
    const config = record.settings.parsed.value
    const lifetime = new AbortController()
    record.lifetime = lifetime
    this.#setLifecycle(record, "starting")
    try {
      record.fiber = await activatePlugin(
        this.#root,
        this.#runtime,
        record.id,
        record.plugin,
        config,
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
    const { manifest } = record
    const active =
      record.lifecycle === "active" || record.lifecycle === "starting"
    const status = active ? this.#runtime.status(record.id) : undefined
    const catalog = this.#document(record)?.tools?.catalog
    return {
      id: record.id,
      kind: manifest.kind,
      displayName: manifest.displayName,
      description: manifest.description,
      ...(manifest.homepage === undefined ?
        {}
      : { homepage: manifest.homepage }),
      manifest: structuredClone(manifest),
      settingsVersion: manifest.settingsVersion,
      ...(manifest.configSchema === undefined ?
        {}
      : { configSchema: structuredClone(manifest.configSchema) }),
      config: configView(record.settings),
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
      toolsSource: this.#toolsSource(record),
      ...(catalog === undefined ? {} : { catalogUpdatedAt: catalog.updatedAt }),
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
 * manifest, id, duplicates, injected services) up front and throws
 * `PluginContractError` on a bad plugin list. All plugins start disabled;
 * call `reconcile(settings)` to start them. Each plugin's settings file is
 * read in the background right away (queued ahead of the first reconcile).
 */
export function createPluginHost(options: PluginHostOptions): PluginGateway {
  return new PluginHost(options)
}
