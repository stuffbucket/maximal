import type { JsonValue } from "@stuffbucket/maximal-plugin-protocol"
import type {
  PluginGateway,
  PluginSettings,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import {
  HostGenerationResourceLifecycle,
  ManagedPluginResourceLifecycle,
} from "@stuffbucket/maximal-plugin-host"
import {
  normalizeResourceDeclaration,
  type PluginLifecycleContext,
  type PluginResourceDeclaration,
  type PluginResourceLifecycle,
  type PluginResourceView,
} from "@stuffbucket/maximal-plugin-sdk"

import type { DurableExclusiveResourceManager } from "../exclusive-resource-cutover"
import type {
  CandidateReady,
  ControlPlaneFence,
  GenerationActivationDeclaration,
  GenerationEvent,
  GenerationRunner,
  PluginHealth,
} from "../generation-cutover"
import type { PluginGenerationLifecycleRegistry } from "../generation-lifecycle"
import type { ParentHostServiceBroker } from "../host-service-broker"
import type { ParentProviderBroker } from "../provider-broker"
import type { PluginStateBroker } from "../state-broker"
import type {
  GenerationSelection,
  PreparedRunnerSnapshot,
  RunnerChannelFactory,
  RunnerCommandEnvironment,
  RunnerContainmentHooks,
  RunnerProcessSpawner,
} from "./contracts"
import type { PluginRunnerSupervisorConfig } from "./supervisor"

import { DuplexRpcDispatcher } from "../transport/dispatcher"
import { GATEWAY_RPC } from "../transport/gateway-codec"
import { BunIpcTransport } from "../transport/ipc"
import { registerParentBrokers } from "../transport/parent-brokers"
import { RunnerProcessIpcPort } from "../transport/ports"
import {
  projectionFromJson,
  TransportPluginGateway,
} from "../transport/remote-gateway"
import { PluginRunnerSupervisor } from "./supervisor"

const RESOURCE_PLUGIN_ID = "runner-generation"
const ADOPT_DEADLINE_MS = 10_000

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : (
      new Error(
        typeof reason === "string" ? reason : "Plugin generation wait aborted.",
      )
    )
}

/** Thrown when the control plane moved after a candidate fixed its fence. */
export class StaleGenerationFenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StaleGenerationFenceError"
  }
}

function resourceViews(value: JsonValue): Array<PluginResourceView> {
  if (!Array.isArray(value))
    throw new TypeError("Runner resource list is invalid.")
  return value.map((entry): PluginResourceView => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      throw new TypeError("Runner resource view is invalid.")
    const { pluginId, declaration, phase } = entry
    if (typeof pluginId !== "string" || typeof phase !== "string")
      throw new TypeError("Runner resource view is invalid.")
    return {
      pluginId,
      declaration: normalizeResourceDeclaration(pluginId, declaration),
      phase: phase as PluginResourceView["phase"],
    }
  })
}

type ResourceStep = "prepare" | "commit" | "revoke" | "resume"

const RESOURCE_METHOD: Readonly<Record<ResourceStep, string>> = {
  prepare: GATEWAY_RPC.resourcePrepare,
  commit: GATEWAY_RPC.resourceCommit,
  revoke: GATEWAY_RPC.resourceRevoke,
  resume: GATEWAY_RPC.resourceResume,
}

/**
 * Parent-side lifecycle hooks that forward one generation-wide resource step
 * to its runner process. The declaration is the union of the runner's plugin
 * declarations and is refreshed after every step.
 */
class RemoteResourceHooks implements PluginResourceLifecycle {
  readonly #dispatcher: () => DuplexRpcDispatcher
  #views: Array<PluginResourceView> = []

  constructor(dispatcher: () => DuplexRpcDispatcher) {
    this.#dispatcher = dispatcher
  }

  get declaration(): PluginResourceDeclaration {
    const resources = [
      ...new Set(
        this.#views.flatMap((view) =>
          view.declaration.mode === "exclusive" ?
            view.declaration.resources
          : [],
        ),
      ),
    ].sort()
    return resources.length === 0 ?
        { mode: "overlap-safe" }
      : { mode: "exclusive", resources }
  }

  views(): ReadonlyArray<PluginResourceView> {
    return this.#views
  }

  async refresh(): Promise<void> {
    this.#views = resourceViews(
      await this.#dispatcher().call(GATEWAY_RPC.resourceList, {}),
    )
  }

  prepare(context: PluginLifecycleContext): Promise<void> {
    return this.#step("prepare", context)
  }

  commit(context: PluginLifecycleContext): Promise<void> {
    return this.#step("commit", context)
  }

  revoke(context: PluginLifecycleContext): Promise<void> {
    return this.#step("revoke", context)
  }

  resume(context: PluginLifecycleContext): Promise<void> {
    return this.#step("resume", context)
  }

  async #step(
    step: ResourceStep,
    context: PluginLifecycleContext,
  ): Promise<void> {
    await this.#dispatcher().call(
      RESOURCE_METHOD[step],
      { deadline: context.deadline, purpose: context.purpose },
      { signal: context.signal },
    )
    await this.refresh()
  }
}

/** Collapse a plugin list into the cutover coordinator's health vocabulary. */
export function pluginHealth(
  plugins: ReadonlyArray<{
    id: string
    lifecycle: string
    error?: string
    status?: { code: string }
  }>,
): Array<PluginHealth> {
  return plugins.map((plugin): PluginHealth => {
    const detail = plugin.error === undefined ? {} : { detail: plugin.error }
    if (plugin.lifecycle === "waiting")
      return { pluginId: plugin.id, state: "waiting", ...detail }
    if (plugin.lifecycle === "failed")
      return { pluginId: plugin.id, state: "failed", ...detail }
    if (plugin.status?.code === "signed-out")
      return { pluginId: plugin.id, state: "signed-out" }
    if (plugin.status?.code === "needs-setup")
      return { pluginId: plugin.id, state: "needs-setup" }
    return { pluginId: plugin.id, state: "active" }
  })
}

export interface ChildGenerationDeps {
  readonly selection: GenerationSelection
  readonly command: RunnerCommandEnvironment
  readonly spawner: RunnerProcessSpawner
  readonly channelFactory: RunnerChannelFactory
  readonly containment: RunnerContainmentHooks
  readonly lifecycle: PluginGenerationLifecycleRegistry
  readonly supervisorConfig?: Partial<PluginRunnerSupervisorConfig>
  /**
   * Activate during `prepare` (a recovery candidate with no exclusive
   * resources). Otherwise the cutover activates it at the durable boundary,
   * after any exclusive resources are bound and before the pointer moves.
   */
  readonly activateOnPrepare?: boolean
  readonly state: PluginStateBroker & { cachedEpoch(): number }
  readonly provider: ParentProviderBroker
  readonly host: ParentHostServiceBroker
  readonly resources: DurableExclusiveResourceManager<JsonValue>
  /** Evaluated at prepare time so a candidate starts from today's desired state. */
  readonly desiredSettings: () => PluginSettings | undefined
  /** Pointer and lease observability owned by the stable parent gateway. */
  readonly projection: {
    isActive(gateway: PluginGateway): boolean
    waitForIdle(gateway: PluginGateway, signal?: AbortSignal): Promise<void>
  }
}

export interface ChildGenerationDiagnostics {
  readonly generationId: string
  readonly installed: boolean
  readonly activated: boolean
  readonly stopped: boolean
  readonly pid?: number
  readonly availability: string
}

/**
 * One generation's process, transport gateway, and resource lifecycle. It is
 * the `GenerationRunner` the cutover coordinator drives for N and N+1.
 * Process isolation here is crash/containment isolation for plugin code, not a
 * security sandbox: the child runs with the parent's user privileges.
 */
export class ChildGeneration implements GenerationRunner<
  JsonValue,
  TransportPluginGateway
> {
  readonly generationId: string
  readonly artifactId: string
  readonly #deps: ChildGenerationDeps
  readonly #supervisor: PluginRunnerSupervisor
  readonly #listeners = new Set<(event: GenerationEvent) => void>()
  readonly #hooks: RemoteResourceHooks
  readonly #slot: ManagedPluginResourceLifecycle
  readonly #lifecycle: HostGenerationResourceLifecycle
  readonly #unregisterResources: () => void
  #dispatcher: DuplexRpcDispatcher | undefined
  #unregisterBrokers: (() => void) | undefined
  #gateway: TransportPluginGateway | undefined
  #prepared: Promise<PreparedRunnerSnapshot> | undefined
  #unsubscribeGateway: (() => void) | undefined
  #sequence = 1
  #revision = 0
  #announceWhenActive = false
  #installed = false
  #activated = false
  #activation: Promise<void> | undefined
  #shutdown: Promise<void> | undefined
  #stop: Promise<void> | undefined

  constructor(deps: ChildGenerationDeps) {
    this.#deps = deps
    const { token } = deps.selection
    this.generationId = token.generationId
    this.artifactId = token.manifestSha256
    this.#hooks = new RemoteResourceHooks(() => {
      if (!this.#dispatcher)
        throw new Error("Runner RPC transport is unavailable.")
      return this.#dispatcher
    })
    this.#slot = new ManagedPluginResourceLifecycle({
      pluginId: RESOURCE_PLUGIN_ID,
      generationId: this.generationId,
      hooks: this.#hooks,
      leases: deps.resources.leases,
    })
    this.#lifecycle = new HostGenerationResourceLifecycle({
      slots: () => [this.#slot],
      overlapSafe: () => [],
    })
    this.#unregisterResources = deps.resources.registerGeneration(
      this.generationId,
      this.#lifecycle,
    )
    this.#supervisor = new PluginRunnerSupervisor({
      selection: deps.selection,
      command: deps.command,
      spawner: deps.spawner,
      channelFactory: deps.channelFactory,
      containment: deps.containment,
      lifecycle: deps.lifecycle,
      deferActivation: true,
      // Only the serving generation is revived after a crash; a superseded
      // one must never rebind resources its successor owns.
      shouldRestart: () => {
        const gateway = this.#gateway
        return (
          this.#shutdown === undefined
          && this.#installed
          && gateway !== undefined
          && deps.projection.isActive(gateway)
        )
      },
      ...(deps.supervisorConfig === undefined ?
        {}
      : { config: deps.supervisorConfig }),
      stateAuthority: {
        // Dynamic: the control plane may have advanced since this selection.
        currentControlEpoch: () => deps.state.cachedEpoch(),
        validatePrepared: () => undefined,
        installInitial: (snapshot) => this.#installTransport(snapshot),
        activated: () => this.#confirmResources(),
      },
      rpcFactory: (process, nonce) => {
        const transport = new BunIpcTransport(
          new RunnerProcessIpcPort(process),
          { role: "parent", generation: this.generationId, nonce },
        )
        const rpc = new DuplexRpcDispatcher(transport, "parent", {
          onStateEvent: (event) => this.#gateway?.handleStateEvent(event),
          // eslint-disable-next-line max-params -- dispatcher spend event contract
          onSpend: (_callId, invocationId, providerCallId, _amount, evidence) =>
            this.#gateway?.handleSpend(invocationId, providerCallId, evidence),
        })
        this.#dispatcher = rpc
        this.#unregisterBrokers?.()
        this.#unregisterBrokers = registerParentBrokers(rpc, {
          state: deps.state,
          provider: deps.provider,
          host: deps.host,
        })
        return {
          call: (method, params, options) => rpc.call(method, params, options),
          dispose: (reason) => {
            this.#unregisterBrokers?.()
            this.#unregisterBrokers = undefined
            rpc.dispose(reason)
          },
        }
      },
    })
  }

  get gateway(): TransportPluginGateway {
    if (!this.#gateway)
      throw new Error("Plugin generation has no gateway projection yet.")
    return this.#gateway
  }

  /** Aggregated lifecycle declaration; exclusive once any plugin declares it. */
  get activation(): GenerationActivationDeclaration {
    return this.#hooks.declaration
  }

  get installed(): boolean {
    return this.#installed
  }

  /** Activated, and its process is still the serving one. */
  isServing(): boolean {
    return (
      this.#activated
      && this.#shutdown === undefined
      && this.#supervisor.diagnostics().availability === "active"
    )
  }

  diagnostics(): ChildGenerationDiagnostics {
    const runner = this.#supervisor.diagnostics()
    return {
      generationId: this.generationId,
      installed: this.#installed,
      activated: this.#activated,
      stopped: this.#shutdown !== undefined,
      ...(runner.pid === undefined ? {} : { pid: runner.pid }),
      availability: runner.availability,
    }
  }

  // -- initial generation ---------------------------------------------------

  /**
   * Start an initial generation. It follows the candidate protocol so its
   * enabled plugins and their exclusive resources are known before it binds
   * anything: spawn, verify, reconcile desired settings, then activate.
   */
  async start(): Promise<void> {
    this.begin()
    const prepared = this.#prepared as Promise<PreparedRunnerSnapshot>
    await prepared
    await this.gateway.reconcile(this.#deps.desiredSettings())
    this.#startRelay(this.gateway)
    await this.activate()
  }

  // -- GenerationRunner -----------------------------------------------------

  subscribe(listener: (event: GenerationEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Spawn the process and begin verification; completion is awaited by `prepare`. */
  negotiate(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.begin()
    return Promise.resolve()
  }

  /** Idempotently launch the deferred candidate process. */
  begin(): void {
    if (this.#prepared) return
    const prepared = this.#supervisor.prepareCandidate()
    // The failure is observed by `prepare`; avoid an unhandled rejection if
    // the coordinator abandons the candidate first.
    prepared.catch(() => undefined)
    this.#prepared = prepared
  }

  async prepare(
    fence: ControlPlaneFence,
    signal: AbortSignal,
  ): Promise<CandidateReady<JsonValue>> {
    this.begin()
    const prepared = await abortable(
      this.#prepared as Promise<PreparedRunnerSnapshot>,
      signal,
    )
    if (prepared.controlEpoch !== fence.epoch)
      throw new StaleGenerationFenceError(
        `control-plane epoch is stale: candidate prepared at ${prepared.controlEpoch}, fence is ${fence.epoch}`,
      )
    const gateway = this.gateway
    // Settings are reconciled before readiness so N+1 starts from the state N
    // serves. Candidate hosts prepare exclusive resources but do not bind them.
    await abortable(gateway.reconcile(this.#deps.desiredSettings()), signal)
    await abortable(this.#hooks.refresh(), signal)
    if (this.#deps.state.cachedEpoch() !== fence.epoch)
      throw new StaleGenerationFenceError(
        "control-plane epoch is stale: it advanced while the candidate prepared",
      )
    const ready: CandidateReady<JsonValue> = {
      generationId: this.generationId,
      artifactId: this.artifactId,
      fence,
      snapshot: gateway.projectionJson(),
      snapshotRevision: this.#revision,
      snapshotComplete: prepared.complete,
      health: pluginHealth(gateway.list()),
    }
    // Events during prepare are folded into the snapshot above; sequencing
    // starts at READY so the coordinator sees a contiguous stream.
    this.#startRelay(gateway)
    if (this.#deps.activateOnPrepare === true)
      await abortable(this.activate(), signal)
    return ready
  }

  #startRelay(gateway: TransportPluginGateway): void {
    this.#unsubscribeGateway?.()
    this.#unsubscribeGateway = gateway.subscribe((event) => {
      const sequence = this.#sequence++
      if (event.type === "notice") {
        this.#emit({ kind: "notice", sequence, event })
        return
      }
      this.#emit({
        kind: "state",
        sequence,
        revision: ++this.#revision,
        event,
      })
    })
  }

  async requestResync(
    _expectedSequence: number,
    _reason: string,
  ): Promise<void> {
    await this.gateway.refresh()
  }

  /** Wait until nothing pins this generation; abortable and non-destructive. */
  beginDrain(signal: AbortSignal): Promise<void> {
    if (!this.#installed) return Promise.resolve()
    return this.#deps.projection.waitForIdle(this.gateway, signal)
  }

  /**
   * Idempotent. A superseded generation is stopped only after every operation,
   * prepared server tool, and MCP affinity lease has drained; the caller's
   * signal bounds how long the caller waits, never when the process stops.
   * A candidate that never became active, or an active generation being
   * abandoned for recovery, stops at once.
   */
  stop(signal: AbortSignal): Promise<void> {
    this.#stop ??= this.#stopWhenDrained()
    return abortable(this.#stop, signal)
  }

  // -- cutover hooks (called by the manager's projection/journal adapters) --

  markInstalled(): void {
    this.#installed = true
  }

  /** Idempotent: release the candidate to active and adopt its resources. */
  activate(): Promise<void> {
    this.#activation ??= this.#activate()
    return this.#activation
  }

  /**
   * Keep the parent's lease accounting in step with the running generation
   * after plugins were enabled or disabled while it serves. The child has only
   * prepared a late-enabled plugin's exclusive resource; the parent leases it
   * first (a conflict throws before anything binds) and then has the child
   * bind it, so a resource is never held by two generations. Also what lets a
   * later N -> N+1 handoff see and move every resource N owns.
   */
  async syncResources(): Promise<void> {
    if (!this.isServing()) return
    await this.#hooks.refresh()
    await this.#slot.sync({
      purpose: "activation",
      deadline: Date.now() + ADOPT_DEADLINE_MS,
    })
  }

  /** Confirm a restored generation still answers after a failed handoff. */
  async verifyAlive(signal: AbortSignal): Promise<void> {
    await abortable(this.gateway.refresh(), signal)
  }

  /** Immediate shutdown (manager disposal); never waits for gateway leases. */
  shutdown(reason: string): Promise<void> {
    if (this.#shutdown) return this.#shutdown
    const budget = this.#supervisor.shutdown(reason)
    this.#shutdown = this.#supervisor.shutdownSettled().then(() => {
      // A budget timeout does not prove the process tree is gone. Release the
      // singleton leases only after authoritative termination and reaping.
      this.#releaseResources()
      return budget
    })
    return this.#shutdown
  }

  // -------------------------------------------------------------------------

  async #stopWhenDrained(): Promise<void> {
    const gateway = this.#gateway
    if (
      gateway !== undefined
      && this.#installed
      && !this.#deps.projection.isActive(gateway)
    )
      await this.#deps.projection.waitForIdle(gateway)
    await this.shutdown("generation stopped")
  }

  async #activate(): Promise<void> {
    // Lease first, then bind in the child, and only then publish ACTIVE. This is
    // also required for the initial generation, which has no N -> N+1 handoff
    // to acquire its leases on its behalf.
    await this.#adoptResources()
    await this.#supervisor.activateCandidate()
    this.#activated = true
  }

  /**
   * Record the child's committed resources in the parent's shared lease
   * registry. Idempotent for a generation the handoff already committed.
   */
  async #adoptResources(): Promise<void> {
    await this.#hooks.refresh()
    const options = {
      purpose: "activation" as const,
      deadline: Date.now() + ADOPT_DEADLINE_MS,
    }
    await this.#lifecycle.prepare(options)
    await this.#lifecycle.commit(options)
  }

  /**
   * First prepared snapshot: build the transport gateway. A later one is the
   * supervisor reviving this generation's process after a crash (it only does
   * so once the old process tree is proven reaped): rebind the same gateway,
   * restore the desired plugin state, and let the supervisor activate, which
   * re-binds the physical exclusive resources the parent lease still covers.
   */
  #installTransport(
    snapshot: PreparedRunnerSnapshot,
  ): Promise<void> | undefined {
    const dispatcher = this.#dispatcher
    if (!dispatcher) throw new Error("Runner RPC transport is unavailable.")
    const projection = projectionFromJson(snapshot.snapshot)
    const existing = this.#gateway
    if (!existing) {
      this.#gateway = new TransportPluginGateway(
        dispatcher,
        this.generationId,
        projection,
        () => this.shutdown("plugin gateway disposed"),
      )
      return undefined
    }
    existing.rebind(dispatcher, projection)
    return this.#restoreAfterRestart(existing)
  }

  /**
   * Every runner that reports ACTIVE (first activation or a restart) must own
   * each exclusive resource it declares. The parent's lease for a revived
   * generation is still held, so this only confirms the new process bound what
   * the lease covers; it never acquires or releases anything itself.
   */
  async #confirmResources(): Promise<void> {
    const dispatcher = this.#dispatcher
    if (!dispatcher) return
    await this.#hooks.refresh()
    const unbound = this.#hooks
      .views()
      .filter(
        (view) =>
          view.declaration.mode === "exclusive" && view.phase !== "committed",
      )
    if (unbound.length > 0)
      throw new Error(
        `Runner is active without its exclusive resources: ${unbound
          .map((view) => view.pluginId)
          .join(", ")}.`,
      )
    if (this.#announceWhenActive) {
      this.#announceWhenActive = false
      // The stable gateway re-reads this generation and tells its observers.
      this.#gateway?.announce({ type: "inventory", pluginId: "" })
    }
  }

  async #restoreAfterRestart(gateway: TransportPluginGateway): Promise<void> {
    await gateway.reconcile(this.#deps.desiredSettings())
    await this.#hooks.refresh()
    await this.#slot.sync({
      purpose: "activation",
      deadline: Date.now() + ADOPT_DEADLINE_MS,
    })
    // Observers are told only once the revived runner is ACTIVE and has bound
    // its resources (see `#confirmResources`), never while it is PREPARED.
    this.#announceWhenActive = true
  }

  #releaseResources(): void {
    this.#unsubscribeGateway?.()
    this.#unsubscribeGateway = undefined
    this.#deps.resources.leases.release(
      `${this.generationId}/${RESOURCE_PLUGIN_ID}`,
    )
    this.#unregisterResources()
  }

  #emit(event: GenerationEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // A faulty observer cannot break the generation's stream.
      }
    }
  }
}
