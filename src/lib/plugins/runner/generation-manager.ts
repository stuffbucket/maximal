import type { PluginGenerationSelectionToken } from "@stuffbucket/maximal-plugin-loader"
import type { JsonValue } from "@stuffbucket/maximal-plugin-protocol"
import type { ExclusiveResourceLeaseRegistry } from "@stuffbucket/maximal-plugin-sdk"
import type {
  PluginGateway,
  PluginSettings,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { createHash } from "node:crypto"

import type {
  CandidateSpec,
  CutoverOptions,
  CutoverResult,
  DurableGenerationJournal,
  ExclusiveResourceManager,
  GenerationCommitRecord,
  GenerationSupervisor,
  ProjectedGenerationTarget,
  StateBroker,
} from "../generation-cutover"
import type { ParentHostServiceBroker } from "../host-service-broker"
import type { ParentProviderBroker } from "../provider-broker"
import type { PluginStateBroker } from "../state-broker"
import type { TransportPluginGateway } from "../transport/remote-gateway"
import type { ChildGenerationDiagnostics } from "./child-generation"
import type {
  GenerationSelection,
  RunnerChannelFactory,
  RunnerCommandEnvironment,
  RunnerContainmentHooks,
  RunnerProcessSpawner,
} from "./contracts"
import type { PluginRunnerSupervisorConfig } from "./supervisor"

import { DurableExclusiveResourceManager } from "../exclusive-resource-cutover"
import { GenerationCutoverCoordinator } from "../generation-cutover"
import { createDurableGenerationJournal } from "../generation-journal"
import {
  pluginGenerationLifecycle,
  type PluginGenerationLifecycleRegistry,
} from "../generation-lifecycle"
import { selectedGenerationInventoryDigest } from "../generations"
import {
  ProjectedPluginGateway,
  type ProjectedGenerationDiagnostics,
} from "../projected-gateway"
import { ChildGeneration, pluginHealth } from "./child-generation"
import { EpochTrackedStateBroker } from "./epoch-tracker"
import {
  BunRunnerProcessSpawner,
  processRunnerChannelFactory,
  runnerProcessContainment,
} from "./process"

/** Child spawn + verification + READY must fit inside negotiation. */
const DEFAULT_NEGOTIATE_TIMEOUT_MS = 30_000
const DEFAULT_DRAIN_WAIT_MS = 1_000
const DEFAULT_FENCE_RETRIES = 3
const DEFAULT_MARKER_RETRY_MS = 5_000

export interface ProductionGenerationManagerOptions {
  /** Selects the sealed, immutable generation that should be serving now. */
  readonly select: () => Promise<PluginGenerationSelectionToken | undefined>
  readonly command: RunnerCommandEnvironment
  /** The durable control plane (settings, epoch, generation journal). */
  readonly state: PluginStateBroker
  readonly host: ParentHostServiceBroker
  readonly provider: ParentProviderBroker
  /** Defaults to the process-wide production bridge used by MCP affinity. */
  readonly lifecycle?: PluginGenerationLifecycleRegistry
  /** Read at each candidate's prepare so N+1 starts from today's settings. */
  readonly desiredSettings?: () => PluginSettings | undefined
  readonly cutover?: CutoverOptions
  readonly supervisorConfig?: Partial<PluginRunnerSupervisorConfig>
  readonly spawner?: RunnerProcessSpawner
  readonly channelFactory?: RunnerChannelFactory
  readonly containment?: RunnerContainmentHooks
  /** Parent lease registry for exclusive resources (default: a private one). */
  readonly leases?: ExclusiveResourceLeaseRegistry
  /** Retries when the control-plane fence moved under a candidate. */
  readonly fenceRetries?: number
  /** Non-fatal problems (for example unsettled durable markers). */
  readonly log?: (message: string, error: unknown) => void
  /** Delay before retrying unsettled durable markers in the background. */
  readonly markerRetryMs?: number
}

export type GenerationRefreshResult =
  | { readonly status: "unavailable" }
  | { readonly status: "unchanged"; readonly generationId: string }
  | {
      readonly status: "cutover"
      readonly generationId: string
      readonly previousGenerationId: string
      readonly commitId: string
      readonly recovered: boolean
    }

export interface ProductionGenerationDiagnostics {
  readonly activeGenerationId: string
  /** A durable commit of the serving generation whose markers are unsettled. */
  readonly unsettledMarkers?: {
    readonly commitId: string
    readonly error: string
  }
  readonly generations: ReadonlyArray<
    ChildGenerationDiagnostics & {
      readonly refs?: number
      readonly active: boolean
    }
  >
  readonly projected: ReadonlyArray<ProjectedGenerationDiagnostics>
  /** Parent exclusive-resource leases: resource -> `<generation>/<slot>`. */
  readonly resourceLeases: Readonly<Record<string, string>>
}

function digestOf(parts: ReadonlyArray<unknown>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}

function causeChain(error: unknown): Array<string> {
  const messages: Array<string> = []
  let current: unknown = error
  for (let depth = 0; depth < 6 && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      messages.push(current.message)
      current = current.cause
    } else {
      messages.push(typeof current === "string" ? current : "unknown error")
      break
    }
  }
  return messages
}

/** The control plane advanced under a candidate; a retry may succeed. */
function isStaleFence(error: unknown): boolean {
  return causeChain(error).some((message) =>
    /control-plane (?:epoch|revision)/i.test(message),
  )
}

function committedComplete(record: {
  installed?: boolean
  published?: boolean
}): boolean {
  return record.installed === true && record.published === true
}

interface SharedGenerationDeps {
  readonly options: ProductionGenerationManagerOptions
  readonly state: EpochTrackedStateBroker
  readonly resources: DurableExclusiveResourceManager<JsonValue>
  readonly lifecycle: PluginGenerationLifecycleRegistry
  /** Filled once the stable gateway exists; generations only read it later. */
  readonly holder: { gateway?: ProjectedPluginGateway }
}

function createChild(
  shared: SharedGenerationDeps,
  selection: GenerationSelection,
  activateOnPrepare = false,
): ChildGeneration {
  const { options, holder } = shared
  return new ChildGeneration({
    selection,
    activateOnPrepare,
    command: options.command,
    spawner: options.spawner ?? new BunRunnerProcessSpawner(),
    channelFactory: options.channelFactory ?? processRunnerChannelFactory,
    containment: options.containment ?? runnerProcessContainment,
    lifecycle: shared.lifecycle,
    ...(options.supervisorConfig === undefined ?
      {}
    : { supervisorConfig: options.supervisorConfig }),
    state: shared.state,
    provider: options.provider,
    host: options.host,
    resources: shared.resources,
    desiredSettings: options.desiredSettings ?? (() => undefined),
    projection: {
      // Before the stable gateway exists the generation is the only one.
      isActive: (gateway) => holder.gateway?.isActiveGateway(gateway) ?? true,
      waitForIdle: (gateway, signal) =>
        holder.gateway?.waitForGatewayIdle(gateway, { signal })
        ?? Promise.resolve(),
    },
  })
}

async function selectionFor(
  state: EpochTrackedStateBroker,
  token: PluginGenerationSelectionToken,
): Promise<GenerationSelection> {
  return Object.freeze({
    token,
    controlEpoch: state.cachedEpoch(),
    inventoryDigest: await selectedGenerationInventoryDigest(token),
  })
}

/**
 * The stable gateway that routes hold. It owns nothing but the generation
 * pointer; disposing it also stops the manager and every child process.
 */
class ManagedProjectedGateway extends ProjectedPluginGateway {
  readonly manager: ProductionPluginGenerationManager

  constructor(
    gateway: TransportPluginGateway,
    generationId: string,
    manager: ProductionPluginGenerationManager,
  ) {
    // The cutover coordinator sequences every event observers see.
    super(gateway, generationId, { externalEvents: true })
    this.manager = manager
  }

  override reconcile(
    ...args: Parameters<ProjectedPluginGateway["reconcile"]>
  ): Promise<void> {
    return this.manager.runCommand(() => super.reconcile(...args), true)
  }

  override updateConfig(
    ...args: Parameters<ProjectedPluginGateway["updateConfig"]>
  ): Promise<void> {
    return this.manager.runCommand(() => super.updateConfig(...args), true)
  }

  override runAction(
    ...args: Parameters<ProjectedPluginGateway["runAction"]>
  ): Promise<void> {
    return this.manager.runCommand(() => super.runAction(...args), true)
  }

  override setToolPermissions(
    ...args: Parameters<ProjectedPluginGateway["setToolPermissions"]>
  ): Promise<void> {
    return this.manager.runCommand(
      () => super.setToolPermissions(...args),
      false,
    )
  }

  override importLegacyConfig(
    ...args: Parameters<ProjectedPluginGateway["importLegacyConfig"]>
  ): Promise<boolean> {
    return this.manager.runCommand(
      () => super.importLegacyConfig(...args),
      true,
    )
  }

  override async dispose(): Promise<void> {
    await this.manager.beforeGatewayDispose()
    await super.dispose()
  }
}

/** The manager behind a gateway returned by `startProductionPluginGeneration`. */
export function productionGenerationManagerOf(
  gateway: PluginGateway | undefined,
): ProductionPluginGenerationManager | undefined {
  return gateway instanceof ManagedProjectedGateway ?
      gateway.manager
    : undefined
}

/**
 * Long-lived stable parent of the N -> N+1 plugin generation pipeline. It
 * returns one `ProjectedPluginGateway` for the life of the process; each
 * `refresh()` selects the generation that should be serving, builds a fresh
 * candidate against the live control-plane epoch, and hands it to the
 * `GenerationCutoverCoordinator`. Old generations keep serving the leases they
 * already hold and are stopped only after those drain.
 *
 * Each generation runs in its own child process. That contains crashes and
 * lets a generation be replaced; it is not a security sandbox (the child has
 * the parent's privileges).
 */
export class ProductionPluginGenerationManager {
  readonly gateway: ProjectedPluginGateway
  readonly #options: ProductionGenerationManagerOptions
  readonly #shared: SharedGenerationDeps
  readonly #state: EpochTrackedStateBroker
  readonly #resources: DurableExclusiveResourceManager<JsonValue>
  readonly #coordinator: GenerationCutoverCoordinator<
    JsonValue,
    TransportPluginGateway
  >
  readonly #generations = new Set<ChildGeneration>()
  readonly #byId = new Map<string, ChildGeneration>()
  readonly #pending = new Map<string, GenerationSelection>()
  readonly #publishedDiffs = new Set<string>()
  #active: ChildGeneration
  #inflightCommitId: string | undefined
  #unsettledMarkers: { commitId: string; error: string } | undefined
  #markerTimer: ReturnType<typeof setTimeout> | undefined
  #queue: Promise<unknown> = Promise.resolve()
  #commitTail: Promise<void> = Promise.resolve()
  #disposed = false
  #disposal: Promise<void> | undefined

  private constructor(shared: SharedGenerationDeps, initial: ChildGeneration) {
    this.#shared = shared
    this.#options = shared.options
    this.#state = shared.state
    this.#resources = shared.resources
    this.#active = initial
    this.#generations.add(initial)
    this.#byId.set(initial.generationId, initial)
    this.gateway = new ManagedProjectedGateway(
      initial.gateway,
      initial.generationId,
      this,
    )
    shared.holder.gateway = this.gateway
    initial.markInstalled()
    this.#coordinator = new GenerationCutoverCoordinator({
      supervisor: this.#supervisorAdapter(),
      state: this.#stateAdapter(),
      projection: this.#projectionAdapter(),
      resources: this.#resourcesAdapter(),
      journal: this.#journalAdapter(),
      activeRunner: initial,
      activeHealth: pluginHealth(initial.gateway.list()),
      lifecycle: shared.lifecycle,
      options: {
        negotiateTimeoutMs: DEFAULT_NEGOTIATE_TIMEOUT_MS,
        drainWaitMs: DEFAULT_DRAIN_WAIT_MS,
        ...shared.options.cutover,
      },
    })
  }

  /** Start generation N and the manager; `undefined` when nothing is selected. */
  static async start(
    options: ProductionGenerationManagerOptions,
  ): Promise<ProductionPluginGenerationManager | undefined> {
    const token = await options.select()
    if (!token) return undefined
    const state =
      options.state instanceof EpochTrackedStateBroker ?
        options.state
      : new EpochTrackedStateBroker(options.state)
    await state.sync()
    const shared: SharedGenerationDeps = {
      options,
      state,
      resources: new DurableExclusiveResourceManager<JsonValue>(options.leases),
      lifecycle: options.lifecycle ?? pluginGenerationLifecycle,
      holder: {},
    }
    const initial = createChild(shared, await selectionFor(state, token))
    try {
      await initial.start()
    } catch (error) {
      await initial.shutdown("runner startup failed").catch(() => undefined)
      throw error
    }
    const manager = new ProductionPluginGenerationManager(shared, initial)
    await manager.#settleMarkers()
    return manager
  }

  /**
   * Select and cut over to the serving generation, if it changed. Calls are
   * serialized; a failed candidate leaves the current generation untouched.
   */
  refresh(): Promise<GenerationRefreshResult> {
    const run = this.#queue.then(
      () => this.#refresh(),
      () => this.#refresh(),
    )
    this.#queue = run.catch(() => undefined)
    return run
  }

  diagnostics(): ProductionGenerationDiagnostics {
    const projected = this.gateway.generationDiagnostics()
    return {
      activeGenerationId: this.#active.generationId,
      ...(this.#unsettledMarkers === undefined ?
        {}
      : { unsettledMarkers: this.#unsettledMarkers }),
      projected,
      resourceLeases: this.#resources.leases.snapshot(),
      generations: [...this.#generations].map((generation) => {
        const entry = projected.find(
          (item) => item.generationId === generation.generationId,
        )
        return {
          ...generation.diagnostics(),
          active: generation === this.#active,
          ...(entry === undefined ? {} : { refs: entry.refs }),
        }
      }),
    }
  }

  /**
   * Serialize a stable-gateway mutation with generation refresh and disposal.
   * Resource-changing commands settle the exact child they mutated, even when
   * the command partially applies and then rejects.
   */
  runCommand<T>(
    command: () => Promise<T>,
    settleResources: boolean,
  ): Promise<T> {
    const task = (): Promise<T> => this.#runCommand(command, settleResources)
    const run = this.#queue.then(task, task)
    this.#queue = run.catch(() => undefined)
    return run
  }

  /** Called by the stable gateway before it disposes its generations. */
  beforeGatewayDispose(): Promise<void> {
    this.#disposal ??= (async () => {
      this.#disposed = true
      if (this.#markerTimer !== undefined) clearTimeout(this.#markerTimer)
      await this.#queue.catch(() => undefined)
      await Promise.all(
        [...this.#generations].map((generation) =>
          generation.shutdown("plugin gateway disposed").catch(() => undefined),
        ),
      )
    })()
    return this.#disposal
  }

  async #runCommand<T>(
    command: () => Promise<T>,
    settleResources: boolean,
  ): Promise<T> {
    if (this.#disposed) throw new Error("Plugin generations are disposed.")
    const generation = this.#active
    let outcome:
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown }
    try {
      outcome = { ok: true, value: await command() }
    } catch (error) {
      outcome = { ok: false, error }
    }

    if (settleResources) {
      try {
        await generation.syncResources()
      } catch (settlementError) {
        if (!outcome.ok)
          throw new AggregateError(
            [outcome.error, settlementError],
            "Plugin command and exclusive-resource settlement both failed.",
          )
        throw settlementError
      }
    }
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }

  // -- refresh ---------------------------------------------------------------

  async #refresh(): Promise<GenerationRefreshResult> {
    if (this.#disposed) throw new Error("Plugin generations are disposed.")
    // Forget candidates the last attempt already stopped.
    for (const generation of this.#generations) {
      if (generation !== this.#active && generation.diagnostics().stopped)
        this.#generations.delete(generation)
    }
    await this.#settleMarkers()
    const token = await this.#options.select()
    if (!token) return { status: "unavailable" }
    const previous = this.#active
    const resume = await this.#unfinishedCommit(token, previous)
    if (!resume && token.generationId === previous.generationId)
      return { status: "unchanged", generationId: previous.generationId }

    const retries = this.#options.fenceRetries ?? DEFAULT_FENCE_RETRIES
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#cutoverOnce(token, previous, resume)
      } catch (error) {
        if (resume || attempt >= retries || !isStaleFence(error)) throw error
      }
    }
  }

  /** One candidate attempt against a fresh immutable selection and live epoch. */
  async #cutoverOnce(
    token: PluginGenerationSelectionToken,
    previous: ChildGeneration,
    resume: GenerationCommitRecord<JsonValue> | undefined,
  ): Promise<GenerationRefreshResult> {
    await this.#state.sync()
    this.#pending.set(
      token.generationId,
      await selectionFor(this.#state, token),
    )
    const spec = await this.#specFor(token, previous, resume)
    this.#inflightCommitId = spec.commitId
    try {
      const result: CutoverResult =
        await this.#coordinator.prepareAndCutover(spec)
      return {
        status: "cutover",
        generationId: result.generationId,
        previousGenerationId: previous.generationId,
        commitId: result.commitId,
        recovered: result.recovered,
      }
    } finally {
      this.#inflightCommitId = undefined
      this.#pending.delete(token.generationId)
    }
  }

  /** Stable across retries of one selection; an unfinished commit keeps its ids. */
  async #specFor(
    token: PluginGenerationSelectionToken,
    previous: ChildGeneration,
    resume: GenerationCommitRecord<JsonValue> | undefined,
  ): Promise<CandidateSpec> {
    const base = await this.#previousCommitId()
    return {
      commitId:
        resume?.commitId
        ?? digestOf([
          "plugin-generation-commit/1",
          previous.generationId,
          token.generationId,
          token.manifestSha256,
          base,
        ]),
      handoffIdempotencyKey:
        resume?.handoffIdempotencyKey
        ?? digestOf([
          "plugin-generation-handoff/1",
          previous.generationId,
          token.generationId,
          base,
        ]),
      generationId: token.generationId,
      artifactId: token.manifestSha256,
    }
  }

  async #previousCommitId(): Promise<string | null> {
    return (await this.#options.state.committedGeneration())?.commitId ?? null
  }

  /**
   * A durable selection of `token`'s generation that never finished (crash or
   * unknown outcome): finish it instead of starting a second, conflicting one.
   */
  async #unfinishedCommit(
    token: PluginGenerationSelectionToken,
    active: ChildGeneration,
  ): Promise<GenerationCommitRecord<JsonValue> | undefined> {
    const committed = await this.#options.state.committedGeneration()
    const record = committed?.generationRecord as
      | GenerationCommitRecord<JsonValue>
      | undefined
    if (
      !committed
      || !record
      || committedComplete(committed)
      || committed.generationId !== token.generationId
      || record.previousGenerationId !== active.generationId
      || record.generationId === active.generationId
    )
      return undefined
    return record
  }

  /**
   * A durable record already naming the serving generation is finished: its
   * installed/published markers are completed here. A failure keeps the
   * generation serving, is reported, and is retried on every refresh and on a
   * background timer until it settles.
   */
  async #settleMarkers(): Promise<void> {
    if (this.#disposed) return
    const state = this.#options.state
    try {
      const committed = await state.committedGeneration()
      if (committed?.generationId !== this.#active.generationId) {
        this.#unsettledMarkers = undefined
        return
      }
      if (committed.installed !== true)
        await state.markGenerationInstalled(committed.commitId)
      if (committed.published !== true)
        await state.markGenerationPublished(committed.commitId)
      this.#unsettledMarkers = undefined
    } catch (error) {
      this.#unsettledMarkers = {
        commitId: (await this.#previousCommitId().catch(() => null)) ?? "",
        error: error instanceof Error ? error.message : String(error),
      }
      this.#options.log?.(
        "Could not record the serving plugin generation as installed; will retry",
        error,
      )
      this.#scheduleMarkerRetry()
    }
  }

  #scheduleMarkerRetry(): void {
    if (this.#markerTimer !== undefined || this.#disposed) return
    this.#markerTimer = setTimeout(() => {
      this.#markerTimer = undefined
      void this.#settleMarkers()
    }, this.#options.markerRetryMs ?? DEFAULT_MARKER_RETRY_MS)
    this.#markerTimer.unref()
  }

  // -- generation construction ----------------------------------------------

  async #newCandidate(
    selection: GenerationSelection,
    activateOnPrepare = false,
  ): Promise<ChildGeneration> {
    const generation = createChild(this.#shared, selection, activateOnPrepare)
    this.#generations.add(generation)
    this.#byId.set(generation.generationId, generation)
    generation.begin()
    return await Promise.resolve(generation)
  }

  // -- coordinator adapters --------------------------------------------------

  #supervisorAdapter(): GenerationSupervisor<
    JsonValue,
    TransportPluginGateway
  > {
    return {
      spawn: async (spec, signal) => {
        signal.throwIfAborted()
        if (this.#disposed) throw new Error("Plugin generations are disposed.")
        const selection = this.#pending.get(spec.generationId)
        if (!selection)
          throw new Error(
            `No immutable selection exists for generation ${spec.generationId}.`,
          )
        return await this.#newCandidate(selection)
      },
      restartCommitted: async (record, signal) => {
        signal.throwIfAborted()
        if (this.#disposed) throw new Error("Plugin generations are disposed.")
        // The committed generation is restarted against the post-commit epoch.
        await this.#state.sync()
        const known = this.#pending.get(record.generationId)
        const token =
          known?.token
          ?? (await this.#reselect(record.generationId, record.artifactId))
        // With no exclusive resources nothing orders activation, so the
        // restarted generation activates as part of its prepare. Otherwise the
        // resource recovery below activates it once its resources are bound.
        return await this.#newCandidate(
          await selectionFor(this.#state, token),
          record.resources.length === 0,
        )
      },
      restoreActive: async (runner, signal) => {
        if (!(runner instanceof ChildGeneration))
          throw new TypeError("Unknown plugin generation runner.")
        await runner.verifyAlive(signal)
      },
    }
  }

  async #reselect(
    generationId: string,
    artifactId: string,
  ): Promise<PluginGenerationSelectionToken> {
    const token = await this.#options.select()
    if (
      token?.generationId !== generationId
      || token.manifestSha256 !== artifactId
    )
      throw new Error(
        `The committed plugin generation ${generationId} is no longer selectable.`,
      )
    return token
  }

  #stateAdapter(): StateBroker<JsonValue> {
    return {
      readFence: () => ({
        epoch: this.#state.cachedEpoch(),
        settingsRevisions: {},
        providerRevisions: {},
      }),
      // Guard only: the authoritative epoch must equal the fence. The durable
      // commit repeats this check inside the broker's own CAS.
      compareAndSetFence: async (expected) =>
        (await this.#state.sync()) === expected.epoch,
      withCommitLock: (run) => {
        const result = this.#commitTail.then(run, run)
        this.#commitTail = result.then(
          () => undefined,
          () => undefined,
        )
        return result
      },
      // The stable gateway delivers nothing on its own (`externalEvents`), so
      // every event observers see is ordered by the coordinator: buffered
      // pre-install events and the diff first, held post-install events after.
      publishActiveEvent: (_generationId, event) => {
        if (event.kind !== "call") this.gateway.publishEvent(event.event)
      },
      publishCallCallback: () => undefined,
      publishDiff: ({ commitId, events }) => {
        if (this.#publishedDiffs.has(commitId)) return
        this.#publishedDiffs.add(commitId)
        // Queued so a reentrant observer cannot run inside the commit.
        queueMicrotask(() => {
          for (const { event } of events) this.gateway.publishEvent(event)
          this.gateway.publishEvent({ type: "inventory", pluginId: "" })
        })
      },
    }
  }

  #projectionAdapter(): ProjectedGenerationTarget<
    JsonValue,
    TransportPluginGateway
  > {
    return {
      currentGenerationId: () => this.gateway.currentGenerationId(),
      install: ({ generationId, gateway }) => {
        const generation = this.#byId.get(generationId)
        if (generation?.gateway !== gateway)
          throw new Error(
            `Generation ${generationId} is not the prepared candidate.`,
          )
        // A prepared (not yet serving) runner is never exposed: activation
        // completes before the durable commit, so a failure there rolls back.
        if (!generation.isServing())
          throw new Error(
            `Generation ${generationId} is not active; refusing to install it.`,
          )
        // One synchronous step: new leases bind to the candidate from here on;
        // leases already held stay on their original generation.
        this.gateway.replaceGeneration(gateway, generationId)
        generation.markInstalled()
        this.#active = generation
      },
    }
  }

  /**
   * Activation happens exactly at the durable boundary: after the handoff has
   * bound any exclusive resources (the handoff invokes the durable writer last)
   * and before the selection becomes durable.
   */
  #resourcesAdapter(): ExclusiveResourceManager<JsonValue> {
    const resources = this.#resources
    return {
      handoff: (input, signal) => resources.handoff(input, signal),
      recover: async (record, signal) => {
        await resources.recover(record, signal)
        await this.#byId.get(record.generationId)?.activate()
      },
      restoreOld: (generationId, held, signal) =>
        resources.restoreOld(generationId, held, signal),
    }
  }

  #journalAdapter(): DurableGenerationJournal<JsonValue> {
    const base = createDurableGenerationJournal<JsonValue>(this.#state)
    return {
      // Only the in-flight selection is in doubt; a finished one is history.
      committed: async (signal) => {
        const record = await base.committed(signal)
        return record?.commitId === this.#inflightCommitId ? record : undefined
      },
      commitDurably: async (key, record, signal) => {
        // Pre-durable: a candidate that cannot activate is rejected and rolled
        // back with the old generation untouched.
        await this.#byId.get(record.generationId)?.activate()
        return await base.commitDurably(key, record, signal)
      },
      queryDurableCommit: (key, signal) => base.queryDurableCommit(key, signal),
      markInstalled: (commitId, signal) => base.markInstalled(commitId, signal),
      markPublished: (commitId, signal) => base.markPublished(commitId, signal),
    }
  }
}
