import type {
  ModelBinding,
  ModelOperation,
  OperationDispatch,
  PluginGateway,
  PluginGatewayEvent,
  PluginGenerationLease,
  PluginSettings,
  PluginSnapshot,
  PluginToolListing,
  PluginToolView,
  PreparedOperation,
  PreparedServerTool,
  ServedModel,
  ServerToolCall,
  ServerToolView,
  ToolCallContext,
  ToolPermission,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import {
  OperationUnavailableError,
  PluginGatewayError,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

interface GatewayProjection {
  readonly plugins: ReadonlyArray<PluginSnapshot>
  readonly pluginById: ReadonlyMap<string, PluginSnapshot>
  readonly listings: ReadonlyMap<string, ReadonlyArray<PluginToolListing>>
  readonly toolViews: ReadonlyMap<string, ReadonlyArray<PluginToolView>>
  readonly serverTools: ReadonlyArray<ServerToolView>
  readonly servedModels: ReadonlyArray<ServedModel>
  readonly operationTargets: ReadonlyMap<
    string,
    { pluginId: string; binding: ModelBinding }
  >
}

interface GenerationState {
  readonly id: string
  readonly gateway: PluginGateway
  projection: GatewayProjection
  refs: number
  active: boolean
  disposed: boolean
  /** Settles when `gateway.dispose()` has finished; set once retired. */
  disposal: Promise<void> | undefined
  /** `dispose()` finished; the state is no longer tracked. */
  settled: boolean
  unsubscribe: () => void
}

export interface ProjectedGenerationDiagnostics {
  readonly generationId: string
  readonly active: boolean
  /** Operation, prepared-tool, and affinity leases still pinning this generation. */
  readonly refs: number
  readonly disposed: boolean
}

interface IdleWaiter {
  readonly matches: (state: GenerationState) => boolean
  readonly wantDisposed: boolean
  readonly settle: () => void
}

const clone = <T>(value: T): T => structuredClone(value)

const operationKey = (operation: ModelOperation, model: string): string =>
  JSON.stringify([operation, model])

function freezeProjection(gateway: PluginGateway): GatewayProjection {
  const plugins = gateway.list().map((value) => clone(value))
  const listings = new Map<string, ReadonlyArray<PluginToolListing>>()
  const toolViews = new Map<string, ReadonlyArray<PluginToolView>>()
  for (const plugin of plugins) {
    listings.set(
      plugin.id,
      gateway.listTools(plugin.id).map((value) => clone(value)),
    )
    toolViews.set(
      plugin.id,
      gateway.toolViews(plugin.id).map((value) => clone(value)),
    )
  }
  const operations = gateway.operations()
  const servedModels = operations.servedModels().map((value) => clone(value))
  const operationTargets = new Map<
    string,
    { pluginId: string; binding: ModelBinding }
  >()
  for (const served of servedModels) {
    for (const operation of served.operations) {
      for (const model of [
        served.model,
        `${served.provider}/${served.model}`,
      ]) {
        const resolved = operations.resolve(operation, model)
        if (resolved)
          operationTargets.set(operationKey(operation, model), clone(resolved))
      }
    }
  }
  return Object.freeze({
    plugins: Object.freeze(plugins),
    pluginById: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    listings,
    toolViews,
    serverTools: Object.freeze(
      gateway.serverTools().map((value) => clone(value)),
    ),
    servedModels: Object.freeze(servedModels),
    operationTargets,
  })
}

function resolveOperation(
  projection: GatewayProjection,
  operation: ModelOperation,
  model: string,
): { pluginId: string; binding: ModelBinding } | undefined {
  const target = projection.operationTargets.get(operationKey(operation, model))
  return target === undefined ? undefined : clone(target)
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error ? reason : (
      new Error("Waiting for the plugin generation was aborted.")
    )
}

function releasedError(): Error {
  return new Error("Plugin generation lease was released.")
}

/**
 * Stable parent-side facade. All synchronous reads are immutable projection
 * reads; replacing a generation swaps one pointer and leaves acquired leases
 * affined to their original adapter until release.
 */
export class ProjectedPluginGateway implements PluginGateway {
  readonly #listeners = new Set<(event: PluginGatewayEvent) => void>()
  readonly #generations = new Set<GenerationState>()
  readonly #waiters = new Set<IdleWaiter>()
  readonly #operations: OperationDispatch
  /** A cutover coordinator owns event publication ordering for this facade. */
  readonly #externalEvents: boolean
  #active: GenerationState
  #disposed = false

  /**
   * With `externalEvents`, a generation's own events only refresh its
   * projection. They reach subscribers solely through `publishEvent`, so a
   * publisher (the cutover coordinator) can order pre-install buffered events,
   * the durable diff, and post-install events without any bypass.
   */
  constructor(
    gateway: PluginGateway,
    generationId = "generation-1",
    options: { externalEvents?: boolean } = {},
  ) {
    this.#externalEvents = options.externalEvents === true
    const state = this.#makeGeneration(gateway, generationId)
    this.#active = state
    this.#generations.add(state)
    this.#operations = this.#operationView(() => this.#active)
  }

  /** Identity of the generation that newly acquired leases are bound to. */
  currentGenerationId(): string {
    return this.#active.id
  }

  /**
   * Atomically make `gateway` the source of all newly acquired leases. Leases
   * already acquired stay on their original gateway until released. The id of
   * a superseded generation cannot be reused, except to re-install the active
   * generation's own selection on a fresh gateway (post-commit recovery).
   */
  replaceGeneration(gateway: PluginGateway, generationId: string): void {
    if (this.#disposed) throw new Error("Projected plugin gateway is disposed.")
    if (
      [...this.#generations].some(
        (state) =>
          !state.disposed
          && state.id === generationId
          && (state !== this.#active || state.gateway === gateway),
      )
    ) {
      throw new Error(`Plugin generation "${generationId}" already exists.`)
    }
    const next = this.#makeGeneration(gateway, generationId)
    const previous = this.#active
    this.#generations.add(next)
    this.#active = next
    previous.active = false
    previous.unsubscribe()
    this.#retireIfIdle(previous)
    this.#notifyWaiters()
  }

  /**
   * Deliver one event (for example a cutover diff) to every subscriber. The
   * active projection is re-read first, so a subscriber reacting to the event
   * never sees a projection older than the event it was told about.
   */
  publishEvent(event: PluginGatewayEvent): void {
    if (this.#disposed) return
    if (this.#active.active)
      this.#active.projection = freezeProjection(this.#active.gateway)
    for (const listener of this.#listeners) {
      try {
        listener(clone(event))
      } catch {
        // Observers cannot break projection updates.
      }
    }
  }

  generationDiagnostics(): Array<ProjectedGenerationDiagnostics> {
    return [...this.#generations].map((state) => ({
      generationId: state.id,
      active: state.active,
      refs: state.refs,
      disposed: state.disposed,
    }))
  }

  /**
   * Resolve once every superseded gateway with this generation id has no
   * leases left (a gateway no longer tracked counts as idle). Rejects when
   * `signal` aborts; the wait itself never retires anything.
   */
  waitForGenerationIdle(
    generationId: string,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<void> {
    return this.#waitFor(
      (state) => state.id === generationId,
      false,
      options.signal,
    )
  }

  /** Like `waitForGenerationIdle`, but also waits for `dispose()` to finish. */
  waitForGenerationDisposed(
    generationId: string,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<void> {
    return this.#waitFor(
      (state) => state.id === generationId,
      true,
      options.signal,
    )
  }

  /** Identity-exact variant for a specific gateway object. */
  waitForGatewayIdle(
    gateway: PluginGateway,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<void> {
    return this.#waitFor(
      (state) => state.gateway === gateway,
      false,
      options.signal,
    )
  }

  /** True while `gateway` is the one newly acquired leases bind to. */
  isActiveGateway(gateway: PluginGateway): boolean {
    return this.#active.gateway === gateway && this.#active.active
  }

  acquireGeneration(): PluginGenerationLease {
    const state = this.#active
    state.refs += 1
    let released = false
    const live = () => {
      if (released) throw releasedError()
    }
    return {
      generationId: state.id,
      get: (id) => {
        live()
        const value = state.projection.pluginById.get(id)
        return value === undefined ? undefined : clone(value)
      },
      listTools: (pluginId) => {
        live()
        return this.#projectedList(state.projection.listings, pluginId)
      },
      toolViews: (pluginId) => {
        live()
        return this.#projectedList(state.projection.toolViews, pluginId)
      },
      serverTools: () => {
        live()
        return state.projection.serverTools.map((value) => clone(value))
      },
      operations: () => {
        live()
        return this.#operationView(() => state)
      },
      // eslint-disable-next-line max-params -- implements PluginGenerationLease.callTool
      callTool: async (pluginId, name, input, call) => {
        live()
        return await state.gateway.callTool(pluginId, name, input, call)
      },
      prepareServerTool: async (pluginId, name, input) => {
        live()
        return await state.gateway.prepareServerTool(pluginId, name, input)
      },
      release: () => {
        if (released) return
        released = true
        state.refs -= 1
        this.#retireIfIdle(state)
      },
    }
  }

  async reconcile(settings: PluginSettings | undefined): Promise<void> {
    await this.#command((gateway) => gateway.reconcile(settings))
  }

  list(): Array<PluginSnapshot> {
    return this.#active.projection.plugins.map((value) => clone(value))
  }

  get(id: string): PluginSnapshot | undefined {
    const value = this.#active.projection.pluginById.get(id)
    return value === undefined ? undefined : clone(value)
  }

  listTools(pluginId: string): Array<PluginToolListing> {
    return this.#projectedList(this.#active.projection.listings, pluginId)
  }

  toolViews(pluginId: string): Array<PluginToolView> {
    return this.#projectedList(this.#active.projection.toolViews, pluginId)
  }

  // eslint-disable-next-line max-params -- implements PluginGateway.callTool
  async callTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    const lease = this.acquireGeneration()
    try {
      return await lease.callTool(pluginId, name, input, call)
    } finally {
      lease.release()
    }
  }

  operations(): OperationDispatch {
    return this.#operations
  }

  serverTools(): Array<ServerToolView> {
    return this.#active.projection.serverTools.map((value) => clone(value))
  }

  async prepareServerTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<PreparedServerTool> {
    const lease = this.acquireGeneration()
    try {
      const prepared = await lease.prepareServerTool(pluginId, name, input)
      let finished = false
      const release = () => {
        if (finished) return
        finished = true
        prepared.release()
        lease.release()
      }
      return {
        ...prepared,
        execute: async (call) => {
          if (finished)
            throw new Error("Prepared server tool was already consumed.")
          finished = true
          try {
            return await prepared.execute(call)
          } finally {
            prepared.release()
            lease.release()
          }
        },
        release,
      }
    } catch (error) {
      lease.release()
      throw error
    }
  }

  // eslint-disable-next-line max-params -- implements PluginGateway.callServerTool
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
    await this.#command((gateway) =>
      gateway.runAction(pluginId, actionId, signal),
    )
  }

  async updateConfig(pluginId: string, config: unknown): Promise<void> {
    await this.#command((gateway) => gateway.updateConfig(pluginId, config))
  }

  async setToolPermissions(
    pluginId: string,
    changes: Record<string, ToolPermission | null>,
  ): Promise<void> {
    await this.#command((gateway) =>
      gateway.setToolPermissions(pluginId, changes),
    )
  }

  async importLegacyConfig(
    pluginId: string,
    config: unknown,
  ): Promise<boolean> {
    return await this.#command((gateway) =>
      gateway.importLegacyConfig(pluginId, config),
    )
  }

  subscribe(listener: (event: PluginGatewayEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const disposals: Array<Promise<void>> = []
    for (const state of this.#generations) {
      state.active = false
      state.unsubscribe()
      state.disposed = true
      state.disposal ??= state.gateway.dispose()
      disposals.push(state.disposal)
    }
    this.#listeners.clear()
    await Promise.all(disposals)
    for (const state of this.#generations) state.settled = true
    this.#generations.clear()
    this.#notifyWaiters()
  }

  #makeGeneration(gateway: PluginGateway, id: string): GenerationState {
    const state: GenerationState = {
      id,
      gateway,
      projection: freezeProjection(gateway),
      refs: 0,
      active: true,
      disposed: false,
      disposal: undefined,
      settled: false,
      unsubscribe: () => {},
    }
    state.unsubscribe = gateway.subscribe((event) => {
      if (!state.active || this.#disposed) return
      state.projection = freezeProjection(gateway)
      if (this.#externalEvents) return
      for (const listener of this.#listeners) {
        try {
          listener(clone(event))
        } catch {
          // Observers cannot break projection updates.
        }
      }
    })
    return state
  }

  #operationView(select: () => GenerationState): OperationDispatch {
    return {
      resolve: (operation, model) =>
        resolveOperation(select().projection, operation, model),
      prepare: (operation, model) =>
        this.#prepareOperation(select(), operation, model),
      dispatch: async (request) => {
        const prepared = this.#prepareOperation(
          select(),
          request.operation,
          request.model,
        )
        if (!prepared) {
          throw new OperationUnavailableError(request.operation, request.model)
        }
        try {
          return await prepared.execute({
            body: request.body,
            signal: request.signal,
            invocationId: request.invocationId,
            providerCallId: request.providerCallId,
            sequence: request.sequence,
            origin: request.origin,
          })
        } finally {
          prepared.release()
        }
      },
      servedModels: () =>
        select().projection.servedModels.map((value) => clone(value)),
      subscribe: (listener) =>
        this.subscribe((event) => {
          if (event.type === "lifecycle" || event.type === "inventory")
            listener()
        }),
    }
  }

  #prepareOperation(
    state: GenerationState,
    operation: ModelOperation,
    model: string,
  ): PreparedOperation | undefined {
    const projected = resolveOperation(state.projection, operation, model)
    if (!projected) return undefined
    state.refs += 1
    const prepared = state.gateway.operations().prepare(operation, model)
    if (!prepared) {
      state.refs -= 1
      this.#retireIfIdle(state)
      return undefined
    }
    let released = false
    return {
      operation,
      model,
      pluginId: prepared.pluginId,
      binding: clone(prepared.binding),
      execute: (request) => {
        if (released) return Promise.reject(releasedError())
        return prepared.execute(request)
      },
      release: () => {
        if (released) return
        released = true
        prepared.release()
        state.refs -= 1
        this.#retireIfIdle(state)
      },
    }
  }

  async #command<T>(run: (gateway: PluginGateway) => Promise<T>): Promise<T> {
    const state = this.#active
    state.refs += 1
    let outcome:
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown }
    try {
      outcome = { ok: true, value: await run(state.gateway) }
    } catch (error) {
      outcome = { ok: false, error }
    }

    let projectionError: unknown
    try {
      if (state.active) state.projection = freezeProjection(state.gateway)
    } catch (error) {
      projectionError = error
    } finally {
      state.refs -= 1
      this.#retireIfIdle(state)
    }

    if (!outcome.ok) {
      if (projectionError !== undefined) {
        throw new AggregateError(
          [outcome.error, projectionError],
          "Plugin command and projection refresh both failed.",
        )
      }
      throw outcome.error
    }
    if (projectionError instanceof Error) throw projectionError
    if (projectionError !== undefined)
      throw new Error("Plugin projection refresh failed.", {
        cause: projectionError,
      })
    return outcome.value
  }

  #projectedList<T>(
    values: ReadonlyMap<string, ReadonlyArray<T>>,
    pluginId: string,
  ): Array<T> {
    const found = values.get(pluginId)
    if (found) return found.map((value) => clone(value))
    throw new PluginGatewayError(
      "unknown-plugin",
      pluginId,
      `Unknown plugin "${pluginId}".`,
    )
  }

  #retireIfIdle(state: GenerationState): void {
    if (state.active || state.refs !== 0 || state.disposed) {
      this.#notifyWaiters()
      return
    }
    state.disposed = true
    const disposal = state.gateway.dispose().catch(() => undefined)
    state.disposal = disposal
    this.#notifyWaiters()
    void disposal.then(() => {
      state.settled = true
      this.#generations.delete(state)
      this.#notifyWaiters()
    })
  }

  #waitFor(
    matches: (state: GenerationState) => boolean,
    wantDisposed: boolean,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal))
        return
      }
      const waiter: IdleWaiter = {
        matches,
        wantDisposed,
        settle: () => {
          signal?.removeEventListener("abort", onAbort)
          this.#waiters.delete(waiter)
          resolve()
        },
      }
      const onAbort = (): void => {
        this.#waiters.delete(waiter)
        reject(abortReason(signal))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.#waiters.add(waiter)
      this.#notifyWaiters()
    })
  }

  #notifyWaiters(): void {
    for (const waiter of this.#waiters) {
      const pinned = [...this.#generations].some(
        (state) =>
          waiter.matches(state)
          && (state.active
            || state.refs !== 0
            || (waiter.wantDisposed && !state.settled)),
      )
      if (!pinned) waiter.settle()
    }
  }
}
