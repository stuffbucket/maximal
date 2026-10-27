import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"

import type { McpBrokerConfig } from "./types"

import {
  brokerExecutableCandidates,
  brokerProcessEnvironment,
  isLiveUpdate,
  resolveBrokerConfiguration,
  type ResolvedBrokerConfiguration,
} from "./configuration"
import {
  BrokerControlProtocolError,
  BrokerFrameDecoder,
  encodeSidecarEnvelope,
  type BrokerEnvelope,
  type ElicitResultPayload,
  type SidecarEnvelope,
} from "./control-protocol"
import { PendingRequests, pendingRequests } from "./pending-requests"
import { createLineSplitter, recordBrokerStderr } from "./server-log"

export type BrokerSupervisorState =
  | "disabled"
  | "starting"
  | "ready"
  | "degraded"
  | "backoff"
  | "circuit-open"
  | "stopping"
  /** Can't run at all on this install; retrying wouldn't help. */
  | "unavailable"

/** Why the broker is `unavailable`. */
export type BrokerProblem = "not-installed" | "unsupported-platform"

export interface BrokerSupervisorSnapshot {
  state: BrokerSupervisorState
  enabledEndpoints: number
  problem: BrokerProblem | null
}

/** Launch errors no restart can fix, mapped to what the user is told. */
const PERMANENT_LAUNCH_ERRORS: Record<string, BrokerProblem> = {
  MCP_BROKER_EXECUTABLE_NOT_FOUND: "not-installed",
  MCP_BROKER_CONTAINMENT_UNAVAILABLE: "unsupported-platform",
}

/** Private loopback address and per-generation key of the ready broker. Held
 *  only in sidecar memory; the `/mcp/<id>` route forwards through it. */
export interface BrokerUpstream {
  origin: string
  apiKey: string
}

let currentSnapshot: BrokerSupervisorSnapshot = {
  state: "disabled",
  enabledEndpoints: 0,
  problem: null,
}
let currentUpstream: BrokerUpstream | undefined
/** Tool names each endpoint of the ready broker offered at startup. */
let currentEndpointTools: ReadonlyMap<string, Array<string>> | undefined

function withdrawUpstream(): void {
  currentUpstream = undefined
  currentEndpointTools = undefined
}

/** The tools endpoint `id` offered when the running broker started;
 *  undefined while no broker is ready. */
export function getBrokerEndpointTools(
  id: string,
): ReadonlyArray<string> | undefined {
  return currentEndpointTools?.get(id)
}

/** Where a broker that was just (re)started got to, for a caller that
 *  wants to act once it serves: `ready` serves, `starting` is still coming
 *  up (or recovering) when the wait ran out, `failed` gave up (can't run on
 *  this install, or kept crashing), `off` has nothing to run. */
export type BrokerReadiness = "ready" | "starting" | "failed" | "off"

/** Readiness for a state, or undefined while the broker may still come up. */
function settledReadiness(
  state: BrokerSupervisorState,
): BrokerReadiness | undefined {
  switch (state) {
    case "ready": {
      return "ready"
    }
    case "disabled": {
      return "off"
    }
    case "unavailable":
    case "circuit-open": {
      return "failed"
    }
    case "starting":
    case "degraded":
    case "backoff":
    case "stopping": {
      return undefined
    }
    default: {
      state satisfies never
      return undefined
    }
  }
}

export function getBrokerSupervisorSnapshot(): BrokerSupervisorSnapshot {
  return currentSnapshot
}

export function getBrokerUpstream(): BrokerUpstream | undefined {
  return currentUpstream
}

interface BrokerGeneration {
  id: string
  child: ChildProcessWithoutNullStreams
  decoder: BrokerFrameDecoder
  expectedSequence: number
  outgoingSequence: number
  apiKey: string
  configuration: ResolvedBrokerConfiguration
  lastHeartbeatAt: number
  processing: Promise<void>
  helloReceived: boolean
  configureAccepted: boolean
  readyReceived: boolean
  startupTimer?: ReturnType<typeof setTimeout>
  shutdownResponse?: () => void
  updateResponse?: (ok: boolean) => void
}

interface SupervisorOptions {
  executableExists?: (candidate: string) => boolean
  forceKillProcessGroup?: (pid: number) => boolean
  now?: () => number
  platform?: NodeJS.Platform
  processPid?: number
  randomBytes?: (size: number) => Buffer
  randomUUID?: () => string
  spawnProcess?: typeof spawn
  /** Where requests for user input wait for an answer. */
  requests?: PendingRequests
  /** Each line the broker writes to stderr: its own codes, and its
   *  servers' stderr tagged with their endpoint. Maximal's log by default. */
  onStderrLine?: (line: string) => void
}

/** How long to wait for the broker to take an update before restarting it
 *  instead. Applying one is synchronous in the broker. */
const UPDATE_TIMEOUT_MS = 5_000

/** Everything but the endpoints: the supervisor's own settings, which a
 *  live update can't change. */
const supervisionKey = ({ servers: _servers, ...rest }: McpBrokerConfig) =>
  JSON.stringify(rest)

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/** Read through a call so a check after `await` isn't narrowed away. */
const hasExited = (generation: BrokerGeneration): boolean =>
  generation.child.exitCode !== null

function forceKillProcessGroup(pid: number): boolean {
  try {
    process.kill(-pid, "SIGKILL")
    return true
  } catch {
    return false
  }
}

export class BrokerSupervisor {
  #config: McpBrokerConfig
  readonly #executableExists: (candidate: string) => boolean
  readonly #forceKillProcessGroup: (pid: number) => boolean
  readonly #now: () => number
  readonly #platform: NodeJS.Platform
  readonly #processPid: number
  readonly #randomBytes: (size: number) => Buffer
  readonly #randomUUID: () => string
  readonly #spawnProcess: typeof spawn
  readonly #requests: PendingRequests
  readonly #onStderrLine: (line: string) => void
  #generation: BrokerGeneration | undefined
  #stopping = false
  #restartTimes: Array<number> = []
  #restartAttempt = 0
  #restartTimer: ReturnType<typeof setTimeout> | undefined
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined
  #stableTimer: ReturnType<typeof setTimeout> | undefined
  #stopPromise: Promise<void> | undefined
  #state: BrokerSupervisorState = "disabled"
  readonly #stateListeners = new Set<() => void>()

  constructor(config: McpBrokerConfig, options: SupervisorOptions = {}) {
    this.#config = config
    this.#executableExists = options.executableExists ?? fs.existsSync
    this.#forceKillProcessGroup =
      options.forceKillProcessGroup ?? forceKillProcessGroup
    this.#now = options.now ?? Date.now
    this.#platform = options.platform ?? process.platform
    this.#processPid = options.processPid ?? process.pid
    this.#randomBytes = options.randomBytes ?? crypto.randomBytes
    this.#randomUUID = options.randomUUID ?? crypto.randomUUID
    this.#spawnProcess = options.spawnProcess ?? spawn
    this.#requests = options.requests ?? pendingRequests
    this.#onStderrLine = options.onStderrLine ?? recordBrokerStderr
    this.#setState("disabled")
  }

  start(): void {
    if (this.#stopping || this.#generation) return
    if (this.#config.enabled !== true) {
      this.#setState("disabled")
      withdrawUpstream()
      return
    }
    this.#beginLaunch()
  }

  #beginLaunch(): void {
    if (this.#stopping || this.#generation) return
    try {
      this.#launch()
    } catch (error) {
      const problem =
        error instanceof Error ?
          PERMANENT_LAUNCH_ERRORS[error.message]
        : undefined
      if (problem) {
        // Retrying can't fix a missing executable or an unsupported platform;
        // stop here and say why, instead of cycling backoff/circuit forever.
        this.#setState("unavailable", problem)
        return
      }
      this.#scheduleRestart()
    }
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#performStop()
    return this.#stopPromise
  }

  /**
   * Apply `config` to the running broker without restarting it, when only
   * how a new session's instance starts changed (an upgraded server's new
   * path, say). Sessions already running keep the instance they have.
   * False when there's no ready broker, the change needs a restart, or the
   * broker didn't take it; the caller then restarts.
   */
  async update(config: McpBrokerConfig): Promise<boolean> {
    const generation = this.#generation
    if (!generation?.readyReceived || this.#stopping) return false
    if (generation.updateResponse) return false
    if (supervisionKey(config) !== supervisionKey(this.#config)) return false
    let next: ResolvedBrokerConfiguration
    try {
      next = resolveBrokerConfiguration(config)
    } catch {
      return false
    }
    if (!isLiveUpdate(generation.configuration, next)) return false

    // Settles once: the broker's answer, a failed send, or the timeout.
    // Assigned synchronously by the Promise executor below.
    let finish!: (ok: boolean) => void
    const answered = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), UPDATE_TIMEOUT_MS)
      finish = (ok) => {
        clearTimeout(timer)
        if (generation.updateResponse === finish) {
          generation.updateResponse = undefined
        }
        resolve(ok)
      }
    })
    generation.updateResponse = finish
    await this.#send(generation, {
      operation: "update",
      requestId: "update",
      payload: { configuration: next },
    }).catch(() => finish(false))
    if (!(await answered) || this.#generation !== generation) return false
    generation.configuration = next
    this.#config = config
    return true
  }

  async #performStop(): Promise<void> {
    this.#stopping = true
    this.#setState("stopping")
    this.#clearTimers()
    withdrawUpstream()

    const generation = this.#generation
    if (generation) {
      this.#requests.dropGeneration(generation.id)
      await this.#stopGeneration(generation)
    }
    if (this.#generation === generation) this.#generation = undefined
    this.#setState("disabled")
  }

  /**
   * Resolve once the broker serves, gives up, or has nothing to run; after
   * `timeoutMs`, resolve with `starting`. Never rejects, and never starts or
   * restarts anything itself.
   */
  waitUntilReady(timeoutMs: number): Promise<BrokerReadiness> {
    const settled = settledReadiness(this.#state)
    if (settled) return Promise.resolve(settled)
    return new Promise((resolve) => {
      const finish = (readiness: BrokerReadiness) => {
        clearTimeout(timer)
        this.#stateListeners.delete(listener)
        resolve(readiness)
      }
      const listener = () => {
        const readiness = settledReadiness(this.#state)
        if (readiness) finish(readiness)
      }
      const timer = setTimeout(() => finish("starting"), timeoutMs)
      timer.unref()
      this.#stateListeners.add(listener)
    })
  }

  #setState(
    state: BrokerSupervisorState,
    problem: BrokerProblem | null = null,
  ): void {
    this.#state = state
    for (const listener of this.#stateListeners) listener()
    currentSnapshot = {
      state,
      enabledEndpoints: (this.#config.servers ?? []).filter(
        (server) => server.enabled !== false,
      ).length,
      problem,
    }
  }

  #resolveExecutable(): string {
    const executable = brokerExecutableCandidates(
      this.#config.executablePath,
    ).find((candidate) => this.#executableExists(candidate))
    if (!executable) throw new Error("MCP_BROKER_EXECUTABLE_NOT_FOUND")
    return executable
  }

  /** Spawns synchronously, so `#generation` is set before any concurrent
   *  start/stop can observe the supervisor. */
  #launch(): void {
    if (this.#stopping) return
    this.#setState("starting")
    withdrawUpstream()

    if (this.#platform === "win32") {
      // A kill-on-close Job Object has not been wired yet. Running without one
      // would violate the containment contract and could orphan MCP descendants.
      throw new Error("MCP_BROKER_CONTAINMENT_UNAVAILABLE")
    }

    const executable = this.#resolveExecutable()
    const configuration = resolveBrokerConfiguration(this.#config)
    const id = this.#randomUUID()
    const child = this.#spawnProcess(
      executable,
      ["serve", "--generation", id, "--parent-pid", String(this.#processPid)],
      {
        detached: true,
        env: brokerProcessEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    )

    const generation: BrokerGeneration = {
      id,
      child: child,
      decoder: new BrokerFrameDecoder(
        this.#config.limits?.ipcFrameBytes ?? 1024 * 1024,
      ),
      expectedSequence: 0,
      outgoingSequence: 0,
      apiKey: this.#randomBytes(32).toString("base64url"),
      configuration,
      lastHeartbeatAt: this.#now(),
      processing: Promise.resolve(),
      helloReceived: false,
      configureAccepted: false,
      readyReceived: false,
    }
    this.#generation = generation

    child.stderr.on("data", createLineSplitter(this.#onStderrLine))
    child.stdout.on("data", (chunk: Buffer) => {
      generation.processing = generation.processing
        .then(async () => {
          const envelopes = generation.decoder.push(chunk)
          for (const envelope of envelopes) {
            await this.#handleEnvelope(generation, envelope)
          }
        })
        .catch(() => this.#failGeneration(generation))
    })
    child.once("error", () => this.#failGeneration(generation))
    child.once("exit", () => {
      if (this.#generation !== generation) return
      this.#forceKillGeneration(generation)
      this.#requests.dropGeneration(generation.id)
      this.#generation = undefined
      withdrawUpstream()
      this.#clearGenerationTimers(generation)
      this.#clearGenerationMonitors()
      if (!this.#stopping) this.#scheduleRestart()
    })

    const startupTimeout = this.#config.supervision?.startupTimeoutMs ?? 30_000
    generation.startupTimer = setTimeout(
      () => this.#failGeneration(generation),
      startupTimeout,
    )
    generation.startupTimer.unref()

    const heartbeatDeadline =
      this.#config.supervision?.heartbeatDeadlineMs ?? 10_000
    this.#heartbeatTimer = setInterval(
      () => {
        const active = this.#generation
        if (
          active
          && active.configureAccepted
          && this.#now() - active.lastHeartbeatAt > heartbeatDeadline
        ) {
          this.#failGeneration(active)
        }
      },
      Math.min(heartbeatDeadline, 2_000),
    )
    this.#heartbeatTimer.unref()
  }

  async #handleEnvelope(
    generation: BrokerGeneration,
    envelope: BrokerEnvelope,
  ): Promise<void> {
    if (this.#generation !== generation) return
    if (
      envelope.generation !== generation.id
      || envelope.sequence !== generation.expectedSequence
    ) {
      throw new BrokerControlProtocolError("CONTROL_SEQUENCE_MISMATCH")
    }
    generation.expectedSequence += 1

    // A request for input carries its own expiry, and a withdrawal is valid
    // however late; neither is dropped as stale.
    if (envelope.operation === "elicit") {
      this.#onElicit(generation, envelope)
      return
    }
    if (envelope.operation === "elicitWithdrawn") {
      this.#requests.withdraw(envelope.requestId)
      return
    }
    if (this.#now() > envelope.deadlineMs) return

    switch (envelope.operation) {
      case "hello": {
        await this.#onHello(generation)
        return
      }
      case "response": {
        this.#onResponse(generation, envelope)
        return
      }
      case "ready": {
        this.#onReady(generation, envelope.payload)
        return
      }
      case "heartbeat": {
        if (!generation.readyReceived) {
          throw new BrokerControlProtocolError("CONTROL_HEARTBEAT_BEFORE_READY")
        }
        generation.lastHeartbeatAt = this.#now()
        return
      }
      default: {
        // "status" is the only remaining broker operation.
        if (envelope.payload.state === "degraded") this.#setState("degraded")
      }
    }
  }

  #onElicit(
    generation: BrokerGeneration,
    envelope: Extract<BrokerEnvelope, { operation: "elicit" }>,
  ): void {
    if (!generation.readyReceived) {
      throw new BrokerControlProtocolError("CONTROL_ELICIT_BEFORE_READY")
    }
    const { requestId } = envelope
    const reply = (payload: ElicitResultPayload) => {
      void this.#send(generation, {
        operation: "elicitResult",
        requestId,
        payload,
      }).catch(() => undefined)
    }
    const added = this.#requests.add({
      generation: generation.id,
      requestId,
      payload: envelope.payload,
      answer: reply,
    })
    // A form Maximal can't show is declined rather than left waiting.
    if (!added) reply({ action: "decline" })
  }

  async #onHello(generation: BrokerGeneration): Promise<void> {
    if (generation.helloReceived) {
      throw new BrokerControlProtocolError("CONTROL_DUPLICATE_HELLO")
    }
    generation.helloReceived = true
    await this.#send(generation, {
      operation: "configure",
      requestId: "configure",
      payload: {
        apiKey: generation.apiKey,
        configuration: generation.configuration,
      },
    })
  }

  #onResponse(
    generation: BrokerGeneration,
    envelope: Extract<BrokerEnvelope, { operation: "response" }>,
  ): void {
    if (envelope.requestId === "configure") {
      if (!generation.helloReceived || generation.configureAccepted) {
        throw new BrokerControlProtocolError(
          "CONTROL_UNEXPECTED_CONFIGURE_RESPONSE",
        )
      }
      if (!envelope.payload.ok) throw new Error(envelope.payload.code)
      generation.configureAccepted = true
      return
    }
    if (envelope.requestId === "update") {
      // A late answer to an update that timed out is harmless: the caller
      // has already restarted the broker.
      generation.updateResponse?.(envelope.payload.ok)
      return
    }
    if (envelope.requestId === "shutdown") {
      const shutdownResponse = generation.shutdownResponse
      if (!shutdownResponse) {
        throw new BrokerControlProtocolError(
          "CONTROL_UNEXPECTED_SHUTDOWN_RESPONSE",
        )
      }
      generation.shutdownResponse = undefined
      shutdownResponse()
      return
    }
    throw new BrokerControlProtocolError("CONTROL_UNEXPECTED_RESPONSE")
  }

  #onReady(
    generation: BrokerGeneration,
    payload: Extract<BrokerEnvelope, { operation: "ready" }>["payload"],
  ): void {
    if (!generation.configureAccepted) {
      throw new BrokerControlProtocolError("CONTROL_READY_BEFORE_CONFIGURE")
    }
    if (generation.readyReceived) {
      throw new BrokerControlProtocolError("CONTROL_DUPLICATE_READY")
    }
    const observedIds = new Set(
      payload.endpoints.map((endpoint) => endpoint.id),
    )
    if (
      observedIds.size !== payload.endpoints.length
      || observedIds.size !== generation.configuration.endpoints.length
      || generation.configuration.endpoints.some(
        (endpoint) => !observedIds.has(endpoint.id),
      )
    ) {
      throw new BrokerControlProtocolError("CONTROL_ENDPOINT_MISMATCH")
    }
    generation.readyReceived = true
    if (this.#generation !== generation || this.#stopping) return
    currentUpstream = {
      origin: `http://${payload.host}:${payload.port}`,
      apiKey: generation.apiKey,
    }
    currentEndpointTools = new Map(
      payload.endpoints.map((endpoint) => [endpoint.id, endpoint.tools]),
    )
    this.#clearGenerationTimers(generation)
    generation.lastHeartbeatAt = this.#now()
    this.#setState("ready")

    const stableRuntime = this.#config.supervision?.circuitResetMs ?? 60_000
    this.#stableTimer = setTimeout(() => {
      if (this.#generation === generation) {
        this.#restartTimes = []
        this.#restartAttempt = 0
      }
    }, stableRuntime)
    this.#stableTimer.unref()
  }

  async #send(
    generation: BrokerGeneration,
    envelope: SidecarEnvelope,
  ): Promise<void> {
    if (this.#generation !== generation) return
    await this.#sendDetached(generation, envelope)
  }

  #failGeneration(generation: BrokerGeneration): void {
    if (this.#generation !== generation || this.#stopping) return
    this.#requests.dropGeneration(generation.id)
    this.#generation = undefined
    withdrawUpstream()
    this.#clearGenerationTimers(generation)
    this.#clearGenerationMonitors()
    this.#setState("degraded")
    void this.#stopGeneration(generation)
      .catch(() => undefined)
      .finally(() => this.#scheduleRestart())
  }

  /**
   * The only thing that restarts a failed broker on its own: doubling
   * backoff from restartBackoffMinMs, clamped at restartBackoffMaxMs, with a
   * pause after restartBudget restarts in restartWindowMs. Requests to
   * /mcp/* never trigger a restart — they get an immediate 503 — so a
   * client's own retry loop can't become a broker restart loop. Explicit
   * user actions (toggling an endpoint, restarting Maximal) start fresh.
   */
  #scheduleRestart(): void {
    if (this.#stopping) return
    // A repeated start() after a failed launch must not stack restart timers.
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    const now = this.#now()
    const windowMs = this.#config.supervision?.restartWindowMs ?? 60_000
    const budget = this.#config.supervision?.restartBudget ?? 5
    this.#restartTimes = this.#restartTimes.filter(
      (timestamp) => now - timestamp < windowMs,
    )
    this.#restartTimes.push(now)

    if (this.#restartTimes.length > budget) {
      this.#setState("circuit-open")
      const resetMs = this.#config.supervision?.circuitResetMs ?? 60_000
      this.#restartTimer = setTimeout(() => {
        // Keep #restartAttempt: a broker that still won't come up settles at
        // the backoff clamp (one try per restartBackoffMaxMs) instead of
        // bursting through the budget again. Only 60s of stable "ready"
        // resets it (see #onReady).
        this.#restartTimes = []
        this.#beginLaunch()
      }, resetMs)
      this.#restartTimer.unref()
      return
    }

    this.#setState("backoff")
    const minimum = this.#config.supervision?.restartBackoffMinMs ?? 500
    const maximum = this.#config.supervision?.restartBackoffMaxMs ?? 30_000
    const base = Math.min(maximum, minimum * 2 ** this.#restartAttempt)
    this.#restartAttempt += 1
    const jitter = Math.floor(
      base * (this.#randomBytes(2).readUInt16BE() / 65_535) * 0.2,
    )
    this.#restartTimer = setTimeout(
      () => {
        this.#beginLaunch()
      },
      Math.min(maximum, base + jitter),
    )
    this.#restartTimer.unref()
  }

  async #stopGeneration(generation: BrokerGeneration): Promise<void> {
    this.#clearGenerationTimers(generation)
    if (hasExited(generation)) {
      this.#forceKillGeneration(generation)
      return
    }

    const acknowledged = new Promise<boolean>((resolve) => {
      generation.shutdownResponse = () => resolve(true)
    })
    await this.#sendDetached(generation, {
      operation: "shutdown",
      requestId: "shutdown",
      payload: {},
    }).catch(() => undefined)

    const gracefulMs = this.#config.supervision?.gracefulShutdownMs ?? 1_000
    const graceful = await Promise.race([
      acknowledged,
      delay(gracefulMs).then(() => false),
    ])
    if (graceful) await delay(25)
    if (hasExited(generation)) return

    this.#forceKillGeneration(generation)
  }

  #forceKillGeneration(generation: BrokerGeneration): void {
    const pid = generation.child.pid
    if (pid && this.#platform !== "win32" && this.#forceKillProcessGroup(pid)) {
      return
    }
    generation.child.kill("SIGKILL")
  }

  /** Write a frame even if the generation is no longer current (shutdown). */
  async #sendDetached(
    generation: BrokerGeneration,
    envelope: SidecarEnvelope,
  ): Promise<void> {
    const frame = encodeSidecarEnvelope(envelope, {
      generation: generation.id,
      sequence: generation.outgoingSequence,
      deadlineMs: this.#now() + 10_000,
      maxFrameBytes: this.#config.limits?.ipcFrameBytes,
    })
    generation.outgoingSequence += 1
    await new Promise<void>((resolve, reject) => {
      generation.child.stdin.write(frame, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  #clearGenerationTimers(generation: BrokerGeneration): void {
    if (generation.startupTimer) clearTimeout(generation.startupTimer)
  }

  #clearGenerationMonitors(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer)
    if (this.#stableTimer) clearTimeout(this.#stableTimer)
    this.#heartbeatTimer = undefined
    this.#stableTimer = undefined
  }

  #clearTimers(): void {
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer)
    if (this.#stableTimer) clearTimeout(this.#stableTimer)
    this.#restartTimer = undefined
    this.#heartbeatTimer = undefined
    this.#stableTimer = undefined
  }
}

/** The process-wide supervisor, replaced when endpoint config changes. Only
 *  the server process starts one; elsewhere (e.g. the CLI) it stays unset. */
let activeSupervisor: BrokerSupervisor | undefined
let activeConfig: McpBrokerConfig | undefined
let activeConfigJson: string | undefined
let reconfiguring: Promise<void> = Promise.resolve()

/** What the running broker depends on. Endpoints that are off and the
 *  client apps an endpoint is offered to don't change what it serves, so
 *  adding an endpoint or re-picking its apps doesn't restart live sessions. */
function brokerConfigKey(config: McpBrokerConfig): string {
  return JSON.stringify({
    ...config,
    servers: (config.servers ?? [])
      .filter((server) => server.enabled !== false)
      .map(({ clients: _clients, catalog: _catalog, ...server }) => server),
  })
}

export function startBrokerSupervisor(config: McpBrokerConfig): void {
  activeSupervisor = new BrokerSupervisor(config)
  activeConfig = config
  activeConfigJson = brokerConfigKey(config)
  activeSupervisor.start()
}

/** Run broker changes one at a time, so the most recent one always wins. */
function serialized(run: () => Promise<boolean>): Promise<boolean> {
  const pending = reconfiguring.then(run, run)
  reconfiguring = pending.then(
    () => undefined,
    () => undefined,
  )
  return pending
}

/** Apply new config to the broker: nothing when it's unchanged, a live
 *  update when only how new session instances start changed, otherwise a
 *  restart. Returns false when no supervisor is running in this process
 *  (the caller should ask the running server to reload). Calls run one at a
 *  time, so the most recent config always wins. */
export function reconfigureBroker(config: McpBrokerConfig): Promise<boolean> {
  return serialized(async () => {
    const previous = activeSupervisor
    if (!previous) return false
    const key = brokerConfigKey(config)
    if (key === activeConfigJson) return true
    if (await previous.update(config)) {
      // Calls are serialized through `reconfiguring`, so nothing raced us.
      // eslint-disable-next-line require-atomic-updates
      activeConfigJson = key
      activeConfig = config
      return true
    }
    await previous.stop()
    // Shut down while we waited: don't bring a broker back.
    if (activeSupervisor !== previous) return false
    startBrokerSupervisor(config)
    return true
  })
}

/**
 * Restart the broker with the config it has, so every endpoint is probed
 * again (after the user signs in to a server, say). Sessions running now
 * end. False when no supervisor runs in this process.
 */
export function restartBroker(): Promise<boolean> {
  return serialized(async () => {
    const previous = activeSupervisor
    const config = activeConfig
    if (!previous || !config) return false
    await previous.stop()
    if (activeSupervisor !== previous) return false
    startBrokerSupervisor(config)
    return true
  })
}

/**
 * Wait, at most `timeoutMs`, for the broker to serve after the latest
 * start or reconfigure, so clients aren't pointed at it while it is still
 * probing its servers (when `/mcp/<id>` answers 503). Follows a supervisor
 * that a later reconfigure swaps in. `off` when no broker runs in this
 * process (e.g. the CLI).
 */
export async function waitForBrokerReady(
  timeoutMs: number,
): Promise<BrokerReadiness> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await reconfiguring
    const supervisor = activeSupervisor
    if (!supervisor) return "off"
    const readiness = await supervisor.waitUntilReady(
      Math.max(0, deadline - Date.now()),
    )
    // A reconfigure stopped this one to start another: wait for that.
    if (activeSupervisor === supervisor || !activeSupervisor) return readiness
    if (Date.now() >= deadline) return "starting"
  }
}

/** Stop the broker for good: later reconfigures find no supervisor and
 *  report false, so nothing restarts it during shutdown. */
export function stopBrokerSupervisor(): Promise<void> {
  const supervisor = activeSupervisor
  activeSupervisor = undefined
  activeConfig = undefined
  activeConfigJson = undefined
  return supervisor?.stop() ?? Promise.resolve()
}
