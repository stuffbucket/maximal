/* eslint-disable max-lines -- coordinator keeps commit ordering and recovery together */
import type { PluginGatewayEvent } from "@stuffbucket/maximal-plugin-sdk/gateway"

import {
  pluginGenerationLifecycle,
  type PluginGenerationLifecycleRegistry,
} from "./generation-lifecycle"

export type CandidatePhase =
  | "SPAWNED"
  | "NEGOTIATED"
  | "PREPARING"
  | "PREPARED"
  | "COMMITTING"
  | "ACTIVE"

export type ActiveGenerationPhase = "ACTIVE" | "DRAINING" | "STOPPING"

export type PluginHealthState =
  | "active"
  | "resource-ready"
  | "signed-out"
  | "needs-setup"
  | "failed"
  | "waiting"

export interface PluginHealth {
  pluginId: string
  state: PluginHealthState
  detail?: string
}

export interface ControlPlaneFence {
  epoch: number
  settingsRevisions: Readonly<Record<string, number>>
  providerRevisions: Readonly<Record<string, number>>
}

export interface CandidateSpec {
  /** Stable across retries of one selection. */
  commitId: string
  /** Stable resource-handoff key persisted with this durable selection. */
  handoffIdempotencyKey: string
  generationId: string
  artifactId: string
}

export interface CandidateStateEvent {
  kind: "state"
  sequence: number
  revision: number
  event: PluginGatewayEvent
}

export interface CandidateNoticeEvent {
  kind: "notice"
  sequence: number
  event: PluginGatewayEvent
}

export interface CandidateCallEvent {
  kind: "call"
  sequence: number
  callId: string
  value: unknown
}

export type GenerationEvent =
  | CandidateStateEvent
  | CandidateNoticeEvent
  | CandidateCallEvent

export type GenerationActivationDeclaration =
  | { mode: "overlap-safe" }
  | { mode: "exclusive"; resources: ReadonlyArray<string> }

export interface CandidateReady<TSnapshot> {
  generationId: string
  artifactId: string
  fence: ControlPlaneFence
  snapshot: TSnapshot
  snapshotRevision: number
  snapshotComplete: boolean
  health: ReadonlyArray<PluginHealth>
}

export interface GenerationRunner<TSnapshot, TGateway> {
  readonly generationId: string
  readonly artifactId: string
  readonly gateway: TGateway
  /** Aggregated immutable-generation lifecycle declaration. */
  readonly activation: GenerationActivationDeclaration
  subscribe(listener: (event: GenerationEvent) => void): () => void
  negotiate(signal: AbortSignal): Promise<void>
  prepare(
    fence: ControlPlaneFence,
    signal: AbortSignal,
  ): Promise<CandidateReady<TSnapshot>>
  requestResync(expectedSequence: number, reason: string): Promise<void>
  beginDrain(signal: AbortSignal): Promise<void>
  stop(signal: AbortSignal): Promise<void>
}

export interface GenerationSupervisor<TSnapshot, TGateway> {
  spawn(
    spec: CandidateSpec,
    signal: AbortSignal,
  ): Promise<GenerationRunner<TSnapshot, TGateway>>
  restartCommitted(
    record: GenerationCommitRecord<TSnapshot>,
    signal: AbortSignal,
  ): Promise<GenerationRunner<TSnapshot, TGateway>>
  restoreActive(
    runner: GenerationRunner<TSnapshot, TGateway>,
    signal: AbortSignal,
  ): Promise<void>
}

export interface StateBroker<TSnapshot> {
  readFence(): ControlPlaneFence
  /** A guard only: it must not publish or commit staged host metadata. */
  compareAndSetFence(expected: ControlPlaneFence): Promise<boolean>
  withCommitLock<T>(run: () => Promise<T>): Promise<T>
  publishActiveEvent(generationId: string, event: GenerationEvent): void
  publishCallCallback(
    generationId: string,
    callId: string,
    value: unknown,
  ): void
  /**
   * Must be idempotent by commitId and enqueue observer delivery. It must not
   * invoke observers inline, so reentrant callbacks cannot enter the commit.
   */
  publishDiff(input: {
    commitId: string
    previousGenerationId: string
    generationId: string
    snapshot: TSnapshot
    events: ReadonlyArray<CandidateStateEvent | CandidateNoticeEvent>
  }): void
}

export interface ProjectedGenerationTarget<TSnapshot, TGateway> {
  currentGenerationId(): string
  /**
   * One synchronous operation: install snapshot and buffered events, then switch
   * the pointer used by new leases. Existing leases remain pinned by the target.
   */
  install(input: {
    commitId: string
    generationId: string
    gateway: TGateway
    snapshot: TSnapshot
    events: ReadonlyArray<CandidateStateEvent | CandidateNoticeEvent>
  }): void
}

export interface ExclusiveHandoff {
  /** Idempotent; used only while the old generation is still authoritative. */
  rollback(signal: AbortSignal): Promise<void>
  /** Idempotent; forget rollback state after pointer installation. */
  finish(signal: AbortSignal): Promise<void>
}

export type DurableCommitState = "committed" | "not-committed"

export interface ExclusiveResourceManager<TSnapshot> {
  /**
   * On a confirmed pre-durable rejection, this operation has restored the old
   * owner. Ambiguous durable outcomes must be retried with the exact same
   * generation tuple and idempotency key rather than rolled back.
   */
  handoff(
    input: {
      commitId: string
      idempotencyKey: string
      fromGenerationId: string
      toGenerationId: string
      resources: ReadonlyArray<string>
      commitDurably: (idempotencyKey: string) => Promise<DurableCommitState>
      queryDurableCommit: (
        idempotencyKey: string,
      ) => Promise<DurableCommitState>
    },
    signal: AbortSignal,
  ): Promise<ExclusiveHandoff>
  /** Re-grant the already selected generation after a post-commit crash. */
  recover(
    record: GenerationCommitRecord<TSnapshot>,
    signal: AbortSignal,
  ): Promise<void>
  /** Fatal-path restoration when a returned handoff cannot roll back itself. */
  restoreOld(
    generationId: string,
    resources: ReadonlyArray<string>,
    signal: AbortSignal,
  ): Promise<void>
}

export interface GenerationCommitRecord<TSnapshot> {
  commitId: string
  /** Stable resource-handoff key; part of the durable generation selection. */
  handoffIdempotencyKey: string
  previousGenerationId: string
  generationId: string
  artifactId: string
  fence: ControlPlaneFence
  snapshot: TSnapshot
  snapshotRevision: number
  health: ReadonlyArray<PluginHealth>
  previousHealth: ReadonlyArray<PluginHealth>
  resources: ReadonlyArray<string>
  events: ReadonlyArray<CandidateStateEvent | CandidateNoticeEvent>
}

export interface DurableGenerationJournal<TSnapshot> {
  committed(
    signal: AbortSignal,
  ): Promise<GenerationCommitRecord<TSnapshot> | undefined>
  /** Atomically persist this selection under the stable handoff key. */
  commitDurably(
    idempotencyKey: string,
    record: GenerationCommitRecord<TSnapshot>,
    signal: AbortSignal,
  ): Promise<DurableCommitState>
  /** Query the same key after a callback failure or process crash. */
  queryDurableCommit(
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<DurableCommitState>
  markInstalled(commitId: string, signal: AbortSignal): Promise<void>
  markPublished(commitId: string, signal: AbortSignal): Promise<void>
}

export interface CutoverOptions {
  negotiateTimeoutMs?: number
  prepareTimeoutMs?: number
  operationTimeoutMs?: number
  drainTimeoutMs?: number
  /**
   * How long a cutover waits for the old generation to drain before it returns.
   * Draining then continues in the background and the old generation is never
   * stopped while it still has leases. Defaults to `operationTimeoutMs`.
   */
  drainWaitMs?: number
  maxBufferedEvents?: number
  maxBufferedBytes?: number
}

export interface CutoverResult {
  commitId: string
  generationId: string
  candidateHistory: ReadonlyArray<CandidatePhase>
  oldHistory: ReadonlyArray<ActiveGenerationPhase>
  recovered: boolean
}

interface Attempt<TSnapshot, TGateway> {
  readonly spec: CandidateSpec
  readonly runner: GenerationRunner<TSnapshot, TGateway>
  readonly history: Array<CandidatePhase>
  readonly events: Array<CandidateStateEvent | CandidateNoticeEvent>
  unsubscribe: () => void
  expectedSequence: number
  bufferedBytes: number
  firstStateRevision?: number
  lastStateRevision?: number
  protocolFailure?: Error
  ready?: CandidateReady<TSnapshot>
}

const DEFAULT_NEGOTIATE_TIMEOUT_MS = 10_000
const DEFAULT_PREPARE_TIMEOUT_MS = 30_000
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BUFFERED_EVENTS = 1_024
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024

function recordsEqual(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  const rightEntries = Object.entries(right).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

export function fencesEqual(
  left: ControlPlaneFence,
  right: ControlPlaneFence,
): boolean {
  return (
    left.epoch === right.epoch
    && recordsEqual(left.settingsRevisions, right.settingsRevisions)
    && recordsEqual(left.providerRevisions, right.providerRevisions)
  )
}

export function candidateHealthRegression(
  previous: ReadonlyArray<PluginHealth>,
  candidate: ReadonlyArray<PluginHealth>,
): string | undefined {
  const oldById = new Map(previous.map((health) => [health.pluginId, health]))
  for (const health of candidate) {
    if (health.state === "waiting") {
      return `${health.pluginId} is waiting for a dependency.`
    }
    if (
      health.state === "failed"
      && oldById.get(health.pluginId)?.state !== "failed"
    ) {
      return `${health.pluginId} has a new activation failure.`
    }
  }
  return undefined
}

/** A bounded operation exceeded its deadline (as opposed to failing). */
export class GenerationTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GenerationTimeoutError"
  }
}

function timeout<T>(
  promise: Promise<T>,
  options: {
    timeoutMs: number
    controller: AbortController
    label: string
  },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      options.controller.abort(`${options.label} timed out`)
      reject(
        new GenerationTimeoutError(
          `${options.label} timed out after ${options.timeoutMs}ms.`,
        ),
      )
    }, options.timeoutMs)
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function resolveOptions(
  options: CutoverOptions = {},
): Required<CutoverOptions> {
  return {
    negotiateTimeoutMs:
      options.negotiateTimeoutMs ?? DEFAULT_NEGOTIATE_TIMEOUT_MS,
    prepareTimeoutMs: options.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS,
    operationTimeoutMs:
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    drainTimeoutMs: options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
    drainWaitMs:
      options.drainWaitMs
      ?? options.operationTimeoutMs
      ?? DEFAULT_OPERATION_TIMEOUT_MS,
    maxBufferedEvents: options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS,
    maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
  }
}

function candidateError(message: string): Error {
  return new Error(`Candidate rejected: ${message}`)
}

function handoffRecoveryError(error: unknown): unknown {
  if (error === null || typeof error !== "object") return undefined
  return Reflect.get(error, "recoveryError")
}

function emptyHandoff(): ExclusiveHandoff {
  return {
    rollback: () => Promise.resolve(),
    finish: () => Promise.resolve(),
  }
}

function eventBytes(event: GenerationEvent): number {
  try {
    return new TextEncoder().encode(JSON.stringify(event)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Generic N/N+1 coordinator. Transport, artifact construction, plugin internals,
 * and persistence are deliberately outside this module; the five collaborators
 * above are its complete integration boundary.
 */
export class GenerationCutoverCoordinator<TSnapshot, TGateway> {
  readonly #supervisor: GenerationSupervisor<TSnapshot, TGateway>
  readonly #state: StateBroker<TSnapshot>
  readonly #projection: ProjectedGenerationTarget<TSnapshot, TGateway>
  readonly #resources: ExclusiveResourceManager<TSnapshot>
  readonly #journal: DurableGenerationJournal<TSnapshot>
  readonly #lifecycle: PluginGenerationLifecycleRegistry
  readonly #options: Required<CutoverOptions>
  readonly #generationHistories = new Map<
    string,
    Array<ActiveGenerationPhase>
  >()
  readonly #activeSubscriptions = new Map<
    GenerationRunner<TSnapshot, TGateway>,
    () => void
  >()
  readonly #activeCursors = new Map<
    GenerationRunner<TSnapshot, TGateway>,
    { expectedSequence?: number; lastStateRevision?: number }
  >()
  readonly #heldActiveEvents: Array<{
    runner: GenerationRunner<TSnapshot, TGateway>
    event: CandidateStateEvent | CandidateNoticeEvent
  }> = []
  #activeRunner: GenerationRunner<TSnapshot, TGateway>
  #activeHealth: ReadonlyArray<PluginHealth>
  #publicRunner: GenerationRunner<TSnapshot, TGateway>
  #heldActiveBytes = 0
  readonly #pendingHandoffs = new Map<string, ExclusiveHandoff>()
  #commitTail: Promise<void> = Promise.resolve()

  constructor(input: {
    supervisor: GenerationSupervisor<TSnapshot, TGateway>
    state: StateBroker<TSnapshot>
    projection: ProjectedGenerationTarget<TSnapshot, TGateway>
    resources: ExclusiveResourceManager<TSnapshot>
    journal: DurableGenerationJournal<TSnapshot>
    activeRunner: GenerationRunner<TSnapshot, TGateway>
    activeHealth: ReadonlyArray<PluginHealth>
    lifecycle?: PluginGenerationLifecycleRegistry
    options?: CutoverOptions
  }) {
    this.#supervisor = input.supervisor
    this.#state = input.state
    this.#projection = input.projection
    this.#resources = input.resources
    this.#journal = input.journal
    this.#lifecycle = input.lifecycle ?? pluginGenerationLifecycle
    this.#activeRunner = input.activeRunner
    this.#activeHealth = input.activeHealth
    this.#publicRunner = input.activeRunner
    this.#options = resolveOptions(input.options)
    this.#generationHistories.set(input.activeRunner.generationId, ["ACTIVE"])
    this.#activeSubscriptions.set(
      input.activeRunner,
      this.#subscribeActive(input.activeRunner),
    )
  }

  async prepareAndCutover(spec: CandidateSpec): Promise<CutoverResult> {
    const committed = await this.#readCommitted()
    if (committed) {
      if (
        committed.commitId !== spec.commitId
        || committed.handoffIdempotencyKey !== spec.handoffIdempotencyKey
        || committed.generationId !== spec.generationId
        || committed.artifactId !== spec.artifactId
      ) {
        throw candidateError(
          "durable selection does not match the requested generation and artifact.",
        )
      }
      return await this.recoverCommitted()
    }

    const runner = await this.#bounded("Candidate spawn", (signal) =>
      this.#supervisor.spawn(spec, signal),
    )
    let attempt: Attempt<TSnapshot, TGateway>
    try {
      attempt = this.#createAttempt(spec, runner)
    } catch (error) {
      await this.#stopRunner(runner)
      throw error
    }
    try {
      await this.#prepare(attempt)
      return await this.#serializeCommit(() => this.#commit(attempt))
    } catch (error) {
      attempt.unsubscribe()
      if (runner !== this.#activeRunner) await this.#stopRunner(runner)
      throw error
    }
  }

  async recoverCommitted(): Promise<CutoverResult> {
    return await this.#serializeCommit(() => this.#recoverCommitted(false))
  }

  async #recoverCommitted(
    forceRestart: boolean,
    runnerToDrain?: GenerationRunner<TSnapshot, TGateway>,
  ): Promise<CutoverResult> {
    const record = await this.#readCommitted()
    if (!record) throw new Error("No durable generation commit exists.")
    if (
      !forceRestart
      && this.#projection.currentGenerationId() === record.generationId
      && this.#activeRunner.generationId === record.generationId
      && this.#activeRunner.artifactId === record.artifactId
    ) {
      await this.#completeInstalledCommit(record)
      return {
        commitId: record.commitId,
        generationId: record.generationId,
        candidateHistory: ["ACTIVE"],
        oldHistory: this.#history(record.previousGenerationId),
        recovered: true,
      }
    }

    const runner = await this.#bounded(
      "Committed generation restart",
      (signal) => this.#supervisor.restartCommitted(record, signal),
    )
    const spec = {
      commitId: record.commitId,
      handoffIdempotencyKey: record.handoffIdempotencyKey,
      generationId: record.generationId,
      artifactId: record.artifactId,
    }
    let attempt: Attempt<TSnapshot, TGateway>
    try {
      attempt = this.#createAttempt(spec, runner)
    } catch (error) {
      await this.#stopRunner(runner)
      throw error
    }
    const oldRunner = runnerToDrain ?? this.#activeRunner
    try {
      await this.#prepare(attempt)
      if (record.resources.length > 0) {
        await this.#bounded("Exclusive resource recovery", (signal) =>
          this.#resources.recover(record, signal),
        )
      }
      this.#install(attempt, record, true)
      await this.#completeInstalledCommit(record)
      attempt.history.push("ACTIVE")
      await this.#drainOld(oldRunner)
      return {
        commitId: record.commitId,
        generationId: record.generationId,
        candidateHistory: [...attempt.history],
        oldHistory: this.#history(oldRunner.generationId),
        recovered: true,
      }
    } catch (error) {
      attempt.unsubscribe()
      await this.#stopRunner(runner).catch(() => undefined)
      throw error
    }
  }

  #createAttempt(
    spec: CandidateSpec,
    runner: GenerationRunner<TSnapshot, TGateway>,
  ): Attempt<TSnapshot, TGateway> {
    if (
      runner.generationId !== spec.generationId
      || runner.artifactId !== spec.artifactId
    ) {
      throw candidateError(
        "spawned runner identity does not match the request.",
      )
    }
    const attempt: Attempt<TSnapshot, TGateway> = {
      spec,
      runner,
      history: ["SPAWNED"],
      events: [],
      unsubscribe: () => {},
      expectedSequence: 1,
      bufferedBytes: 0,
    }
    attempt.unsubscribe = runner.subscribe((event) =>
      this.#receiveCandidateEvent(attempt, event),
    )
    return attempt
  }

  async #prepare(attempt: Attempt<TSnapshot, TGateway>): Promise<void> {
    const negotiateController = new AbortController()
    await timeout(attempt.runner.negotiate(negotiateController.signal), {
      timeoutMs: this.#options.negotiateTimeoutMs,
      controller: negotiateController,
      label: "Candidate protocol negotiation",
    })
    attempt.history.push("NEGOTIATED", "PREPARING")
    const fence = this.#state.readFence()
    const prepareController = new AbortController()
    const ready = await timeout(
      attempt.runner.prepare(fence, prepareController.signal),
      {
        timeoutMs: this.#options.prepareTimeoutMs,
        controller: prepareController,
        label: "Candidate preparation",
      },
    )
    // One coordinator owns each attempt; no other task writes its readiness.
    // eslint-disable-next-line require-atomic-updates
    attempt.ready = ready
    this.#validateReady(attempt, ready, fence)
    attempt.history.push("PREPARED")
  }

  #validateReady(
    attempt: Attempt<TSnapshot, TGateway>,
    ready: CandidateReady<TSnapshot>,
    expectedFence: ControlPlaneFence,
  ): void {
    if (attempt.protocolFailure) throw attempt.protocolFailure
    if (
      ready.generationId !== attempt.spec.generationId
      || ready.artifactId !== attempt.spec.artifactId
    ) {
      throw candidateError("READY generation or artifact identity is stale.")
    }
    if (!ready.snapshotComplete) {
      throw candidateError("READY snapshot is incomplete.")
    }
    if (!fencesEqual(ready.fence, expectedFence)) {
      throw candidateError("READY control-plane epoch or revision is stale.")
    }
    if (
      attempt.firstStateRevision !== undefined
      && attempt.firstStateRevision !== ready.snapshotRevision + 1
    ) {
      throw this.#rejectProtocol(
        attempt,
        `expected state revision ${ready.snapshotRevision + 1}, received ${attempt.firstStateRevision}`,
      )
    }
    const regression = candidateHealthRegression(
      this.#activeHealth,
      ready.health,
    )
    if (regression) throw candidateError(regression)
  }

  // eslint-disable-next-line max-lines-per-function -- commit order is one recovery protocol
  async #commit(attempt: Attempt<TSnapshot, TGateway>): Promise<CutoverResult> {
    const ready = attempt.ready
    if (!ready) throw new Error("Candidate was not prepared.")
    const latestRegression = candidateHealthRegression(
      this.#activeHealth,
      ready.health,
    )
    if (latestRegression) throw candidateError(latestRegression)
    attempt.history.push("COMMITTING")
    const oldRunner = this.#activeRunner
    let handoff = emptyHandoff()
    const record: GenerationCommitRecord<TSnapshot> = {
      commitId: attempt.spec.commitId,
      handoffIdempotencyKey: attempt.spec.handoffIdempotencyKey,
      previousGenerationId: oldRunner.generationId,
      generationId: attempt.spec.generationId,
      artifactId: attempt.spec.artifactId,
      fence: ready.fence,
      snapshot: ready.snapshot,
      snapshotRevision: ready.snapshotRevision,
      health: ready.health,
      previousHealth: this.#activeHealth,
      resources:
        attempt.runner.activation.mode === "exclusive" ?
          attempt.runner.activation.resources
        : [],
      events: [...attempt.events],
    }

    try {
      await this.#state.withCommitLock(async () => {
        if (!fencesEqual(this.#state.readFence(), ready.fence)) {
          throw candidateError("control-plane epoch changed before commit.")
        }
        if (!(await this.#state.compareAndSetFence(ready.fence))) {
          throw candidateError("control-plane revision CAS failed.")
        }
        this.#throwProtocolFailure(attempt)

        record.events = Object.freeze([...attempt.events])
        if (attempt.runner.activation.mode === "exclusive") {
          handoff = await this.#bounded(
            "Exclusive resource handoff",
            (signal) =>
              this.#resources.handoff(
                {
                  commitId: record.commitId,
                  idempotencyKey: record.handoffIdempotencyKey,
                  fromGenerationId: record.previousGenerationId,
                  toGenerationId: record.generationId,
                  resources: record.resources,
                  commitDurably: (idempotencyKey) =>
                    this.#journal.commitDurably(idempotencyKey, record, signal),
                  queryDurableCommit: (idempotencyKey) =>
                    this.#journal.queryDurableCommit(idempotencyKey, signal),
                },
                signal,
              ),
          )
        } else {
          await this.#bounded("Durable generation commit", async (signal) => {
            const state = await this.#journal.commitDurably(
              record.handoffIdempotencyKey,
              record,
              signal,
            )
            if (state !== "committed")
              throw new Error("The durable generation commit was declined.")
          })
        }
        this.#throwProtocolFailure(attempt)

        // Commit order is part of the recovery contract:
        // 1. durable selection, 2. atomic snapshot/pointer install,
        // 3. one idempotent public diff. No host-visible state precedes step 1.
        this.#install(attempt, record)
        if (attempt.runner.activation.mode === "exclusive") {
          this.#pendingHandoffs.set(record.commitId, handoff)
        }
        await this.#completeInstalledCommit(record)
      })
    } catch (error) {
      const selected = await this.#readCommitted()
      if (selected?.commitId !== record.commitId) {
        const reportedRecoveryError = handoffRecoveryError(error)
        try {
          if (reportedRecoveryError !== undefined)
            throw reportedRecoveryError instanceof Error ?
                reportedRecoveryError
              : new Error("Resource handoff recovery failed.", {
                  cause: reportedRecoveryError,
                })
          await this.#bounded("Exclusive handoff rollback", (signal) =>
            handoff.rollback(signal),
          )
        } catch (rollbackError) {
          await this.#bounded("Old resource restoration", (signal) =>
            this.#resources.restoreOld(
              oldRunner.generationId,
              record.resources,
              signal,
            ),
          )
          await this.#bounded("Old generation restoration", (signal) =>
            this.#supervisor.restoreActive(oldRunner, signal),
          )
          throw new AggregateError(
            [error, rollbackError],
            "Pre-commit rollback failed; old generation was actively restored.",
          )
        }
        throw error
      }
      // A selected schema/generation is monotonic. Recover that generation;
      // never put the old projection or exclusive lease back after this point.
      if (
        this.#activeRunner === attempt.runner
        && this.#projection.currentGenerationId() === record.generationId
      ) {
        if (attempt.runner.activation.mode === "exclusive") {
          this.#pendingHandoffs.set(record.commitId, handoff)
        }
        if (attempt.history.at(-1) !== "ACTIVE") attempt.history.push("ACTIVE")
        await this.#drainOld(oldRunner)
        await this.#completeInstalledCommit(record)
        return {
          commitId: record.commitId,
          generationId: record.generationId,
          candidateHistory: [...attempt.history],
          oldHistory: this.#history(oldRunner.generationId),
          recovered: true,
        }
      }
      attempt.unsubscribe()
      this.#activeSubscriptions.get(attempt.runner)?.()
      this.#activeSubscriptions.delete(attempt.runner)
      this.#pendingHandoffs.delete(record.commitId)
      await this.#stopRunner(attempt.runner).catch(() => undefined)
      return await this.#recoverCommitted(true, oldRunner)
    }

    attempt.history.push("ACTIVE")
    await this.#drainOld(oldRunner)
    return {
      commitId: record.commitId,
      generationId: record.generationId,
      candidateHistory: [...attempt.history],
      oldHistory: this.#history(oldRunner.generationId),
      recovered: false,
    }
  }

  async #completeInstalledCommit(
    record: GenerationCommitRecord<TSnapshot>,
  ): Promise<void> {
    await this.#bounded("Journal installed marker", (signal) =>
      this.#journal.markInstalled(record.commitId, signal),
    )
    this.#state.publishDiff({
      commitId: record.commitId,
      previousGenerationId: record.previousGenerationId,
      generationId: record.generationId,
      snapshot: record.snapshot,
      events: record.events,
    })
    await this.#bounded("Journal published marker", (signal) =>
      this.#journal.markPublished(record.commitId, signal),
    )
    this.#openPublicEvents(record.generationId)
    const handoff = this.#pendingHandoffs.get(record.commitId)
    if (!handoff) return
    await this.#bounded("Exclusive handoff finalization", (signal) =>
      handoff.finish(signal),
    )
    this.#pendingHandoffs.delete(record.commitId)
  }

  #install(
    attempt: Attempt<TSnapshot, TGateway>,
    record: GenerationCommitRecord<TSnapshot>,
    recovering = false,
  ): void {
    const ready = attempt.ready
    if (!ready) throw new Error("Candidate was not prepared.")
    if (attempt.protocolFailure) throw attempt.protocolFailure
    this.#projection.install({
      commitId: record.commitId,
      generationId: record.generationId,
      gateway: attempt.runner.gateway,
      snapshot: record.snapshot,
      events: record.events,
    })
    const afterDurableEvents =
      recovering ? attempt.events : attempt.events.slice(record.events.length)
    this.#activeRunner = attempt.runner
    this.#activeHealth = ready.health
    this.#lifecycle.publishCutover(
      record.generationId,
      Date.now() + this.#options.drainTimeoutMs,
    )
    this.#discardHeldEvents(attempt.runner.generationId)
    attempt.unsubscribe()
    this.#activeSubscriptions.get(attempt.runner)?.()
    this.#activeCursors.set(attempt.runner, {
      expectedSequence: attempt.expectedSequence,
      lastStateRevision: attempt.lastStateRevision ?? ready.snapshotRevision,
    })
    this.#activeSubscriptions.set(
      attempt.runner,
      this.#subscribeActive(attempt.runner),
    )
    for (const event of afterDurableEvents) {
      this.#holdActiveEvent(attempt.runner, event)
    }
    this.#generationHistories.set(attempt.runner.generationId, ["ACTIVE"])
  }

  /**
   * Drain barrier. The old generation is stopped only after `beginDrain`
   * settles, i.e. after its operation, prepared-tool, and affinity leases are
   * gone. If that takes longer than the cutover is willing to wait, the wait
   * continues in the background; `stop` is never called early.
   */
  async #drainOld(
    runner: GenerationRunner<TSnapshot, TGateway>,
  ): Promise<void> {
    if (runner === this.#activeRunner) return
    const history = this.#generationHistories.get(runner.generationId) ?? [
      "ACTIVE" as const,
    ]
    history.push("DRAINING")
    this.#generationHistories.set(runner.generationId, history)
    if (await this.#drainSettled(runner)) {
      await this.#retireDrained(runner, history)
      return
    }
    void this.#retireWhenDrained(runner, history)
  }

  /** False only when the drain is still pending at the cutover's wait limit. */
  async #drainSettled(
    runner: GenerationRunner<TSnapshot, TGateway>,
  ): Promise<boolean> {
    try {
      await this.#boundedBy(
        "Old generation drain",
        this.#options.drainWaitMs,
        (signal) => runner.beginDrain(signal),
      )
    } catch (error) {
      return !(error instanceof GenerationTimeoutError)
    }
    return true
  }

  async #retireWhenDrained(
    runner: GenerationRunner<TSnapshot, TGateway>,
    history: Array<ActiveGenerationPhase>,
  ): Promise<void> {
    try {
      await runner.beginDrain(new AbortController().signal)
    } catch {
      // A failed drain means the runner can no longer be waited on.
    }
    await this.#retireDrained(runner, history).catch(() => undefined)
  }

  async #retireDrained(
    runner: GenerationRunner<TSnapshot, TGateway>,
    history: Array<ActiveGenerationPhase>,
  ): Promise<void> {
    history.push("STOPPING")
    await this.#stopRunner(runner).catch(() => undefined)
    this.#activeSubscriptions.get(runner)?.()
    this.#activeSubscriptions.delete(runner)
    this.#activeCursors.delete(runner)
  }

  #subscribeActive(runner: GenerationRunner<TSnapshot, TGateway>): () => void {
    return runner.subscribe((event) => {
      if (
        event.kind !== "call"
        && runner === this.#activeRunner
        && runner !== this.#publicRunner
        && !this.#canHoldActiveEvent(event)
      ) {
        const cursor = this.#activeCursors.get(runner)
        void runner
          .requestResync(
            cursor?.expectedSequence ?? event.sequence,
            "active event buffer overflow",
          )
          .catch(() => undefined)
        return
      }
      if (!this.#acceptActiveEvent(runner, event)) return
      if (event.kind === "call") {
        this.#state.publishCallCallback(
          runner.generationId,
          event.callId,
          event.value,
        )
        return
      }
      if (runner !== this.#activeRunner) return
      if (runner !== this.#publicRunner) {
        this.#holdActiveEvent(runner, event)
        return
      }
      this.#state.publishActiveEvent(runner.generationId, event)
    })
  }

  #acceptActiveEvent(
    runner: GenerationRunner<TSnapshot, TGateway>,
    event: GenerationEvent,
  ): boolean {
    const cursor = this.#activeCursors.get(runner) ?? {}
    if (
      cursor.expectedSequence !== undefined
      && event.sequence !== cursor.expectedSequence
    ) {
      void runner
        .requestResync(
          cursor.expectedSequence,
          `active sequence gap: received ${event.sequence}`,
        )
        .catch(() => undefined)
      return false
    }
    if (
      event.kind === "state"
      && cursor.lastStateRevision !== undefined
      && event.revision !== cursor.lastStateRevision + 1
    ) {
      void runner
        .requestResync(
          cursor.expectedSequence ?? event.sequence,
          `active state revision gap: received ${event.revision}`,
        )
        .catch(() => undefined)
      return false
    }
    cursor.expectedSequence = event.sequence + 1
    if (event.kind === "state") cursor.lastStateRevision = event.revision
    this.#activeCursors.set(runner, cursor)
    return true
  }

  #canHoldActiveEvent(
    event: CandidateStateEvent | CandidateNoticeEvent,
  ): boolean {
    return (
      this.#heldActiveEvents.length < this.#options.maxBufferedEvents
      && this.#heldActiveBytes + eventBytes(event)
        <= this.#options.maxBufferedBytes
    )
  }

  #holdActiveEvent(
    runner: GenerationRunner<TSnapshot, TGateway>,
    event: CandidateStateEvent | CandidateNoticeEvent,
  ): void {
    this.#heldActiveBytes += eventBytes(event)
    this.#heldActiveEvents.push({ runner, event })
  }

  #openPublicEvents(generationId: string): void {
    if (this.#activeRunner.generationId !== generationId) return
    this.#publicRunner = this.#activeRunner
    const pending = this.#heldActiveEvents.splice(0)
    this.#heldActiveBytes = 0
    for (const { runner, event } of pending) {
      if (runner !== this.#activeRunner || runner.generationId !== generationId)
        continue
      this.#state.publishActiveEvent(generationId, event)
    }
  }

  #discardHeldEvents(generationId: string): void {
    for (
      let index = this.#heldActiveEvents.length - 1;
      index >= 0;
      index -= 1
    ) {
      if (this.#heldActiveEvents[index]?.runner.generationId === generationId) {
        const [removed] = this.#heldActiveEvents.splice(index, 1)
        this.#heldActiveBytes -= eventBytes(removed.event)
      }
    }
  }

  #receiveCandidateEvent(
    attempt: Attempt<TSnapshot, TGateway>,
    event: GenerationEvent,
  ): void {
    if (attempt.protocolFailure) return
    if (event.sequence !== attempt.expectedSequence) {
      this.#rejectProtocol(
        attempt,
        `expected sequence ${attempt.expectedSequence}, received ${event.sequence}`,
      )
      return
    }
    if (event.kind === "call") {
      attempt.expectedSequence += 1
      return
    }
    const bytes = eventBytes(event)
    if (
      attempt.events.length >= this.#options.maxBufferedEvents
      || attempt.bufferedBytes + bytes > this.#options.maxBufferedBytes
    ) {
      this.#rejectProtocol(attempt, "candidate event buffer overflow")
      return
    }
    if (event.kind === "state") {
      let expectedRevision: number | undefined
      if (attempt.lastStateRevision !== undefined) {
        expectedRevision = attempt.lastStateRevision + 1
      } else if (attempt.ready) {
        expectedRevision = attempt.ready.snapshotRevision + 1
      }
      if (
        expectedRevision !== undefined
        && event.revision !== expectedRevision
      ) {
        this.#rejectProtocol(
          attempt,
          `expected state revision ${expectedRevision}, received ${event.revision}`,
        )
        return
      }
      attempt.firstStateRevision ??= event.revision
      attempt.lastStateRevision = event.revision
    }
    attempt.expectedSequence += 1
    attempt.bufferedBytes += bytes
    attempt.events.push(event)
  }

  #throwProtocolFailure(attempt: Attempt<TSnapshot, TGateway>): void {
    if (attempt.protocolFailure) throw attempt.protocolFailure
  }

  #rejectProtocol(
    attempt: Attempt<TSnapshot, TGateway>,
    reason: string,
  ): Error {
    const failure = candidateError(`protocol gap: ${reason}.`)
    attempt.protocolFailure = failure
    void attempt.runner
      .requestResync(attempt.expectedSequence, reason)
      .catch(() => undefined)
    return failure
  }

  #bounded<T>(
    label: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.#boundedBy(label, this.#options.operationTimeoutMs, run)
  }

  #boundedBy<T>(
    label: string,
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    return timeout(run(controller.signal), {
      timeoutMs,
      controller,
      label,
    })
  }

  #readCommitted(): Promise<GenerationCommitRecord<TSnapshot> | undefined> {
    return this.#bounded("Generation journal read", (signal) =>
      this.#journal.committed(signal),
    )
  }

  #stopRunner(runner: GenerationRunner<TSnapshot, TGateway>): Promise<void> {
    return this.#bounded("Generation stop", (signal) => runner.stop(signal))
  }

  #serializeCommit<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#commitTail.then(run, run)
    this.#commitTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #history(generationId: string): ReadonlyArray<ActiveGenerationPhase> {
    return [...(this.#generationHistories.get(generationId) ?? ["ACTIVE"])]
  }
}
