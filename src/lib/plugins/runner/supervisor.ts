/* eslint-disable max-lines -- supervisor lifecycle resources share one ownership scope. */
import type { JsonValue } from "@stuffbucket/maximal-plugin-protocol"

import { randomBytes } from "node:crypto"

import type {
  GenerationSelection,
  PreparedRunnerSnapshot,
  RunnerChannel,
  RunnerChannelFactory,
  RunnerCommandEnvironment,
  RunnerContainmentHooks,
  RunnerLifecycleState,
  RunnerProcess,
  RunnerProcessExit,
  RunnerProcessSpawner,
  RunnerScheduler,
  RunnerStateAuthority,
} from "./contracts"

import {
  pluginGenerationLifecycle,
  type PluginGenerationLifecycleRegistry,
} from "../generation-lifecycle"
import { resolveRunnerCommand } from "./command"
import { RUNNER_API_VERSION, RUNNER_PROTOCOL_VERSION } from "./contracts"
import {
  PluginRunnerIndeterminateError,
  PluginRunnerShutdownError,
  PluginRunnerUnavailableError,
  type RunnerUnavailableReason,
} from "./errors"
import { parseRunnerMessage } from "./messages"
import { RunnerStateMachine } from "./state-machine"

export interface PluginRunnerSupervisorConfig {
  readonly startupTimeoutMs: number
  readonly heartbeatTimeoutMs: number
  readonly drainTimeoutMs: number
  readonly shutdownBudgetMs: number
  readonly reapReserveMs: number
  readonly backoffBaseMs: number
  readonly backoffMaxMs: number
  readonly circuitFailures: number
  readonly circuitWindowMs: number
  readonly circuitResetMs: number
}

const DEFAULT_CONFIG: PluginRunnerSupervisorConfig = Object.freeze({
  startupTimeoutMs: 15_000,
  heartbeatTimeoutMs: 5_000,
  drainTimeoutMs: 10_000,
  shutdownBudgetMs: 1_400,
  reapReserveMs: 250,
  backoffBaseMs: 250,
  backoffMaxMs: 30_000,
  circuitFailures: 5,
  circuitWindowMs: 60_000,
  circuitResetMs: 60_000,
})

const realScheduler: RunnerScheduler = Object.freeze({
  now: () => Date.now(),
  setTimeout(callback: () => void, delayMs: number) {
    const timer = setTimeout(callback, delayMs)
    timer.unref()
    return () => clearTimeout(timer)
  },
})

export type SupervisorAvailability =
  | "unavailable"
  | "starting"
  | "active"
  | "backing-off"
  | "circuit-open"
  | "shutting-down"
  | "stopped"

export interface RunnerCrashDiagnostic {
  readonly at: number
  readonly phase: "startup" | "active" | "draining" | "shutdown"
  readonly code: number | null
  readonly signal: string | null
  readonly reason: string
  readonly indeterminateCalls: number
}

export interface PluginRunnerDiagnostics {
  readonly availability: SupervisorAvailability
  readonly lifecycle?: RunnerLifecycleState
  readonly generationId: string
  readonly manifestSha256: string
  readonly inventoryDigest: string
  readonly pid?: number
  readonly attempts: number
  readonly failuresInWindow: number
  readonly backoffUntil?: number
  readonly circuitOpenUntil?: number
  readonly lastHeartbeatAt?: number
  readonly activeSince?: number
  readonly inflight: number
  readonly lastCrash?: RunnerCrashDiagnostic
}

export interface SupervisorRpcClient {
  call(
    method: string,
    params: JsonValue,
    options?: { signal?: AbortSignal },
  ): Promise<JsonValue>
  dispose(reason?: string): void
}

export interface PluginRunnerSupervisorOptions {
  readonly selection: GenerationSelection
  readonly command: RunnerCommandEnvironment
  readonly spawner: RunnerProcessSpawner
  readonly channelFactory: RunnerChannelFactory
  readonly stateAuthority: RunnerStateAuthority
  /** Registry shared by this manager's supervisors and cutover coordinator. */
  readonly lifecycle?: PluginGenerationLifecycleRegistry
  /**
   * Candidate supervisors wait for the durable coordinator before their first
   * activation. After that first activation a restarted runner is activated
   * as soon as it is prepared.
   */
  readonly deferActivation?: boolean
  /**
   * Asked before every automatic restart. Return false for a generation that
   * must not come back (for example one already superseded), so a revived
   * process can never rebind resources a newer generation owns.
   */
  readonly shouldRestart?: () => boolean
  /** Required: production must fail closed if tree ownership cannot attach. */
  readonly containment: RunnerContainmentHooks
  /** Production RPC shares the child IPC pipe but has its own authenticated frames. */
  readonly rpcFactory?: (
    process: RunnerProcess,
    nonce: string,
  ) => SupervisorRpcClient
  readonly scheduler?: RunnerScheduler
  readonly nonce?: () => string
  readonly config?: Partial<PluginRunnerSupervisorConfig>
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface PendingInvocation {
  readonly callId: string
  readonly method: string
  readonly params: JsonValue
  readonly completion: Deferred<JsonValue>
  stage: "queued" | "dispatched"
}

export interface RunnerInvocation {
  readonly callId: string
  readonly result: Promise<JsonValue>
  dispatch(): void
  cancel(reason: string): void
}

interface CurrentRunner {
  readonly token: number
  readonly nonce: string
  handshakeAccepted: boolean
  readonly process: RunnerProcess
  readonly channel: RunnerChannel
  readonly rpc?: SupervisorRpcClient
  readonly machine: RunnerStateMachine
  readonly startup: Deferred<undefined>
  readonly prepared: Deferred<PreparedRunnerSnapshot>
  unsubscribe: () => void
  unsubscribeClose: () => void
  cancelStartupTimer: () => void
  cancelHeartbeatTimer?: () => void
  cancelForceTimer?: () => void
  treeTermination?: Promise<void>
  failure?: PluginRunnerUnavailableError
  intentionalStop: boolean
  shutdown?: Deferred<undefined>
}

function crashPhase(current: CurrentRunner): RunnerCrashDiagnostic["phase"] {
  if (current.intentionalStop) return "shutdown"
  if (current.machine.state === "active") return "active"
  if (current.machine.state === "draining") return "draining"
  return "startup"
}

/** Validate every Phase 5 readiness fence without performing a cutover. */
export function validatePreparedRunnerSnapshot(
  snapshot: PreparedRunnerSnapshot,
  selection: GenerationSelection,
  controlEpoch: number,
): void {
  if (!snapshot.complete) throw new Error("Runner snapshot is incomplete.")
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0)
    throw new Error("Runner snapshot revision is invalid.")
  if (
    snapshot.controlEpoch !== selection.controlEpoch
    || snapshot.controlEpoch !== controlEpoch
  )
    throw new Error("Runner snapshot control-plane epoch is stale.")
  if (snapshot.generationId !== selection.token.generationId)
    throw new Error("Runner snapshot generation is stale.")
  if (snapshot.manifestSha256 !== selection.token.manifestSha256)
    throw new Error("Runner snapshot artifact identity changed.")
  if (snapshot.inventoryDigest !== selection.inventoryDigest)
    throw new Error("Runner snapshot inventory identity changed.")
  const rejected = snapshot.health.find(
    (item) =>
      item.classification === "waiting-dependency"
      || item.classification === "regression"
      || item.classification === "host-failure",
  )
  if (rejected)
    throw new Error(
      `Runner health rejected ${rejected.pluginId}: ${rejected.classification}.`,
    )
}

export class PluginRunnerSupervisor {
  readonly #options: PluginRunnerSupervisorOptions
  readonly #config: PluginRunnerSupervisorConfig
  readonly #scheduler: RunnerScheduler
  readonly #containment: RunnerContainmentHooks
  readonly #nonce: () => string
  readonly #unregisterGenerationLifecycle: () => void
  readonly #pending = new Map<string, PendingInvocation>()
  readonly #candidatePrepared = deferred<PreparedRunnerSnapshot>()
  #availability: SupervisorAvailability = "unavailable"
  #current: CurrentRunner | undefined
  #token = 0
  #attempts = 0
  #nextCall = 0
  #failures: Array<number> = []
  #backoffUntil: number | undefined
  #circuitOpenUntil: number | undefined
  #lastHeartbeatAt: number | undefined
  #activeSince: number | undefined
  #lastCrash: RunnerCrashDiagnostic | undefined
  #cancelRestart: (() => void) | undefined
  #startPromise: Promise<void> | undefined
  /** Set at the first activation; later spawns are restarts of an active runner. */
  #activatedOnce = false
  #shutdownRequested = false
  /** Budget-facing completion returned to callers of `shutdown`. */
  #shutdownPromise: Promise<void> | undefined
  /** Authoritative process-tree termination and reap completion. */
  #shutdownSettled: Promise<void> | undefined
  #messageQueue = Promise.resolve()

  constructor(options: PluginRunnerSupervisorOptions) {
    this.#options = options
    this.#config = Object.freeze({ ...DEFAULT_CONFIG, ...options.config })
    this.#scheduler = options.scheduler ?? realScheduler
    this.#containment = options.containment
    this.#nonce = options.nonce ?? (() => randomBytes(24).toString("base64url"))
    this.#unregisterGenerationLifecycle = (
      options.lifecycle ?? pluginGenerationLifecycle
    ).registerGeneration(options.selection.token.generationId, this)
  }

  /**
   * The immutable generation selection, with the control-plane epoch refreshed
   * for restarts: a restarted runner prepares against today's epoch, since the
   * original one is stale once anything committed after the first activation.
   */
  #selectionNow(): GenerationSelection {
    const selection = this.#options.selection
    if (!this.#activatedOnce) return selection
    return Object.freeze({
      ...selection,
      controlEpoch: this.#options.stateAuthority.currentControlEpoch(),
    })
  }

  diagnostics(): PluginRunnerDiagnostics {
    const current = this.#current
    const snapshot: PluginRunnerDiagnostics = {
      availability: this.#availability,
      ...(current ?
        {
          lifecycle:
            current.machine.state === "stopped" ?
              "stopping"
            : current.machine.state,
          pid: current.process.pid,
        }
      : {}),
      generationId: this.#options.selection.token.generationId,
      manifestSha256: this.#options.selection.token.manifestSha256,
      inventoryDigest: this.#options.selection.inventoryDigest,
      attempts: this.#attempts,
      failuresInWindow: this.#recentFailures().length,
      ...(this.#backoffUntil === undefined ?
        {}
      : { backoffUntil: this.#backoffUntil }),
      ...(this.#circuitOpenUntil === undefined ?
        {}
      : { circuitOpenUntil: this.#circuitOpenUntil }),
      ...(this.#lastHeartbeatAt === undefined ?
        {}
      : { lastHeartbeatAt: this.#lastHeartbeatAt }),
      ...(this.#activeSince === undefined ?
        {}
      : { activeSince: this.#activeSince }),
      inflight: this.#pending.size,
      ...(this.#lastCrash === undefined ? {} : { lastCrash: this.#lastCrash }),
    }
    return structuredClone(snapshot)
  }

  start(): Promise<void> {
    if (this.#availability === "active") return Promise.resolve()
    if (this.#shutdownRequested) {
      return Promise.reject(
        this.#unavailable("shutting-down", "Plugin runner is shutting down."),
      )
    }
    if (this.#availability === "backing-off") {
      return Promise.reject(
        this.#unavailable(
          "backing-off",
          "Plugin runner is backing off.",
          this.#remaining(this.#backoffUntil),
        ),
      )
    }
    if (this.#availability === "circuit-open") {
      return Promise.reject(
        this.#unavailable(
          "circuit-open",
          "Plugin runner circuit is open.",
          this.#remaining(this.#circuitOpenUntil),
        ),
      )
    }
    if (this.#startPromise) return this.#startPromise
    const operation = this.#spawn()
    this.#startPromise = operation
    const clear = (): void => {
      if (this.#startPromise === operation) this.#startPromise = undefined
    }
    void operation.then(clear, clear)
    return operation
  }

  prepareCandidate(): Promise<PreparedRunnerSnapshot> {
    if (!this.#options.deferActivation)
      return Promise.reject(new Error("Runner activation is not deferred."))
    void this.start().catch((error: unknown) => {
      this.#candidatePrepared.reject(error)
    })
    return this.#candidatePrepared.promise
  }

  activateCandidate(): Promise<void> {
    const current = this.#current
    if (!this.#options.deferActivation || current?.machine.state !== "prepared")
      return Promise.reject(new Error("Runner candidate is not prepared."))
    this.#activatedOnce = true
    current.channel.send({ type: "supervisor.activate" })
    return current.startup.promise
  }

  beginInvocation(method: string, params: JsonValue): RunnerInvocation {
    const current = this.#current
    if (!current || this.#availability !== "active")
      throw this.#availabilityError()
    const callId = `${this.#options.selection.token.generationId}:${++this.#nextCall}`
    const pending: PendingInvocation = {
      callId,
      method,
      params,
      completion: deferred<JsonValue>(),
      stage: "queued",
    }
    this.#pending.set(callId, pending)
    let dispatched = false
    return {
      callId,
      result: pending.completion.promise,
      dispatch: () => {
        if (dispatched) return
        dispatched = true
        const live = this.#current
        if (!live || live !== current || this.#availability !== "active") {
          this.#pending.delete(callId)
          pending.completion.reject(this.#availabilityError())
          return
        }
        try {
          live.channel.send({
            type: "supervisor.dispatch",
            callId,
            method,
            params,
          })
          pending.stage = "dispatched"
        } catch (cause) {
          this.#pending.delete(callId)
          pending.completion.reject(
            this.#unavailable(
              "crashed",
              "Plugin runner dispatch failed before delivery.",
              undefined,
              cause,
            ),
          )
        }
      },
      cancel: (reason) => {
        if (!this.#pending.delete(callId)) return
        if (pending.stage === "dispatched")
          current.channel.send({ type: "supervisor.cancel", callId, reason })
        pending.completion.reject(new Error(reason))
      },
    }
  }

  dispatch(method: string, params: JsonValue): Promise<JsonValue> {
    const rpc = this.#current?.rpc
    if (rpc && this.#availability === "active") return rpc.call(method, params)
    const invocation = this.beginInvocation(method, params)
    invocation.dispatch()
    return invocation.result
  }

  shutdown(
    reason = "parent shutdown",
    budgetMs = this.#config.shutdownBudgetMs,
  ): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise
    this.#shutdownRequested = true
    this.#cancelRestart?.()
    this.#cancelRestart = undefined
    this.#availability = "shutting-down"
    const completion = deferred<undefined>()
    const cancelBudget = this.#scheduler.setTimeout(
      () => {
        completion.reject(new PluginRunnerShutdownError(budgetMs))
      },
      Math.max(0, budgetMs),
    )
    const operation = this.#performShutdown(reason, budgetMs).then(() => {
      this.#availability = "stopped"
      this.#unregisterGenerationLifecycle()
    })
    this.#shutdownSettled = operation
    void operation.then(
      () => {
        cancelBudget()
        completion.resolve(undefined)
      },
      (error: unknown) => {
        cancelBudget()
        completion.reject(error)
      },
    )
    this.#shutdownPromise = completion.promise
    return completion.promise
  }

  /**
   * Process-tree termination completion, independent of the caller-facing
   * shutdown budget. A parent must not release singleton leases before this
   * settles successfully.
   */
  shutdownSettled(): Promise<void> {
    return this.#shutdownSettled ?? Promise.resolve()
  }

  async #runnerForShutdown(): Promise<CurrentRunner | undefined> {
    if (this.#current) return this.#current
    const pendingStart = this.#startPromise
    if (!pendingStart) return undefined
    try {
      await pendingStart
    } catch (error) {
      if (
        !(error instanceof PluginRunnerUnavailableError)
        || error.reason !== "shutting-down"
      )
        throw error
    }
    return this.#current
  }

  async #performShutdown(reason: string, budgetMs: number): Promise<void> {
    const current = this.#current ?? (await this.#runnerForShutdown())
    if (!current) return
    if (current.shutdown) return current.shutdown.promise
    current.intentionalStop = true
    current.cancelStartupTimer()
    current.cancelHeartbeatTimer?.()
    current.shutdown = deferred<undefined>()
    const forceAfter = Math.max(
      0,
      budgetMs - Math.min(this.#config.reapReserveMs, budgetMs),
    )
    current.cancelForceTimer = this.#scheduler.setTimeout(() => {
      void this.#forceStop(current).catch(() => {
        // #handleExit or the shutdown budget reports cleanup failure.
      })
    }, forceAfter)
    if (current.machine.state === "active") {
      const drainMs = Math.min(this.#config.drainTimeoutMs, forceAfter)
      current.channel.send({
        type: "supervisor.drain",
        deadlineMs: this.#scheduler.now() + drainMs,
        reason,
      })
    } else {
      current.channel.send({
        type: "supervisor.shutdown",
        graceful: true,
        reason,
      })
    }
    return current.shutdown.promise
  }

  // Spawn, containment, channel subscription, and deadlines form one transaction.
  // eslint-disable-next-line max-lines-per-function
  async #spawn(): Promise<void> {
    this.#availability = "starting"
    this.#backoffUntil = undefined
    this.#attempts += 1
    const nonce = this.#nonce()
    const command = resolveRunnerCommand(
      this.#options.command,
      nonce,
      this.#selectionNow(),
    )
    const token = ++this.#token
    let process: RunnerProcess | undefined
    try {
      process = await this.#options.spawner.spawn(command)
      await this.#containment.attach(process)
      if (this.#shutdownRequested)
        throw this.#unavailable(
          "shutting-down",
          "Plugin runner containment attached during shutdown.",
        )
    } catch (cause) {
      let cleanupFailure: unknown
      if (process) {
        try {
          await this.#disposeLateProcess(process)
        } catch (error) {
          cleanupFailure = error
        }
      }
      if (cleanupFailure !== undefined) {
        const failure = this.#unavailable(
          "crashed",
          "Could not contain and reap a failed plugin runner spawn.",
          undefined,
          cleanupFailure,
        )
        this.#recordFailure(failure, { code: null, signal: null }, "startup", 0)
        this.#availability = "circuit-open"
        throw failure
      }
      if (this.#shutdownRequested)
        throw this.#unavailable(
          "shutting-down",
          "Plugin runner spawn ended during shutdown.",
          undefined,
          cause,
        )
      const failure = this.#unavailable(
        "crashed",
        "Could not spawn plugin runner.",
        undefined,
        cause,
      )
      this.#recordFailure(failure, { code: null, signal: null }, "startup", 0)
      this.#scheduleRestart()
      throw failure
    }
    const channel = this.#options.channelFactory.open(process)
    const rpc = this.#options.rpcFactory?.(process, nonce)
    const startup = deferred<undefined>()
    const prepared = deferred<PreparedRunnerSnapshot>()
    const current: CurrentRunner = {
      token,
      nonce,
      handshakeAccepted: false,
      process,
      channel,
      ...(rpc === undefined ? {} : { rpc }),
      machine: new RunnerStateMachine(),
      startup,
      prepared,
      unsubscribe: () => {},
      unsubscribeClose: () => {},
      cancelStartupTimer: () => {},
      intentionalStop: false,
    }
    this.#current = current
    current.unsubscribe = channel.subscribe((message) => {
      this.#messageQueue = this.#messageQueue
        .then(() => this.#handleMessage(current, message))
        .catch((cause: unknown) =>
          this.#failCurrent(
            current,
            this.#unavailable(
              "protocol",
              "Plugin runner protocol failed.",
              undefined,
              cause,
            ),
          ),
        )
    })
    current.unsubscribeClose = channel.onClose(() => {
      if (
        this.#current === current
        && !current.intentionalStop
        && !current.failure
      ) {
        this.#failCurrent(
          current,
          this.#unavailable("crashed", "Plugin runner channel disconnected."),
        )
      }
    })
    current.cancelStartupTimer = this.#scheduler.setTimeout(() => {
      this.#failCurrent(
        current,
        this.#unavailable(
          "startup-timeout",
          "Plugin runner startup timed out.",
        ),
      )
    }, this.#config.startupTimeoutMs)
    void process.wait().then(
      (exit) => this.#handleExit(current, exit),
      (cause: unknown) =>
        this.#handleExit(current, { code: null, signal: null }, cause),
    )
    return startup.promise
  }

  async #disposeLateProcess(process: RunnerProcess): Promise<void> {
    try {
      process.kill("SIGKILL")
    } catch {
      // wait() below still observes an already-exited child.
    }
    const [, exit] = await Promise.all([
      this.#containment.terminateDescendants(process),
      process.wait(),
    ])
    await this.#containment.reaped(process)
    void exit
  }

  // Message variants are serialized here so state validation stays centralized.
  // eslint-disable-next-line complexity
  async #handleMessage(current: CurrentRunner, raw: unknown): Promise<void> {
    if (this.#current !== current || current.failure) return
    const message = parseRunnerMessage(raw)
    if (message.type === "runner.hello") {
      if (
        current.handshakeAccepted
        || current.machine.state !== "spawned"
        || message.nonce !== current.nonce
        || message.protocol !== RUNNER_PROTOCOL_VERSION
        || message.pluginApi !== RUNNER_API_VERSION
        || message.generationId !== this.#options.selection.token.generationId
        || message.manifestSha256
          !== this.#options.selection.token.manifestSha256
        || message.selectionSeal !== this.#options.selection.token.seal
      )
        throw new Error("Runner handshake did not match this spawn.")
      current.handshakeAccepted = true
      current.channel.send({
        type: "supervisor.accept",
        nonce: current.nonce,
        protocol: RUNNER_PROTOCOL_VERSION,
        pluginApi: RUNNER_API_VERSION,
      })
      return
    }
    if (!current.handshakeAccepted)
      throw new Error("Runner sent lifecycle data before its handshake.")
    if (message.type === "runner.state") {
      current.machine.transition(message.state)
      if (message.state === "prepared") {
        if (!message.prepared)
          throw new Error("Prepared runner state omitted its snapshot.")
        validatePreparedRunnerSnapshot(
          message.prepared,
          this.#selectionNow(),
          this.#options.stateAuthority.currentControlEpoch(),
        )
        await this.#options.stateAuthority.validatePrepared(message.prepared)
        await this.#options.stateAuthority.installInitial(message.prepared)
        current.prepared.resolve(message.prepared)
        this.#candidatePrepared.resolve(message.prepared)
        if (!this.#options.deferActivation || this.#activatedOnce) {
          this.#activatedOnce = true
          current.channel.send({ type: "supervisor.activate" })
        }
      }
      if (message.state === "active") {
        await this.#options.stateAuthority.activated?.()
        current.cancelStartupTimer()
        this.#availability = "active"
        this.#activeSince = this.#scheduler.now()
        current.startup.resolve(undefined)
        this.#armHeartbeat(current)
      }
      return
    }
    if (message.type === "runner.heartbeat") {
      if (current.machine.state !== "active")
        throw new Error("Runner heartbeat arrived before activation.")
      this.#lastHeartbeatAt = this.#scheduler.now()
      this.#armHeartbeat(current)
      return
    }
    if (message.type === "runner.drained") {
      if (current.machine.state !== "draining")
        throw new Error("Runner reported drained outside draining state.")
      current.channel.send({
        type: "supervisor.shutdown",
        graceful: true,
        reason: "drain complete",
      })
      return
    }
    const pending = this.#pending.get(message.callId)
    if (!pending) throw new Error(`Unknown runner call ${message.callId}.`)
    this.#pending.delete(message.callId)
    if (message.error) {
      pending.completion.reject(
        message.error.indeterminate ?
          new PluginRunnerIndeterminateError(
            message.callId,
            message.error.message,
          )
        : new Error(message.error.message),
      )
    } else {
      pending.completion.resolve(message.value ?? null)
    }
  }

  #armHeartbeat(current: CurrentRunner): void {
    current.cancelHeartbeatTimer?.()
    current.cancelHeartbeatTimer = this.#scheduler.setTimeout(() => {
      this.#failCurrent(
        current,
        this.#unavailable(
          "heartbeat-lost",
          "Plugin runner heartbeat was lost.",
        ),
      )
    }, this.#config.heartbeatTimeoutMs)
  }

  #failCurrent(
    current: CurrentRunner,
    failure: PluginRunnerUnavailableError,
  ): void {
    if (this.#current !== current || current.failure) return
    current.failure = failure
    this.#availability = "unavailable"
    current.cancelStartupTimer()
    current.cancelHeartbeatTimer?.()
    current.startup.reject(failure)
    if (this.#options.deferActivation) {
      current.prepared.reject(failure)
      this.#candidatePrepared.reject(failure)
    }
    try {
      current.process.kill("SIGKILL")
    } catch {
      // wait() still provides the authoritative reap result.
    }
    void this.#ensureTreeTerminated(current).catch(() => {
      // #handleExit reports the same shared cleanup failure authoritatively.
    })
  }

  #ensureTreeTerminated(current: CurrentRunner): Promise<void> {
    current.treeTermination ??= Promise.resolve(
      this.#containment.terminateDescendants(current.process),
    )
    return current.treeTermination
  }

  async #forceStop(current: CurrentRunner): Promise<void> {
    if (this.#current !== current) return
    try {
      current.process.kill("SIGKILL")
    } catch {
      // Already gone.
    }
    await this.#ensureTreeTerminated(current)
  }

  async #handleExit(
    current: CurrentRunner,
    exit: RunnerProcessExit,
    waitFailure?: unknown,
  ): Promise<void> {
    current.cancelStartupTimer()
    current.cancelHeartbeatTimer?.()
    current.cancelForceTimer?.()
    current.unsubscribe()
    current.unsubscribeClose()
    current.rpc?.dispose("Runner process exited.")
    let cleanupFailure = waitFailure
    try {
      await this.#ensureTreeTerminated(current)
      await this.#containment.reaped(current.process)
    } catch (cause) {
      cleanupFailure ??= cause
    }
    if (this.#current !== current) return
    this.#current = undefined
    const phase = crashPhase(current)
    let indeterminate = 0
    const failure =
      current.failure
      ?? this.#unavailable(
        "crashed",
        "Plugin runner exited unexpectedly.",
        undefined,
        cleanupFailure,
      )
    for (const pending of this.#pending.values()) {
      if (pending.stage === "dispatched") {
        indeterminate += 1
        pending.completion.reject(
          new PluginRunnerIndeterminateError(pending.callId),
        )
      } else {
        pending.completion.reject(failure)
      }
    }
    this.#pending.clear()
    if (current.intentionalStop) {
      if (cleanupFailure) {
        current.shutdown?.reject(
          new Error("Plugin runner cleanup failed.", { cause: cleanupFailure }),
        )
      } else {
        current.shutdown?.resolve(undefined)
      }
      return
    }
    current.startup.reject(failure)
    this.#recordFailure(failure, exit, phase, indeterminate)
    if (cleanupFailure !== undefined) {
      // Never overlap a replacement with a process tree we could not prove dead.
      this.#availability = "circuit-open"
      this.#circuitOpenUntil = undefined
      return
    }
    this.#scheduleRestart()
  }

  // Keep the diagnostic's four independent fields explicit at call sites.
  // eslint-disable-next-line max-params
  #recordFailure(
    failure: PluginRunnerUnavailableError,
    exit: RunnerProcessExit,
    phase: RunnerCrashDiagnostic["phase"],
    indeterminateCalls: number,
  ): void {
    const at = this.#scheduler.now()
    this.#failures.push(at)
    this.#failures = this.#recentFailures()
    this.#lastCrash = {
      at,
      phase,
      code: exit.code,
      signal: exit.signal,
      reason: failure.reason,
      indeterminateCalls,
    }
  }

  #scheduleRestart(): void {
    if (this.#shutdownRequested) return
    if (this.#options.shouldRestart?.() === false) {
      this.#availability = "unavailable"
      return
    }
    const failures = this.#recentFailures().length
    if (failures >= this.#config.circuitFailures) {
      this.#availability = "circuit-open"
      this.#circuitOpenUntil =
        this.#scheduler.now() + this.#config.circuitResetMs
      this.#cancelRestart = this.#scheduler.setTimeout(() => {
        this.#circuitOpenUntil = undefined
        this.#availability = "unavailable"
        void this.start().catch(() => {})
      }, this.#config.circuitResetMs)
      return
    }
    const delay = Math.min(
      this.#config.backoffMaxMs,
      this.#config.backoffBaseMs * 2 ** Math.max(0, failures - 1),
    )
    this.#availability = "backing-off"
    this.#backoffUntil = this.#scheduler.now() + delay
    this.#cancelRestart = this.#scheduler.setTimeout(() => {
      this.#backoffUntil = undefined
      this.#availability = "unavailable"
      void this.start().catch(() => {})
    }, delay)
  }

  #recentFailures(): Array<number> {
    const earliest = this.#scheduler.now() - this.#config.circuitWindowMs
    return this.#failures.filter((at) => at >= earliest)
  }

  #remaining(deadline: number | undefined): number | undefined {
    return deadline === undefined ? undefined : (
        Math.max(0, deadline - this.#scheduler.now())
      )
  }

  #availabilityError(): PluginRunnerUnavailableError {
    let reason: RunnerUnavailableReason
    switch (this.#availability) {
      case "backing-off":
      case "circuit-open":
      case "starting": {
        reason = this.#availability
        break
      }
      case "shutting-down":
      case "stopped": {
        reason = "shutting-down"
        break
      }
      default: {
        reason = "not-started"
      }
    }
    return this.#unavailable(reason, `Plugin runner is ${this.#availability}.`)
  }

  // Centralized error creation keeps reason/retry/cause classification uniform.
  // eslint-disable-next-line max-params
  #unavailable(
    reason: RunnerUnavailableReason,
    message: string,
    retryAfterMs?: number,
    cause?: unknown,
  ): PluginRunnerUnavailableError {
    return new PluginRunnerUnavailableError(reason, message, {
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(cause === undefined ? {} : { cause }),
    })
  }
}
