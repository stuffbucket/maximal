/**
 * The `operations` app service: a registry of `(operation, provider,
 * upstreamModel)` → handler, filled by capability plugins through
 * `ctx.operations` and read by the app core through the gateway's
 * `OperationDispatch`. Install it with `services.extra: [operationsService]`.
 */
import type { Context } from "@deepseek-ai/cordis"

import { Service } from "@deepseek-ai/cordis"

import type {
  ModelBinding,
  ModelOperation,
  OperationDispatch,
  OperationHandler,
  OperationRegistry,
  OperationRequest,
  OperationResult,
  ServedModel,
} from "../operations"
import type { PluginDisposer } from "../types"
import type { PluginServiceFactory } from "./services"
import type { PluginRuntime } from "./state"

import { PluginContractError } from "../errors"
import { OperationUnavailableError } from "../gateway"
import { MODEL_OPERATIONS } from "../operations"

type Binding = { model: string } & ModelBinding

interface Entry {
  readonly pluginId: string
  readonly handler: OperationHandler
  readonly bindings: ReadonlyArray<Binding>
}

const kCore = Symbol("maximal.plugin.operations")
const kRuntime = Symbol("maximal.plugin.operations.runtime")

const keyOf = (operation: string, binding: ModelBinding): string =>
  JSON.stringify([operation, binding.provider, binding.upstreamModel])

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function invalid(pluginId: string, message: string): PluginContractError {
  return new PluginContractError(
    "invalid-operation",
    `Plugin "${pluginId}" ${message}`,
    { pluginId },
  )
}

function normalize(pluginId: string, handler: OperationHandler): Entry {
  if (
    !(MODEL_OPERATIONS as ReadonlyArray<unknown>).includes(handler.operation)
  ) {
    throw invalid(
      pluginId,
      `operations.register() needs one of: ${MODEL_OPERATIONS.join(", ")}.`,
    )
  }
  if (typeof handler.handle !== "function") {
    throw invalid(
      pluginId,
      `operation "${handler.operation}" needs a handle() function.`,
    )
  }
  const declared: unknown = handler.bindings
  if (!Array.isArray(declared) || declared.length === 0) {
    throw invalid(
      pluginId,
      `operation "${handler.operation}" needs at least one binding.`,
    )
  }
  const bindings = handler.bindings.map((binding): Binding => {
    if (
      !nonEmpty(binding.model)
      || !nonEmpty(binding.provider)
      || !nonEmpty(binding.upstreamModel)
      || binding.provider.includes("/")
    ) {
      throw invalid(
        pluginId,
        `operation "${handler.operation}" has an invalid binding: it needs a model, a provider (without "/") and an upstreamModel.`,
      )
    }
    return {
      model: binding.model,
      provider: binding.provider,
      upstreamModel: binding.upstreamModel,
    }
  })
  return { pluginId, handler, bindings }
}

/** Plain registry state (no cordis): entries, resolution, change listeners. */
class OperationsCore implements OperationDispatch {
  readonly #entries = new Set<Entry>()
  readonly #listeners = new Set<() => void>()

  /** Throws `duplicate-operation` if any binding of `entry` is already served. */
  add(entry: Entry): void {
    const taken = new Map<string, string>()
    for (const other of this.#entries) {
      for (const binding of other.bindings) {
        taken.set(keyOf(other.handler.operation, binding), other.pluginId)
      }
    }
    const own = new Set<string>()
    for (const binding of entry.bindings) {
      const key = keyOf(entry.handler.operation, binding)
      const owner = taken.get(key)
      if (owner !== undefined || own.has(key)) {
        throw new PluginContractError(
          "duplicate-operation",
          `Plugin "${entry.pluginId}" cannot serve ${entry.handler.operation} for ${binding.provider}/${binding.upstreamModel}: ${
            owner === undefined ?
              "it lists that binding twice"
            : `plugin "${owner}" already does`
          }.`,
          { pluginId: entry.pluginId },
        )
      }
      own.add(key)
    }
    this.#entries.add(entry)
    this.#notify()
  }

  /** Idempotent. */
  remove(entry: Entry): void {
    if (this.#entries.delete(entry)) this.#notify()
  }

  resolve(
    operation: ModelOperation,
    model: string,
  ): { pluginId: string; binding: ModelBinding } | undefined {
    const matches: Array<{
      entry: Entry
      binding: Binding
      exact: boolean
    }> = []
    for (const entry of this.#entries) {
      if (entry.handler.operation !== operation) continue
      for (const binding of entry.bindings) {
        if (`${binding.provider}/${binding.model}` === model) {
          matches.push({ entry, binding, exact: true })
        } else if (binding.model === model) {
          matches.push({ entry, binding, exact: false })
        }
      }
    }
    const exact = matches.filter((match) => match.exact)
    const found = exact.length > 0 ? exact[0] : this.#only(matches)
    if (!found) return undefined
    return {
      pluginId: found.entry.pluginId,
      binding: {
        provider: found.binding.provider,
        upstreamModel: found.binding.upstreamModel,
      },
    }
  }

  #only<T>(matches: ReadonlyArray<T>): T | undefined {
    return matches.length === 1 ? matches[0] : undefined
  }

  async dispatch(
    request: Omit<OperationRequest, "binding">,
  ): Promise<OperationResult> {
    const resolved = this.resolve(request.operation, request.model)
    if (!resolved) {
      throw new OperationUnavailableError(request.operation, request.model)
    }
    const key = keyOf(request.operation, resolved.binding)
    for (const entry of this.#entries) {
      if (entry.pluginId !== resolved.pluginId) continue
      if (
        entry.handler.operation === request.operation
        && entry.bindings.some((b) => keyOf(request.operation, b) === key)
      ) {
        return await entry.handler.handle({
          ...request,
          binding: resolved.binding,
        })
      }
    }
    throw new OperationUnavailableError(request.operation, request.model)
  }

  servedModels(): ReadonlyArray<ServedModel> {
    const served = new Map<
      string,
      { model: string; operations: Array<ModelOperation> } & ModelBinding
    >()
    for (const entry of this.#entries) {
      for (const binding of entry.bindings) {
        const key = JSON.stringify([
          binding.model,
          binding.provider,
          binding.upstreamModel,
        ])
        const existing = served.get(key)
        if (existing) {
          if (!existing.operations.includes(entry.handler.operation))
            existing.operations.push(entry.handler.operation)
        } else {
          served.set(key, {
            model: binding.model,
            provider: binding.provider,
            upstreamModel: binding.upstreamModel,
            operations: [entry.handler.operation],
          })
        }
      }
    }
    return [...served.values()]
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {
        // A failing observer never breaks registration.
      }
    }
  }
}

class OperationsService
  extends Service
  implements OperationRegistry, OperationDispatch
{
  declare [kCore]: OperationsCore;
  declare [kRuntime]: PluginRuntime

  constructor(ctx: Context, runtime: PluginRuntime) {
    super(ctx, "operations")
    this[kCore] = new OperationsCore()
    this[kRuntime] = runtime
  }

  register(handler: OperationHandler): PluginDisposer {
    const core = this[kCore]
    const slot = this[kRuntime].slotOf(this.ctx, "operations")
    const entry = normalize(slot.id, handler)
    // Throws on a duplicate before any effect is created.
    core.add(entry)
    let disposeEffect: (() => unknown) | undefined
    const withdraw = () => core.remove(entry)
    try {
      disposeEffect = this.ctx.effect(
        () => withdraw,
        `operations.register(${handler.operation})`,
      )
    } catch (error) {
      withdraw()
      throw error
    }
    const release = disposeEffect
    return () => {
      withdraw()
      void Promise.resolve(release()).catch(() => {})
    }
  }

  resolve(operation: ModelOperation, model: string) {
    return this[kCore].resolve(operation, model)
  }

  dispatch(request: Omit<OperationRequest, "binding">) {
    return this[kCore].dispatch(request)
  }

  servedModels() {
    return this[kCore].servedModels()
  }

  subscribe(listener: () => void) {
    return this[kCore].subscribe(listener)
  }
}

/** `services.extra` factory for the `operations` service. */
export const operationsService: PluginServiceFactory = (root, runtime) =>
  new OperationsService(root, runtime)

/**
 * The dispatch view of an installed `operations` service (the host's root
 * context), or undefined when the host did not install it.
 */
export function operationDispatchOf(root: Context): OperationDispatch {
  return {
    resolve: (operation, model) =>
      dispatchTarget(root)?.resolve(operation, model),
    dispatch: (request) => {
      const target = dispatchTarget(root)
      return target ?
          target.dispatch(request)
        : Promise.reject(
            new OperationUnavailableError(request.operation, request.model),
          )
    },
    servedModels: () => dispatchTarget(root)?.servedModels() ?? [],
    subscribe: (listener) =>
      dispatchTarget(root)?.subscribe(listener) ?? (() => {}),
  }
}

function dispatchTarget(root: Context): OperationDispatch | undefined {
  return root.get("operations") as unknown as OperationDispatch | undefined
}
