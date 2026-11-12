/* eslint-disable max-lines -- the serialized host owns lifecycle, settings and mutable inventory state */
import type { Fiber, Plugin } from "@deepseek-ai/cordis"
import type {
  OperationDispatch,
  PluginGenerationLease,
  PluginGateway,
  PluginGatewayEvent,
  PluginLifecycle,
  PluginSettings,
  PluginSettingsEntry,
  PluginSnapshot,
  PluginSource,
  PluginToolsSource,
  PluginToolListing,
  PluginToolView,
  PreparedServerTool,
  ServerToolCall,
  ServerToolView,
  ToolCallContext,
  ToolDefinitionPublic,
  ToolPermission,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { Context } from "@deepseek-ai/cordis"
import {
  ExclusiveResourceLeaseRegistry,
  type HostServices,
  isPluginResourceLifecycle,
  PluginContractError,
  type PluginGenerationResourceLifecycle,
  type PluginManifest,
  type PluginModule,
} from "@stuffbucket/maximal-plugin-sdk"
import {
  blockedToolText,
  OperationUnavailableError,
  PluginGatewayError,
  unapprovedToolText,
} from "@stuffbucket/maximal-plugin-sdk/gateway"
import {
  applyPermissionChanges,
  createFileStorage,
  deactivatePlugin,
  errorMessage,
  installPluginServices,
  invokeTool,
  isPluginSettingsConflictError,
  migrateSettingsDocument,
  mountPlugin,
  newSettingsDocument,
  nonJsonPath,
  operationDispatchOf,
  normalizeManifest,
  parsePluginConfig,
  parseSettingsDocument,
  permissionChangesError,
  providedServices,
  PluginRuntime,
  resolveToolPermission,
  serializeSettingsDocument,
  setToolCatalog,
  settlePlugin,
  storedPermissions,
  toCordisPlugin,
  toConfigIssues,
  toolView,
  toPublicTool,
  validatePluginList,
  type LoadedPluginSettings,
  type PluginSettingsAuthority,
  type PluginSettingsCommit,
  type PluginSettingsDocument,
  type PluginSettingsProposal,
  type PluginSettingsProposalKind,
  type PluginSettingsTransaction,
  type PluginServiceFactory,
  type PluginStorageBackend,
} from "@stuffbucket/maximal-plugin-sdk/runtime"

import {
  HostGenerationResourceLifecycle,
  ManagedPluginResourceLifecycle,
} from "./resource-lifecycle"
import { listServerToolViews, runServerTool } from "./server-tools"

/** The size the SDK refuses to read a settings file above (1 MiB). */
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024

// Cordis exports FiberState as a const enum, which cannot be imported with the
// package's isolatedModules setting. These values are its documented public
// lifecycle states in 4.0.2.
const FIBER_PENDING = 0
const FIBER_LOADING = 1
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

const BUILT_IN_SOURCE: Readonly<PluginSource> = Object.freeze({
  type: "built-in",
})

let nextDirectGeneration = 0
const processResourceLeases = new ExclusiveResourceLeaseRegistry()

async function commitSettingsProposal(
  authority: PluginSettingsAuthority,
  proposal: PluginSettingsProposal,
): Promise<PluginSettingsCommit | undefined> {
  try {
    return await authority.commit(proposal)
  } catch (error) {
    if (isPluginSettingsConflictError(error)) return undefined
    throw error
  }
}

export interface PluginHostOptions {
  /** The static first-party plugin set (module namespaces). */
  plugins: ReadonlyArray<PluginModule>
  services: {
    host: HostServices
    /**
     * `<app dir>/plugins`; each plugin gets `<storageRoot>/<id>/` for
     * ordinary trusted `ctx.storage`. The authority separately reserves the
     * `<storageRoot>/<id>/settings.json` document.
     */
    storageRoot: string
    /** Override ordinary trusted plugin storage (tests). */
    storage?: PluginStorageBackend
    /**
     * Parent-owned authority for the reserved `settings.json` documents. The
     * host consumes snapshots and submits CAS proposals; it never opens those
     * files through ordinary plugin storage.
     */
    settingsAuthority: PluginSettingsAuthority
    /**
     * App-provided services beyond `tools`, `surface`, `storage` and `host`.
     * Each factory builds a cordis `Service` on the root; its name becomes an
     * allowed entry in plugins' `inject`.
     */
    extra?: ReadonlyArray<PluginServiceFactory>
  }
  /**
   * Candidate hosts prepare declared resources but do not acquire them. Active
   * hosts prepare and commit during reconcile (the legacy direct-host mode).
   */
  resourceActivation?: {
    mode: "active" | "candidate"
    /** Parent-owned lease table shared by N and N+1. */
    leases?: ExclusiveResourceLeaseRegistry
  }
}

/** Cordis-backed gateway with explicit mutable inventory operations. */
export interface PluginHostGateway extends PluginGateway {
  /** Narrow generation activation surface for a process supervisor. */
  resourceLifecycle(): PluginGenerationResourceLifecycle
  /** Add a new inventory entry. It follows the most recent reconcile settings. */
  addPlugin(module: PluginModule, source: PluginSource): Promise<void>
  /** Stop and remove an inventory entry. Its settings file is retained. */
  removePlugin(id: string): Promise<void>
  /**
   * Replace one entry in place. An enabled replacement must become active;
   * `failed` or `waiting` candidates are removed, the previous entry is
   * restarted, and the operation rejects with `replacement-not-ready`.
   */
  replacePlugin(
    id: string,
    module: PluginModule,
    source: PluginSource,
  ): Promise<void>
  /** Replace the complete inventory under one staged settings transaction. */
  replaceInventory(
    entries: ReadonlyArray<{
      module: PluginModule
      source: PluginSource
    }>,
    prepareCommit?: (transaction: PluginSettingsTransaction) => Promise<void>,
  ): Promise<void>
}

type RevisionedPluginSettings = LoadedPluginSettings & {
  readonly revision: number
  readonly epoch: number
  readonly migrationProposal?: PluginSettingsProposal
}

interface PluginRecord {
  readonly id: string
  readonly module: PluginModule
  readonly manifest: Readonly<PluginManifest>
  readonly plugin: Plugin.Object<unknown>
  readonly source: Readonly<PluginSource>
  enabled: boolean
  lifecycle: PluginLifecycle
  error: string | undefined
  waitingForServices: Array<string> | undefined
  waitingReason: string | undefined
  /** `#desiredKey` of the current activation attempt. */
  appliedKey: string | undefined
  fiber: Fiber | undefined
  lifetime: AbortController | undefined
  /** Resource hooks returned by this activation's `apply`. */
  resources: ManagedPluginResourceLifecycle | undefined
  /** Last load of the settings file; `undefined` until the first load finished. */
  settings: RevisionedPluginSettings | undefined
  /** Candidate inventory entries collect proposals without committing them. */
  authorityWrites: boolean
  /** Serialises snapshot and proposal work for this plugin. */
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

function normalizeSource(source: unknown): Readonly<PluginSource> {
  if (source === null || typeof source !== "object") {
    throw new TypeError(
      "Plugin source must be built-in or an external specifier.",
    )
  }
  const candidate = source as { type?: unknown; specifier?: unknown }
  if (candidate.type === "built-in") return BUILT_IN_SOURCE
  if (
    candidate.type === "external"
    && typeof candidate.specifier === "string"
    && candidate.specifier.trim() !== ""
  ) {
    return Object.freeze({
      type: "external",
      specifier: candidate.specifier,
    })
  }
  throw new TypeError(
    "Plugin source must be built-in or an external specifier.",
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

function configView(settings: RevisionedPluginSettings | undefined): unknown {
  if (!settings?.ok) return undefined
  if (settings.parsed.ok) {
    const copy = jsonCopy(settings.parsed.value)
    if (copy !== undefined) return copy
  }
  return structuredClone(settings.document.config)
}

/** What a reconcile compares to decide whether the plugin must (re)start. */
function settingsKey(settings: RevisionedPluginSettings | undefined): string {
  if (!settings) return "!unloaded"
  if (!settings.ok) return `!${settings.error}`
  if (!settings.parsed.ok) return `!${settings.parsed.message}`
  return stableKey(settings.document.config ?? {})
}

function settingsFailure(
  settings: RevisionedPluginSettings | undefined,
): string | undefined {
  if (!settings) return "Plugin settings have not been loaded."
  if (!settings.ok) return settings.error
  return settings.parsed.ok ? undefined : settings.parsed.message
}

function permissionsKey(
  settings: RevisionedPluginSettings | undefined,
): string {
  return stableKey(settings?.ok ? storedPermissions(settings.document) : {})
}

/** Why an enabled replacement cannot be committed yet, if anything. */
function replacementStartupFailure(record: PluginRecord): Error | undefined {
  if (record.lifecycle === "failed") {
    return new Error(
      record.error ?? `Replacement plugin "${record.id}" failed to start.`,
    )
  }
  if (!record.enabled || record.lifecycle === "active") return undefined
  const reason =
    record.waitingReason
    ?? `Replacement plugin "${record.id}" is ${record.lifecycle}.`
  return new Error(
    `${reason} Enabled replacements must become active immediately.`,
  )
}

class PluginHost implements PluginHostGateway {
  readonly #root = new Context()
  readonly #runtime: PluginRuntime
  readonly #records = new Map<string, PluginRecord>()
  /** Failed replacement records whose physical resources still need cleanup. */
  readonly #quarantined = new Map<string, Set<PluginRecord>>()
  readonly #listeners = new Set<(event: PluginGatewayEvent) => void>()
  readonly #operationListeners = new Set<() => void>()
  readonly #host: HostServices
  readonly #operations: OperationDispatch
  #operationFingerprint = "[]"
  readonly #storage: PluginStorageBackend
  readonly #settingsAuthority: PluginSettingsAuthority
  readonly #baseServices: ReadonlyArray<string>
  readonly #generationId = `direct-${++nextDirectGeneration}`
  readonly #resourceMode: "active" | "candidate"
  readonly #resourceLeases: ExclusiveResourceLeaseRegistry
  readonly #resourceLifecycle: HostGenerationResourceLifecycle
  #inventoryTransaction: PluginSettingsTransaction | undefined
  #bufferedEvents: Array<PluginGatewayEvent> | undefined
  #restoringInventory = false
  #desiredSettings: PluginSettings | undefined
  #queue: Promise<void> = Promise.resolve()
  #disposed = false
  #disposing: Promise<void> | undefined

  constructor(options: PluginHostOptions) {
    this.#host = options.services.host
    this.#resourceMode = options.resourceActivation?.mode ?? "active"
    this.#resourceLeases =
      options.resourceActivation?.leases ?? processResourceLeases
    this.#resourceLifecycle = new HostGenerationResourceLifecycle({
      slots: () =>
        this.#resourceRecords()
          // Failed disable and replacement records keep their physical handles
          // quarantined. Desired enablement cannot release the parent lease.
          .filter((record) => record.resources !== undefined)
          .map((record) => record.resources as ManagedPluginResourceLifecycle),
      overlapSafe: () =>
        [...this.#records.values()]
          .filter(
            (record) =>
              record.enabled
              && record.lifecycle === "active"
              && record.resources === undefined,
          )
          .map((record) => record.id),
    })
    const operations = operationDispatchOf(this.#root)
    this.#operations = this.#filterOperations(operations)
    operations.subscribe(() => this.#notifyOperationListeners())
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
    this.#settingsAuthority = options.services.settingsAuthority
    this.#baseServices = installPluginServices(this.#root, this.#runtime, {
      host: options.services.host,
      storage: this.#storage,
      extra: options.services.extra,
    })
    const plugins = validatePluginList(options.plugins, this.#baseServices)
    for (const module of plugins) {
      this.#records.set(module.name, this.#newRecord(module, BUILT_IN_SOURCE))
    }
    // `internal/status` is Cordis' documented lifecycle event. Keeping this
    // narrow adapter here lets Cordis remain the dependency scheduler while the
    // gateway projects its states and missing-service reason.
    this.#root.on("internal/status", (fiber: Fiber) => {
      const state: number = fiber.state
      queueMicrotask(() => {
        const record = this.#recordForFiber(fiber)
        if (record) this.#syncFiberLifecycle(record, fiber, state)
      })
    })
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

  #filterOperations(operations: OperationDispatch): OperationDispatch {
    return {
      resolve: (operation, model) => {
        const resolved = operations.resolve(operation, model)
        return resolved && this.#operationActive(resolved.pluginId) ?
            resolved
          : undefined
      },
      prepare: (operation, model) => {
        const prepared = operations.prepare(operation, model)
        if (!prepared || this.#operationActive(prepared.pluginId))
          return prepared
        prepared.release()
        return undefined
      },
      dispatch: async (request) => {
        const prepared = this.#operations.prepare(
          request.operation,
          request.model,
        )
        if (!prepared)
          throw new OperationUnavailableError(request.operation, request.model)
        const { operation: _operation, model: _model, ...call } = request
        try {
          return await prepared.execute(call)
        } finally {
          prepared.release()
        }
      },
      servedModels: () =>
        operations
          .servedModels()
          .map((model) => ({
            ...model,
            operations: model.operations.filter((operation) => {
              const resolved = operations.resolve(
                operation,
                `${model.provider}/${model.model}`,
              )
              return (
                resolved !== undefined
                && this.#operationActive(resolved.pluginId)
              )
            }),
          }))
          .filter((model) => model.operations.length > 0),
      subscribe: (listener) => {
        this.#operationListeners.add(listener)
        return () => {
          this.#operationListeners.delete(listener)
        }
      },
    }
  }

  #operationActive(pluginId: string): boolean {
    return (
      this.#records.get(pluginId)?.lifecycle === "active"
      && !this.#quarantined.has(pluginId)
    )
  }

  #notifyOperationListeners(): void {
    const fingerprint = JSON.stringify(this.#operations.servedModels())
    if (fingerprint === this.#operationFingerprint) return
    this.#operationFingerprint = fingerprint
    for (const listener of this.#operationListeners) {
      try {
        listener()
      } catch {
        // A failing observer never breaks lifecycle convergence.
      }
    }
  }

  acquireGeneration(): PluginGenerationLease {
    let released = false
    const live = () => {
      if (released) throw new Error("Plugin generation lease was released.")
    }
    return {
      generationId: this.#generationId,
      get: (id) => {
        live()
        return this.get(id)
      },
      listTools: (pluginId) => {
        live()
        return this.listTools(pluginId)
      },
      toolViews: (pluginId) => {
        live()
        return this.toolViews(pluginId)
      },
      serverTools: () => {
        live()
        return this.serverTools()
      },
      operations: () => {
        live()
        return this.operations()
      },
      // eslint-disable-next-line max-params -- implements PluginGenerationLease.callTool
      callTool: async (pluginId, name, input, call) => {
        live()
        return await this.callTool(pluginId, name, input, call)
      },
      prepareServerTool: async (pluginId, name, input) => {
        live()
        return await this.prepareServerTool(pluginId, name, input)
      },
      release: () => {
        released = true
      },
    }
  }

  resourceLifecycle(): PluginGenerationResourceLifecycle {
    return this.#resourceLifecycle
  }

  reconcile(settings: PluginSettings | undefined): Promise<void> {
    return this.#enqueue(() => this.#reconcileNow(settings))
  }

  addPlugin(module: PluginModule, source: PluginSource): Promise<void> {
    return this.#enqueue(() => this.#addPluginNow(module, source))
  }

  removePlugin(id: string): Promise<void> {
    return this.#enqueue(() => this.#removePluginNow(id))
  }

  replacePlugin(
    id: string,
    module: PluginModule,
    source: PluginSource,
  ): Promise<void> {
    return this.#enqueue(() => this.#replacePluginNow(id, module, source))
  }

  replaceInventory(
    entries: ReadonlyArray<{ module: PluginModule; source: PluginSource }>,
    prepareCommit?: (transaction: PluginSettingsTransaction) => Promise<void>,
  ): Promise<void> {
    return this.#enqueue(() =>
      this.#replaceInventoryNow(entries, prepareCommit),
    )
  }

  operations(): OperationDispatch {
    return this.#operations
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

  serverTools(): Array<ServerToolView> {
    const active = [...this.#records.values()]
      .filter((record) => record.lifecycle === "active")
      .map((record) => record.id)
    return listServerToolViews(this.#runtime, active)
  }

  // Async preserves the gateway contract by turning lookup failures into rejections.
  // eslint-disable-next-line @typescript-eslint/require-await
  async prepareServerTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<PreparedServerTool> {
    const record = this.#activeRecord(pluginId)
    const tool = this.#runtime.serverTool(pluginId, name)
    if (!tool)
      throw new PluginGatewayError(
        "unknown-tool",
        pluginId,
        `Plugin "${pluginId}" has no server tool "${name}".`,
      )
    let estimate
    try {
      estimate = tool.estimate?.(input)
    } catch {
      estimate = undefined
    }
    let released = false
    return {
      pluginId,
      name,
      estimate,
      execute: async (call) => {
        if (released)
          throw new Error("Prepared server tool was already consumed.")
        released = true
        return await runServerTool({
          tool,
          pluginId,
          input,
          call,
          lifetime: record.lifetime?.signal,
        })
      },
      release: () => {
        released = true
      },
    }
  }

  // eslint-disable-next-line max-params -- implements the PluginGateway.callServerTool contract
  async callServerTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
    call: ServerToolCall,
  ): Promise<ToolResult> {
    const prepared = await this.prepareServerTool(pluginId, name, input)
    return await prepared.execute(call)
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
    await this.#enqueue(() =>
      this.#updateConfigNow(this.#record(pluginId), config),
    )
  }

  async setToolPermissions(
    pluginId: string,
    changes: Record<string, ToolPermission | null>,
  ): Promise<void> {
    await this.#enqueue(async () => {
      const record = this.#record(pluginId)
      const invalid = permissionChangesError(changes)
      if (invalid !== undefined)
        throw new PluginGatewayError("invalid-permissions", pluginId, invalid)
      const changed = await this.#mutate(record, "permissions", (document) =>
        applyPermissionChanges(document, changes) ? {} : undefined,
      )
      if (!changed) return
      this.#emit({ type: "tools", pluginId })
      this.#emit({ type: "settings", pluginId })
    })
  }

  async importLegacyConfig(
    pluginId: string,
    config: unknown,
  ): Promise<boolean> {
    return await this.#enqueue(async () => {
      const record = this.#record(pluginId)
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
    if (this.#disposing) return this.#disposing
    const disposing = (async () => {
      this.#disposed = true
      await this.#queue
      const records = this.#resourceRecords()
      await Promise.all(
        records.map(async (record) => {
          await this.#stop(record)
          // `dispose` waits for the reconcile queue to drain and sets
          // `#disposed`, so nothing else writes this record concurrently.
          /* eslint-disable require-atomic-updates -- see above */
          record.enabled = false
          record.error = undefined
          record.appliedKey = undefined
          /* eslint-enable require-atomic-updates */
          this.#setLifecycle(record, "disabled")
          this.#removeQuarantine(record)
        }),
      )
      await this.#root.fiber.dispose()
      await Promise.all(records.map((record) => record.io))
      // All physical cleanup acknowledged before registry ownership is freed.
      this.#resourceLeases.releaseGeneration(this.#generationId)
      this.#listeners.clear()
      this.#operationListeners.clear()
    })()
    this.#disposing = disposing
    void disposing.catch(() => {
      // Failed physical cleanup remains quarantined in the record and registry.
      // Permit an explicit later dispose call to retry it.
      if (this.#disposing === disposing) this.#disposing = undefined
    })
    return disposing
  }

  #resourceRecords(): Array<PluginRecord> {
    return [
      ...new Set([
        ...this.#records.values(),
        ...[...this.#quarantined.values()].flatMap((records) => [...records]),
      ]),
    ]
  }

  #quarantine(record: PluginRecord): void {
    const records = this.#quarantined.get(record.id) ?? new Set<PluginRecord>()
    records.add(record)
    this.#quarantined.set(record.id, records)
  }

  #removeQuarantine(record: PluginRecord): void {
    const records = this.#quarantined.get(record.id)
    if (!records) return
    records.delete(record)
    if (records.size === 0) this.#quarantined.delete(record.id)
  }

  async #drainQuarantine(pluginId: string): Promise<void> {
    const records = this.#quarantined.get(pluginId)
    if (!records) return
    for (const record of records) {
      await this.#stop(record)
      await record.io
      this.#removeQuarantine(record)
    }
  }

  #newRecord(
    module: PluginModule,
    source: Readonly<PluginSource>,
  ): PluginRecord {
    const record: PluginRecord = {
      id: module.name,
      module,
      manifest: normalizeManifest(module.name, module.manifest),
      plugin: toCordisPlugin(module, (result) =>
        this.#activateResourceLifecycle(record, result),
      ),
      source,
      enabled: false,
      lifecycle: "disabled",
      error: undefined,
      waitingForServices: undefined,
      waitingReason: undefined,
      appliedKey: undefined,
      fiber: undefined,
      lifetime: undefined,
      resources: undefined,
      settings: undefined,
      authorityWrites: true,
      io: Promise.resolve(),
      catalogQueued: false,
    }
    return record
  }

  async #activateResourceLifecycle(
    record: PluginRecord,
    result: unknown,
  ): Promise<undefined | (() => Promise<unknown>)> {
    if (result === undefined) return
    if (!isPluginResourceLifecycle(result)) {
      throw new PluginContractError(
        "invalid-module",
        `Plugin "${record.id}" returned an invalid resource lifecycle.`,
        { pluginId: record.id },
      )
    }
    if (record.resources !== undefined) {
      throw new PluginContractError(
        "invalid-module",
        `Plugin "${record.id}" returned more than one resource lifecycle.`,
        { pluginId: record.id },
      )
    }
    const resources = new ManagedPluginResourceLifecycle({
      pluginId: record.id,
      generationId: this.#generationId,
      hooks: result,
      leases: this.#resourceLeases,
    })
    record.resources = resources
    try {
      await resources.prepare()
      if (this.#resourceMode === "active") await resources.commit()
    } catch (activationError) {
      try {
        await resources.revoke({
          purpose: "recovery",
          deadline: Date.now() + 2000,
        })
        if (record.resources === resources) record.resources = undefined
      } catch (cleanupError) {
        throw new AggregateError(
          [activationError, cleanupError],
          `Plugin "${record.id}" activation failed and resource cleanup did not complete.`,
        )
      }
      throw activationError
    }
    return async () => {
      await resources.revoke({ deadline: Date.now() + 2000 })
      if (record.resources === resources) record.resources = undefined
    }
  }

  #availableServices(excludeId?: string): Array<string> {
    return [
      ...this.#baseServices,
      ...[...this.#records.values()]
        .filter((record) => record.id !== excludeId)
        .flatMap((record) => providedServices(record.module)),
    ]
  }

  #validateInventoryModule(
    module: PluginModule,
    excludeId?: string,
  ): PluginModule {
    return validatePluginList([module], this.#availableServices(excludeId))[0]
  }

  async #addPluginNow(
    candidate: PluginModule,
    source: PluginSource,
  ): Promise<void> {
    if (this.#disposed) return
    const module = this.#validateInventoryModule(candidate)
    if (this.#records.has(module.name)) {
      throw new PluginContractError(
        "invalid-module",
        `Duplicate plugin id "${module.name}".`,
        { pluginId: module.name },
      )
    }
    const record = this.#newRecord(module, normalizeSource(source))
    record.enabled =
      settingsEntry(this.#desiredSettings, record.id)?.enabled === true
    record.authorityWrites = false
    this.#records.set(record.id, record)
    try {
      await this.#load(record)
      await this.#converge(record, record.enabled)
      const startupFailure = replacementStartupFailure(record)
      if (startupFailure) throw startupFailure
      if (!this.#restoringInventory) await this.#commitPendingMigration(record)
      record.authorityWrites = true
      if (!this.#restoringInventory) this.#scheduleCatalog(record.id)
    } catch (error) {
      this.#records.delete(record.id)
      await this.#stop(record)
      throw error
    }
    this.#emit({ type: "inventory", pluginId: record.id })
  }

  async #removePluginNow(id: string): Promise<void> {
    if (this.#disposed) return
    await this.#drainQuarantine(id)
    const record = this.#record(id)
    await this.#stop(record)
    record.enabled = false
    record.error = undefined
    record.appliedKey = undefined
    record.waitingForServices = undefined
    record.waitingReason = undefined
    this.#setLifecycle(record, "disabled")
    await record.io
    this.#records.delete(id)
    this.#emit({ type: "inventory", pluginId: id })
  }

  /** Stop the old fiber and drain its already-authorized proposal work. */
  async #stopForReplacement(record: PluginRecord): Promise<void> {
    await record.io
    await this.#stop(record)
    this.#setLifecycle(record, "disabled")
    await record.io
  }

  // eslint-disable-next-line max-lines-per-function -- replacement startup, cleanup quarantine and rollback share one safety boundary
  async #replacePluginNow(
    id: string,
    candidate: PluginModule,
    source: PluginSource,
  ): Promise<void> {
    if (this.#disposed) return
    await this.#drainQuarantine(id)
    const previous = this.#record(id)
    const module = this.#validateInventoryModule(candidate, id)
    if (module.name !== id) {
      throw new PluginContractError(
        "invalid-module",
        `Replacement plugin id "${module.name}" must equal "${id}".`,
        { pluginId: module.name },
      )
    }
    const replacement = this.#newRecord(module, normalizeSource(source))
    replacement.enabled = previous.enabled
    replacement.authorityWrites = false
    await this.#stopForReplacement(previous)
    this.#records.set(id, replacement)
    let failure: unknown
    try {
      await this.#load(replacement)
      await this.#converge(replacement, replacement.enabled)
      failure = replacementStartupFailure(replacement)
      if (failure === undefined) {
        if (!this.#restoringInventory)
          await this.#commitPendingMigration(replacement)
        replacement.authorityWrites = true
        if (!this.#restoringInventory) this.#scheduleCatalog(id)
      }
    } catch (error) {
      failure = error
    }
    if (failure === undefined) {
      this.#emit({ type: "inventory", pluginId: id })
      return
    }

    let cleanupFailure: unknown
    try {
      await this.#stop(replacement)
      await replacement.io
    } catch (error) {
      cleanupFailure = error
      this.#quarantine(replacement)
    }

    let rollbackFailure: unknown
    previous.appliedKey = undefined
    previous.error = undefined
    previous.waitingForServices = undefined
    previous.waitingReason = undefined
    this.#records.set(id, previous)
    if (cleanupFailure === undefined) {
      try {
        await this.#load(previous)
        await this.#converge(previous, true)
        if (previous.lifecycle === "failed") {
          rollbackFailure = new Error(
            `Previous plugin "${id}" failed to restart: ${String(previous.error)}`,
          )
        }
      } catch (error) {
        rollbackFailure = error
      }
    } else {
      const detail = `replacement cleanup is incomplete: ${errorMessage(cleanupFailure)}`
      previous.error = detail
      this.#setLifecycle(previous, "failed")
    }

    const detail = errorMessage(failure)
    const causes = [failure, cleanupFailure, rollbackFailure].filter(
      (cause) => cause !== undefined,
    )
    const cause =
      causes.length === 1 ?
        causes[0]
      : new AggregateError(
          causes,
          `Replacement for plugin "${id}" did not complete safely.`,
        )
    if (cleanupFailure !== undefined) {
      throw new PluginGatewayError(
        "replacement-not-ready",
        id,
        `Replacement for plugin "${id}" was not ready (${detail}); cleanup failed and rollback is deferred (${errorMessage(cleanupFailure)}).`,
        { cause },
      )
    }
    if (rollbackFailure !== undefined) {
      throw new PluginGatewayError(
        "replacement-not-ready",
        id,
        `Replacement for plugin "${id}" was not ready (${detail}); rollback also failed (${errorMessage(rollbackFailure)}).`,
        { cause },
      )
    }
    throw new PluginGatewayError(
      "replacement-not-ready",
      id,
      `Replacement for plugin "${id}" was not ready and was rolled back: ${detail}`,
      { cause },
    )
  }

  // eslint-disable-next-line complexity, max-lines-per-function -- reconcile and rollback share one transaction boundary
  async #replaceInventoryNow(
    entries: ReadonlyArray<{ module: PluginModule; source: PluginSource }>,
    prepareCommit?: (transaction: PluginSettingsTransaction) => Promise<void>,
  ): Promise<void> {
    if (this.#disposed) return
    const modules = validatePluginList(
      entries.map((entry) => entry.module),
      this.#baseServices,
    )
    const desired = new Map(
      modules.map(
        (module, index) =>
          [
            module.name,
            { module, source: normalizeSource(entries[index].source) },
          ] as const,
      ),
    )
    const previous = new Map(
      [...this.#records].map(([id, record]) => [
        id,
        { module: record.module, source: record.source },
      ]),
    )
    const transaction = this.#settingsAuthority.beginTransaction()
    this.#inventoryTransaction = transaction
    this.#bufferedEvents = []
    let failure: unknown
    try {
      for (const id of [...this.#records.keys()].reverse()) {
        if (!desired.has(id)) await this.#removePluginNow(id)
      }
      for (const [id, entry] of desired) {
        const current = this.#records.get(id)
        if (current && current.module !== entry.module) {
          await this.#replacePluginNow(id, entry.module, entry.source)
        }
      }
      for (const [id, entry] of desired) {
        if (!this.#records.has(id)) {
          await this.#addPluginNow(entry.module, entry.source)
        }
      }
      await Promise.all([...this.#records.values()].map((record) => record.io))
      await prepareCommit?.(transaction)
      await transaction.finish()
    } catch (error) {
      failure = error
      transaction.rollback()
    } finally {
      this.#inventoryTransaction = undefined
    }

    if (failure !== undefined) {
      let rollbackFailure: unknown
      this.#restoringInventory = true
      try {
        for (const id of [...this.#records.keys()].reverse()) {
          if (!previous.has(id)) await this.#removePluginNow(id)
        }
        for (const [id, entry] of previous) {
          const current = this.#records.get(id)
          if (!current) {
            await this.#addPluginNow(entry.module, entry.source)
          } else if (current.module !== entry.module) {
            await this.#replacePluginNow(id, entry.module, entry.source)
          }
        }
      } catch (error) {
        rollbackFailure = error
      } finally {
        this.#restoringInventory = false
      }
      this.#bufferedEvents = undefined
      if (rollbackFailure !== undefined) {
        throw new AggregateError(
          [failure, rollbackFailure],
          "Plugin inventory failed and could not be fully rolled back.",
        )
      }
      if (failure instanceof Error) throw failure
      throw new Error("Plugin inventory transaction failed.", {
        cause: failure,
      })
    }

    const loads = await Promise.allSettled(
      [...this.#records.values()].map((record) => this.#load(record)),
    )
    const events = this.#bufferedEvents
    this.#bufferedEvents = undefined
    for (const event of events) this.#emit(event)
    const loadFailures = loads
      .filter((result) => result.status === "rejected")
      .map((result): unknown => result.reason as unknown)
    if (loadFailures.length === 1) throw loadFailures[0]
    if (loadFailures.length > 1) {
      throw new AggregateError(
        loadFailures,
        "Committed plugin inventory could not be fully reloaded.",
      )
    }
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

  #authority(): PluginSettingsAuthority {
    return this.#inventoryTransaction ?? this.#settingsAuthority
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

  /** Read an immutable authority snapshot and prepare migration in memory. */
  #load(record: PluginRecord): Promise<void> {
    return this.#io(record, async () => {
      const previous = record.settings
      let next: RevisionedPluginSettings | undefined
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const snapshot = await this.#authority().snapshot(record.id)
        try {
          const original =
            snapshot.text === undefined ?
              newSettingsDocument(record.manifest)
            : parseSettingsDocument(record.id, snapshot.text)
          const migration = await migrateSettingsDocument(
            record.module,
            record.manifest,
            original,
          )
          const parsed = await parsePluginConfig(
            record.module,
            migration.document.config,
          )
          const proposal =
            migration.migrated && parsed.ok ?
              {
                pluginId: record.id,
                baseRevision: snapshot.revision,
                baseEpoch: snapshot.epoch,
                kind: "migration" as const,
                text: serializeSettingsDocument(migration.document),
              }
            : undefined
          if (proposal && record.authorityWrites) {
            const committed = await commitSettingsProposal(
              this.#authority(),
              proposal,
            )
            if (!committed) continue
            next = {
              ok: true,
              document: migration.document,
              exists: true,
              migrated: true,
              parsed,
              revision: committed.revision,
              epoch: committed.epoch,
            }
            break
          }
          next = {
            ok: true,
            document: migration.document,
            exists: snapshot.text !== undefined,
            migrated: migration.migrated,
            parsed,
            revision: snapshot.revision,
            epoch: snapshot.epoch,
            ...(proposal === undefined ? {} : { migrationProposal: proposal }),
          }
          break
        } catch (error) {
          next = {
            ok: false,
            error: errorMessage(error),
            revision: snapshot.revision,
            epoch: snapshot.epoch,
          }
          break
        }
      }
      if (!next)
        throw new Error(
          `Plugin "${record.id}" settings kept changing during load.`,
        )
      record.settings = next
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

  /** Commit a candidate's prepared migration only after it proved ready. */
  async #commitPendingMigration(record: PluginRecord): Promise<void> {
    const settings = record.settings
    if (!settings?.ok || !settings.migrationProposal) return
    const committed = await this.#authority().commit(settings.migrationProposal)
    record.settings = {
      ...settings,
      exists: true,
      revision: committed.revision,
      epoch: committed.epoch,
      migrationProposal: undefined,
    }
  }

  /** Cache the live tool set once the current burst of registrations settles. */
  #scheduleCatalog(pluginId: string): void {
    const record = this.#records.get(pluginId)
    if (
      !record
      || this.#quarantined.has(pluginId)
      || !record.authorityWrites
      || record.catalogQueued
    )
      return
    record.catalogQueued = true
    this.#io(record, async () => {
      record.catalogQueued = false
      const tools = this.#runtime.tools(pluginId)
      if (!record.settings?.ok || tools.length === 0) return
      await this.#mutateNow(record, "catalog", (document) => {
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
    await this.#mutate(record, "config", (document) => {
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
    return this.#mutate(record, "legacy-config", async (document) => {
      if (document.config !== undefined || config === undefined) return
      const migrated = await this.#migrateLegacy(record, config)
      if (migrated === undefined) return
      document.config = migrated
      return { parsed: await parsePluginConfig(record.module, migrated) }
    })
  }

  /** Replay a read-modify-CAS proposal until it commits or remains too busy. */
  #mutate(
    record: PluginRecord,
    kind: PluginSettingsProposalKind,
    change: SettingsChange,
  ): Promise<boolean> {
    return this.#io(record, () => this.#mutateNow(record, kind, change))
  }

  /** `#mutate` body; only call from a step already on the record's `io` chain. */
  async #mutateNow(
    record: PluginRecord,
    kind: PluginSettingsProposalKind,
    change: SettingsChange,
  ): Promise<boolean> {
    this.#writable(record)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const snapshot = await this.#authority().snapshot(record.id)
      let document: PluginSettingsDocument
      try {
        document =
          snapshot.text === undefined ?
            newSettingsDocument(record.manifest)
          : parseSettingsDocument(record.id, snapshot.text)
      } catch (error) {
        throw new PluginGatewayError(
          "settings-unreadable",
          record.id,
          errorMessage(error),
          { cause: error },
        )
      }
      if (document.version !== record.manifest.settingsVersion) {
        throw new PluginGatewayError(
          "settings-unreadable",
          record.id,
          `Plugin settings file for "${record.id}" changed to version ${document.version}; reload plugins before changing settings.`,
        )
      }
      const update = await change(document)
      if (update === undefined) {
        const parsed = await parsePluginConfig(record.module, document.config)
        record.settings = {
          ok: true,
          document,
          exists: snapshot.text !== undefined,
          migrated: false,
          parsed,
          revision: snapshot.revision,
          epoch: snapshot.epoch,
        }
        return false
      }
      const text = serializeSettingsDocument(document)
      if (Buffer.byteLength(text) > MAX_SETTINGS_FILE_BYTES) {
        throw new PluginGatewayError(
          "settings-unreadable",
          record.id,
          `Plugin settings for "${record.id}" would exceed 1 MiB.`,
        )
      }
      try {
        const committed = await this.#authority().commit({
          pluginId: record.id,
          baseRevision: snapshot.revision,
          baseEpoch: snapshot.epoch,
          kind,
          text,
        })
        const current = record.settings
        const parsed =
          update.parsed
          ?? ((
            current?.ok
            && stableKey(document.config) === stableKey(current.document.config)
          ) ?
            current.parsed
          : await parsePluginConfig(record.module, document.config))
        record.settings = {
          ok: true,
          document,
          exists: true,
          migrated: false,
          parsed,
          revision: committed.revision,
          epoch: committed.epoch,
        }
        return true
      } catch (error) {
        if (isPluginSettingsConflictError(error)) continue
        throw error
      }
    }
    throw new PluginGatewayError(
      "settings-unreadable",
      record.id,
      `Plugin settings for "${record.id}" kept changing; try again.`,
    )
  }

  async #reconcileNow(settings: PluginSettings | undefined): Promise<void> {
    if (this.#disposed) return
    this.#desiredSettings = settings
    const records = [...this.#records.values()]
    const changes = records.map((record) => {
      const enabled = settingsEntry(settings, record.id)?.enabled === true
      const enabledChanged = record.enabled !== enabled
      record.enabled = enabled
      return enabledChanged
    })
    // Read in parallel, but converge in record order: what plugins register
    // (operations, providers, server tools) must not depend on I/O timing.
    const loads = await Promise.allSettled(
      records.map((record) => this.#load(record)),
    )
    let failure: { error: unknown } | undefined
    for (const [index, record] of records.entries()) {
      const load = loads[index]
      if (load.status === "rejected") {
        failure ??= { error: load.reason }
        continue
      }
      try {
        await this.#converge(record, changes[index])
      } catch (error) {
        failure ??= { error }
      }
    }
    if (failure) throw failure.error
  }

  /** Start/stop/reload the plugin to match `enabled` and its settings. */
  async #converge(record: PluginRecord, enabledChanged = false): Promise<void> {
    if (this.#disposed) return
    if (this.#records.get(record.id) === record) {
      try {
        await this.#drainQuarantine(record.id)
      } catch (error) {
        const detail = `replacement cleanup is incomplete: ${errorMessage(error)}`
        record.error = detail
        this.#setLifecycle(record, "failed")
        throw error
      }
    }
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
    if (record.lifecycle !== "disabled" && record.appliedKey === key) return
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
    this.#setLifecycle(record, "starting")
    try {
      const fiber = await mountPlugin(
        this.#root,
        this.#runtime,
        record.id,
        record.plugin,
        config,
      )
      record.fiber = fiber
      this.#syncFiberLifecycle(record, fiber)
      await settlePlugin(fiber)
      this.#syncFiberLifecycle(record, fiber)
    } catch (error) {
      const fiber = record.fiber
      const resources = record.resources
      record.lifetime?.abort(error)
      record.lifetime = undefined
      if (resources !== undefined) {
        try {
          await resources.revoke({
            purpose: "recovery",
            deadline: Date.now() + 2000,
          })
          if (record.resources === resources) record.resources = undefined
        } catch (cleanupError) {
          const failure = new AggregateError(
            [error, cleanupError],
            `Plugin "${record.id}" activation failed and resource cleanup did not complete.`,
          )
          // Keep the fiber and resource slot together so disable/dispose can
          // retry physical cleanup without losing parent lease ownership.
          record.error = errorMessage(failure)
          this.#host.logger.warn(`[plugins] ${record.id}: ${record.error}`)
          this.#setLifecycle(record, "failed")
          return
        }
      }
      record.fiber = undefined
      if (fiber) await deactivatePlugin(this.#runtime, record.id, fiber)
      // cordis already logged the apply error through the exporter above.
      record.error = errorMessage(error)
      this.#setLifecycle(record, "failed")
    }
  }

  #recordForFiber(fiber: Fiber): PluginRecord | undefined {
    for (const record of this.#records.values()) {
      if (record.fiber === fiber) return record
    }
    return undefined
  }

  #missingServices(fiber: Fiber): Array<string> {
    return Object.keys(fiber.inject)
      .filter((name) => fiber.ctx.get(name, true) === undefined)
      .sort()
  }

  #waitForServices(record: PluginRecord, fiber: Fiber): void {
    record.lifetime?.abort(
      new Error(`Plugin "${record.id}" is waiting for services.`),
    )
    record.lifetime = undefined
    const missing = this.#missingServices(fiber)
    record.waitingForServices = missing
    record.waitingReason =
      missing.length > 0 ?
        `Waiting for required service${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`
      : "Waiting for required plugin services."
    this.#setLifecycle(record, "waiting")
  }

  #syncFiberLifecycle(
    record: PluginRecord,
    fiber: Fiber,
    state: number = fiber.state,
  ): void {
    if (record.fiber !== fiber) return
    switch (state) {
      case FIBER_ACTIVE: {
        record.lifetime ??= new AbortController()
        record.error = undefined
        record.waitingForServices = undefined
        record.waitingReason = undefined
        this.#setLifecycle(record, "active")
        break
      }
      case FIBER_LOADING: {
        record.lifetime?.abort(
          new Error(`Plugin "${record.id}" activation restarted.`),
        )
        record.lifetime = new AbortController()
        record.error = undefined
        record.waitingForServices = undefined
        record.waitingReason = undefined
        this.#setLifecycle(record, "starting")
        break
      }
      case FIBER_UNLOADING: {
        record.lifetime?.abort(
          new Error(`Plugin "${record.id}" activation stopped.`),
        )
        record.lifetime = undefined
        record.waitingForServices = undefined
        record.waitingReason = undefined
        this.#setLifecycle(record, "starting")
        break
      }
      case FIBER_PENDING: {
        this.#waitForServices(record, fiber)
        break
      }
      case FIBER_FAILED: {
        record.lifetime?.abort(new Error(`Plugin "${record.id}" failed.`))
        record.lifetime = undefined
        record.waitingForServices = undefined
        record.waitingReason = undefined
        record.error ??= `Plugin "${record.id}" failed during activation.`
        this.#setLifecycle(record, "failed")
        void settlePlugin(fiber).catch((error: unknown) => {
          if (record.fiber !== fiber) return
          record.error = errorMessage(error)
          this.#setLifecycle(record, "failed", true)
        })
        break
      }
      case FIBER_DISPOSED: {
        record.lifetime?.abort(new Error(`Plugin "${record.id}" disposed.`))
        record.lifetime = undefined
        break
      }
      default: {
        break
      }
    }
  }

  /** Dispose the plugin's fiber; its tools, actions and status vanish. */
  async #stop(record: PluginRecord): Promise<void> {
    const { fiber, lifetime, resources } = record
    if (resources !== undefined) {
      try {
        await resources.revoke({ deadline: Date.now() + 2000 })
      } catch (error) {
        const detail = `resource cleanup failed: ${errorMessage(error)}`
        this.#host.logger.warn(`[plugins] ${record.id}: ${detail}`)
        // Keep the fiber, lifecycle hooks, physical handle and registry lease
        // together. The failed record is quarantined and #stop can retry it.
        record.error = detail
        this.#setLifecycle(record, "failed")
        lifetime?.abort(new Error(`Plugin "${record.id}" cleanup failed.`))
        throw error
      }
    }
    record.fiber = undefined
    record.lifetime = undefined
    record.resources = undefined
    record.waitingForServices = undefined
    record.waitingReason = undefined
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
    this.#notifyOperationListeners()
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
    const status =
      record.lifecycle === "active" ?
        this.#runtime.status(record.id)
      : undefined
    const catalog = this.#document(record)?.tools?.catalog
    return {
      id: record.id,
      kind: manifest.kind,
      displayName: manifest.displayName,
      description: manifest.description,
      ...(manifest.homepage === undefined ?
        {}
      : { homepage: manifest.homepage }),
      source: structuredClone(record.source),
      manifest: structuredClone(manifest),
      settingsVersion: manifest.settingsVersion,
      ...(manifest.configSchema === undefined ?
        {}
      : { configSchema: structuredClone(manifest.configSchema) }),
      config: configView(record.settings),
      enabled: record.enabled,
      lifecycle: record.lifecycle,
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.waitingForServices === undefined ?
        {}
      : { waitingForServices: [...record.waitingForServices] }),
      ...(record.waitingReason === undefined ?
        {}
      : { waitingReason: record.waitingReason }),
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
    if (this.#bufferedEvents) {
      this.#bufferedEvents.push(event)
      return
    }
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
export function createPluginHost(
  options: PluginHostOptions,
): PluginHostGateway {
  return new PluginHost(options)
}
