/* eslint-disable max-lines -- the deterministic cutover matrix is intentionally colocated */
import type { PluginGatewayEvent } from "@stuffbucket/maximal-plugin-sdk/gateway"

import { ResourceHandoffError } from "@stuffbucket/maximal-plugin-host"
import { describe, expect, test } from "bun:test"

import {
  GenerationCutoverCoordinator,
  candidateHealthRegression,
  type CandidateReady,
  type CandidateSpec,
  type ControlPlaneFence,
  type DurableGenerationJournal,
  type ExclusiveHandoff,
  type ExclusiveResourceManager,
  type GenerationActivationDeclaration,
  type GenerationCommitRecord,
  type GenerationEvent,
  type GenerationRunner,
  type GenerationSupervisor,
  type PluginHealth,
  type ProjectedGenerationTarget,
  type StateBroker,
} from "~/lib/plugins/generation-cutover"
import { PluginGenerationLifecycleRegistry } from "~/lib/plugins/generation-lifecycle"

type Snapshot = { value: string }
type Gateway = { name: string }

const fence = (epoch = 1, settings = 1, provider = 1): ControlPlaneFence => ({
  epoch,
  settingsRevisions: { plugin: settings },
  providerRevisions: { copilot: provider },
})

const health = (
  state: PluginHealth["state"] = "active",
  pluginId = "plugin",
): Array<PluginHealth> => [{ pluginId, state }]

const gatewayEvent = (type: PluginGatewayEvent["type"] = "status") => ({
  type,
  pluginId: "plugin",
})

class FakeRunner implements GenerationRunner<Snapshot, Gateway> {
  readonly generationId: string
  readonly artifactId: string
  readonly gateway: Gateway
  readonly listeners = new Set<(event: GenerationEvent) => void>()
  readonly resyncs: Array<{ sequence: number; reason: string }> = []
  readonly activation: GenerationActivationDeclaration
  negotiateImpl: (signal: AbortSignal) => Promise<void> = () =>
    Promise.resolve()
  prepareImpl: (
    requested: ControlPlaneFence,
    signal: AbortSignal,
  ) => Promise<CandidateReady<Snapshot>>
  beginDrainImpl: (signal: AbortSignal) => Promise<void> = () =>
    Promise.resolve()
  stopImpl: (signal: AbortSignal) => Promise<void> = () => Promise.resolve()
  failSubscribe = false
  stopped = 0
  drained = 0

  constructor(
    generationId: string,
    artifactId: string,
    options?: {
      ready?: Partial<CandidateReady<Snapshot>>
      resources?: ReadonlyArray<string>
    },
  ) {
    this.generationId = generationId
    this.artifactId = artifactId
    this.gateway = { name: generationId }
    const resources = options?.resources ?? ["figjam:4150"]
    this.activation =
      resources.length === 0 ?
        { mode: "overlap-safe" }
      : { mode: "exclusive", resources }
    this.prepareImpl = (requested) =>
      Promise.resolve({
        generationId,
        artifactId,
        fence: requested,
        snapshot: { value: generationId },
        snapshotRevision: 0,
        snapshotComplete: true,
        health: health(),
        ...options?.ready,
      })
  }

  subscribe(listener: (event: GenerationEvent) => void): () => void {
    if (this.failSubscribe) throw new Error("subscription failed")
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: GenerationEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  negotiate(signal: AbortSignal): Promise<void> {
    return this.negotiateImpl(signal)
  }

  prepare(
    requested: ControlPlaneFence,
    signal: AbortSignal,
  ): Promise<CandidateReady<Snapshot>> {
    return this.prepareImpl(requested, signal)
  }

  requestResync(sequence: number, reason: string): Promise<void> {
    this.resyncs.push({ sequence, reason })
    return Promise.resolve()
  }

  async beginDrain(signal: AbortSignal): Promise<void> {
    this.drained += 1
    await this.beginDrainImpl(signal)
  }

  stop(signal: AbortSignal): Promise<void> {
    this.stopped += 1
    return this.stopImpl(signal)
  }
}

class FakeSupervisor implements GenerationSupervisor<Snapshot, Gateway> {
  readonly candidate: FakeRunner
  spawned = 0
  restarted = 0
  restartRunner?: FakeRunner
  restorations = 0

  constructor(candidate: FakeRunner) {
    this.candidate = candidate
  }

  spawn(_spec: CandidateSpec, _signal: AbortSignal): Promise<FakeRunner> {
    this.spawned += 1
    return Promise.resolve(this.candidate)
  }

  restartCommitted(
    record: GenerationCommitRecord<Snapshot>,
    _signal: AbortSignal,
  ): Promise<FakeRunner> {
    this.restarted += 1
    this.restartRunner ??= new FakeRunner(
      record.generationId,
      record.artifactId,
    )
    return Promise.resolve(this.restartRunner)
  }

  restoreActive(
    _runner: GenerationRunner<Snapshot, Gateway>,
    _signal: AbortSignal,
  ): Promise<void> {
    this.restorations += 1
    return Promise.resolve()
  }
}

class FakeState implements StateBroker<Snapshot> {
  currentFence = fence()
  cas = true
  publicEvents: Array<{ generationId: string; event: GenerationEvent }> = []
  callbacks: Array<{ generationId: string; callId: string; value: unknown }> =
    []
  diffs: Array<string> = []
  diffEventCounts: Array<number> = []
  timeline: Array<string> = []
  readonly published = new Set<string>()
  commitLocks = 0
  failDiffOnce = false
  beforeCommit?: () => void
  duringDiff?: () => void

  readFence(): ControlPlaneFence {
    return structuredClone(this.currentFence)
  }

  compareAndSetFence(_expected: ControlPlaneFence): Promise<boolean> {
    return Promise.resolve(this.cas)
  }

  async withCommitLock<T>(run: () => Promise<T>): Promise<T> {
    this.commitLocks += 1
    this.beforeCommit?.()
    return await run()
  }

  publishActiveEvent(generationId: string, event: GenerationEvent): void {
    this.publicEvents.push({ generationId, event })
    this.timeline.push(`event:${generationId}`)
  }

  publishCallCallback(
    generationId: string,
    callId: string,
    value: unknown,
  ): void {
    this.callbacks.push({ generationId, callId, value })
  }

  publishDiff(input: {
    commitId: string
    events: ReadonlyArray<GenerationEvent>
  }): void {
    this.duringDiff?.()
    if (this.failDiffOnce) {
      this.failDiffOnce = false
      throw new Error("crash after pointer install")
    }
    if (!this.published.has(input.commitId)) {
      this.published.add(input.commitId)
      this.diffs.push(input.commitId)
      this.diffEventCounts.push(input.events.length)
      this.timeline.push(`diff:${input.commitId}`)
    }
  }
}

class FakeProjection implements ProjectedGenerationTarget<Snapshot, Gateway> {
  generation = "old"
  snapshot: Snapshot = { value: "old" }
  failInstall = false
  installs = 0

  currentGenerationId(): string {
    return this.generation
  }

  install(input: {
    generationId: string
    snapshot: Snapshot
    gateway: Gateway
  }): void {
    this.installs += 1
    if (this.failInstall) {
      this.failInstall = false
      throw new Error("crash after durable point")
    }
    expect(input.gateway.name).toBe(input.generationId)
    this.snapshot = structuredClone(input.snapshot)
    this.generation = input.generationId
  }

  acquireLease(): string {
    return this.generation
  }
}

class FakeResources implements ExclusiveResourceManager<Snapshot> {
  failHandoff = false
  handoffs = 0
  rollbacks = 0
  finishes = 0
  recoveries = 0
  restorations = 0
  failRollback = false
  failFinishOnce = false

  async handoff(
    input: Parameters<ExclusiveResourceManager<Snapshot>["handoff"]>[0],
    _signal: AbortSignal,
  ): Promise<ExclusiveHandoff> {
    this.handoffs += 1
    if (this.failHandoff) throw new Error("exclusive handoff failed")
    try {
      const state = await input.commitDurably(input.idempotencyKey)
      if (state !== "committed")
        throw new Error("durable generation commit was declined")
    } catch (error) {
      this.rollbacks += 1
      if (this.failRollback)
        throw new ResourceHandoffError(
          "resource handoff recovery failed",
          error,
          new Error("rollback failed"),
        )
      throw error
    }
    return {
      rollback: () => {
        this.rollbacks += 1
        return this.failRollback ?
            Promise.reject(new Error("rollback failed"))
          : Promise.resolve()
      },
      finish: () => {
        this.finishes += 1
        if (this.failFinishOnce) {
          this.failFinishOnce = false
          return Promise.reject(new Error("handoff finalization failed"))
        }
        return Promise.resolve()
      },
    }
  }

  recover(
    _record: GenerationCommitRecord<Snapshot>,
    _signal: AbortSignal,
  ): Promise<void> {
    this.recoveries += 1
    return Promise.resolve()
  }

  restoreOld(
    _generationId: string,
    _resources: ReadonlyArray<string>,
    _signal: AbortSignal,
  ): Promise<void> {
    this.restorations += 1
    return Promise.resolve()
  }
}

class FakeJournal implements DurableGenerationJournal<Snapshot> {
  record?: GenerationCommitRecord<Snapshot>
  failPersist = false
  installed = new Set<string>()
  published = new Set<string>()

  committed(
    _signal: AbortSignal,
  ): Promise<GenerationCommitRecord<Snapshot> | undefined> {
    return Promise.resolve(this.record)
  }

  commitDurably(
    idempotencyKey: string,
    record: GenerationCommitRecord<Snapshot>,
    _signal: AbortSignal,
  ): Promise<"committed" | "not-committed"> {
    if (this.failPersist)
      return Promise.reject(new Error("crash before durable point"))
    if (idempotencyKey !== record.handoffIdempotencyKey)
      return Promise.reject(new Error("handoff idempotency key changed"))
    if (this.record && this.record.commitId !== record.commitId)
      return Promise.reject(new Error("different generation already selected"))
    this.record ??= structuredClone(record)
    return Promise.resolve("committed")
  }

  queryDurableCommit(
    idempotencyKey: string,
    _signal: AbortSignal,
  ): Promise<"committed" | "not-committed"> {
    return Promise.resolve(
      this.record?.handoffIdempotencyKey === idempotencyKey ?
        "committed"
      : "not-committed",
    )
  }

  markInstalled(commitId: string, _signal: AbortSignal): Promise<void> {
    this.installed.add(commitId)
    return Promise.resolve()
  }

  markPublished(commitId: string, _signal: AbortSignal): Promise<void> {
    this.published.add(commitId)
    return Promise.resolve()
  }
}

function setup(options?: {
  candidate?: FakeRunner
  oldHealth?: ReadonlyArray<PluginHealth>
  negotiateTimeoutMs?: number
  prepareTimeoutMs?: number
  operationTimeoutMs?: number
  maxBufferedEvents?: number
  maxBufferedBytes?: number
}) {
  const old = new FakeRunner("old", "artifact-old", { resources: [] })
  const candidate = options?.candidate ?? new FakeRunner("new", "artifact-new")
  const supervisor = new FakeSupervisor(candidate)
  const state = new FakeState()
  const projection = new FakeProjection()
  const resources = new FakeResources()
  const journal = new FakeJournal()
  const coordinator = new GenerationCutoverCoordinator({
    supervisor,
    state,
    projection,
    resources,
    journal,
    activeRunner: old,
    activeHealth: options?.oldHealth ?? health(),
    lifecycle: new PluginGenerationLifecycleRegistry(),
    options: {
      negotiateTimeoutMs: options?.negotiateTimeoutMs ?? 50,
      prepareTimeoutMs: options?.prepareTimeoutMs ?? 50,
      operationTimeoutMs: options?.operationTimeoutMs ?? 50,
      maxBufferedEvents: options?.maxBufferedEvents,
      maxBufferedBytes: options?.maxBufferedBytes,
    },
  })
  return {
    old,
    candidate,
    supervisor,
    state,
    projection,
    resources,
    journal,
    coordinator,
  }
}

const spec: CandidateSpec = {
  commitId: "commit-new",
  handoffIdempotencyKey: "handoff-old-to-new",
  generationId: "new",
  artifactId: "artifact-new",
}

const committedRecord = (
  overrides?: Partial<GenerationCommitRecord<Snapshot>>,
): GenerationCommitRecord<Snapshot> => ({
  commitId: spec.commitId,
  handoffIdempotencyKey: spec.handoffIdempotencyKey,
  previousGenerationId: "old",
  generationId: spec.generationId,
  artifactId: spec.artifactId,
  fence: fence(),
  snapshot: { value: "new" },
  snapshotRevision: 0,
  health: health(),
  previousHealth: health(),
  resources: ["figjam:4150"],
  events: [],
  ...overrides,
})

const hangs = () => new Promise<never>(() => {})

async function expectRejection(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  let failure: unknown
  try {
    await promise
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toContain(message)
}

describe("candidate validation", () => {
  test.each([
    ["epoch", fence(2, 1, 1)],
    ["settings revision", fence(1, 2, 1)],
    ["provider revision", fence(1, 1, 2)],
  ])("rejects stale %s without public mutation", async (_name, stale) => {
    const candidate = new FakeRunner("new", "artifact-new", {
      ready: { fence: stale },
    })
    const context = setup({ candidate })
    await expectRejection(
      context.coordinator.prepareAndCutover(spec),
      "control-plane epoch or revision is stale",
    )
    expect(context.projection.generation).toBe("old")
    expect(context.state.diffs).toEqual([])
    expect(context.state.publicEvents).toEqual([])
    expect(context.journal.record).toBeUndefined()
  })

  test.each(["epoch recheck", "CAS"] as const)(
    "rejects a stale final %s without handoff",
    async (failure) => {
      const context = setup()
      if (failure === "epoch recheck") {
        context.state.beforeCommit = () => {
          context.state.currentFence = fence(2)
        }
      } else {
        context.state.cas = false
      }
      await expectRejection(
        context.coordinator.prepareAndCutover(spec),
        "control-plane",
      )
      expect(context.resources.handoffs).toBe(0)
      expect(context.projection.generation).toBe("old")
      expect(context.journal.record).toBeUndefined()
      expect(context.state.diffs).toEqual([])
    },
  )

  test("rejects incomplete and wrong-identity snapshots", async () => {
    for (const ready of [
      { snapshotComplete: false },
      { generationId: "stale" },
      { artifactId: "stale" },
    ]) {
      const context = setup({
        candidate: new FakeRunner("new", "artifact-new", { ready }),
      })
      await expectRejection(
        context.coordinator.prepareAndCutover(spec),
        "Candidate rejected",
      )
      expect(context.projection.generation).toBe("old")
      expect(context.state.diffs).toHaveLength(0)
    }
  })

  test("requests resync and rejects sequence and state revision gaps", async () => {
    for (const events of [
      [
        {
          kind: "notice" as const,
          sequence: 2,
          event: gatewayEvent("notice"),
        },
      ],
      [
        {
          kind: "state" as const,
          sequence: 1,
          revision: 1,
          event: gatewayEvent(),
        },
        {
          kind: "state" as const,
          sequence: 2,
          revision: 3,
          event: gatewayEvent(),
        },
      ],
    ]) {
      const candidate = new FakeRunner("new", "artifact-new")
      const originalPrepare = candidate.prepareImpl
      candidate.prepareImpl = async (requested, signal) => {
        for (const event of events) candidate.emit(event)
        return await originalPrepare(requested, signal)
      }
      const context = setup({ candidate })
      await expectRejection(
        context.coordinator.prepareAndCutover(spec),
        "protocol gap",
      )
      await Promise.resolve()
      expect(candidate.resyncs).toHaveLength(1)
      expect(context.state.diffs).toEqual([])
    }
  })

  test("requires buffered state to continue the complete snapshot", async () => {
    const candidate = new FakeRunner("new", "artifact-new", {
      ready: { snapshotRevision: 4 },
    })
    const originalPrepare = candidate.prepareImpl
    candidate.prepareImpl = async (requested, signal) => {
      candidate.emit({
        kind: "state",
        sequence: 1,
        revision: 6,
        event: gatewayEvent(),
      })
      return await originalPrepare(requested, signal)
    }
    const context = setup({ candidate })
    await expectRejection(
      context.coordinator.prepareAndCutover(spec),
      "expected state revision 5",
    )
    expect(context.projection.generation).toBe("old")
  })
})

describe("health policy", () => {
  test.each(["active", "resource-ready", "signed-out", "needs-setup"] as const)(
    "accepts classified %s health",
    async (stateName) => {
      const candidate = new FakeRunner("new", "artifact-new", {
        ready: { health: health(stateName) },
      })
      const context = setup({ candidate })
      const result = await context.coordinator.prepareAndCutover(spec)
      expect(result).toMatchObject({ generationId: "new" })
    },
  )

  test("rejects the whole multi-plugin candidate when one staged plugin regresses", async () => {
    const candidate = new FakeRunner("new", "artifact-new", {
      ready: {
        health: [
          { pluginId: "plugin-a", state: "active" },
          { pluginId: "plugin-b", state: "failed" },
        ],
      },
    })
    const context = setup({
      candidate,
      oldHealth: [
        { pluginId: "plugin-a", state: "active" },
        { pluginId: "plugin-b", state: "active" },
      ],
    })
    await expectRejection(
      context.coordinator.prepareAndCutover(spec),
      "plugin-b has a new activation failure",
    )
    expect(context.journal.record).toBeUndefined()
    expect(context.projection).toMatchObject({
      generation: "old",
      snapshot: { value: "old" },
    })
    expect(context.state.diffs).toEqual([])
  })

  test("accepts an existing failure but rejects waiting and new regressions", async () => {
    expect(candidateHealthRegression(health("failed"), health("failed"))).toBe(
      undefined,
    )
    expect(candidateHealthRegression(health(), health("waiting"))).toContain(
      "waiting",
    )
    expect(candidateHealthRegression(health(), health("failed"))).toContain(
      "new activation failure",
    )

    const existing = setup({
      oldHealth: health("failed"),
      candidate: new FakeRunner("new", "artifact-new", {
        ready: { health: health("failed") },
      }),
    })
    const existingResult = await existing.coordinator.prepareAndCutover(spec)
    expect(existingResult).toBeDefined()

    for (const rejected of ["waiting", "failed"] as const) {
      const context = setup({
        candidate: new FakeRunner("new", "artifact-new", {
          ready: { health: health(rejected) },
        }),
      })
      await expectRejection(
        context.coordinator.prepareAndCutover(spec),
        "Candidate rejected",
      )
      expect(context.projection.generation).toBe("old")
      expect(context.state.diffs).toEqual([])
    }
  })
})

describe("prepare failures", () => {
  test.each([
    ["protocol", "negotiate"],
    ["import", "prepare"],
    ["apply", "prepare"],
  ] as const)("isolates %s failure", async (message, stage) => {
    const candidate = new FakeRunner("new", "artifact-new")
    if (stage === "negotiate") {
      candidate.negotiateImpl = () => Promise.reject(new Error(message))
    } else {
      candidate.prepareImpl = () => Promise.reject(new Error(message))
    }
    const context = setup({ candidate })
    await expectRejection(context.coordinator.prepareAndCutover(spec), message)
    expect(candidate.stopped).toBe(1)
    expect(context.projection.generation).toBe("old")
    expect(context.journal.record).toBeUndefined()
  })

  test.each(["negotiate", "prepare"] as const)(
    "bounds %s timeout and leaves the old generation active",
    async (stage) => {
      const candidate = new FakeRunner("new", "artifact-new")
      if (stage === "negotiate") candidate.negotiateImpl = hangs
      else candidate.prepareImpl = hangs
      const context = setup({
        candidate,
        negotiateTimeoutMs: 5,
        prepareTimeoutMs: 5,
      })
      await expectRejection(
        context.coordinator.prepareAndCutover(spec),
        "timed out",
      )
      expect(context.projection.generation).toBe("old")
      expect(context.state.diffs).toEqual([])
    },
  )

  test("bounds spawn and aborts the supervisor operation", async () => {
    const context = setup({ operationTimeoutMs: 5 })
    let spawnSignal: AbortSignal | undefined
    context.supervisor.spawn = (_requested, signal) => {
      spawnSignal = signal
      return hangs()
    }
    await expectRejection(
      context.coordinator.prepareAndCutover(spec),
      "Candidate spawn timed out",
    )
    expect(spawnSignal?.aborted).toBe(true)
    expect(context.projection.generation).toBe("old")
  })

  test.each(["identity", "subscription"] as const)(
    "stops a spawned runner after %s attempt setup failure",
    async (failure) => {
      const candidate =
        failure === "identity" ?
          new FakeRunner("wrong", "artifact-new")
        : new FakeRunner("new", "artifact-new")
      candidate.failSubscribe = failure === "subscription"
      const context = setup({ candidate })
      await expectRejection(
        context.coordinator.prepareAndCutover(spec),
        failure === "identity" ? "identity" : "subscription failed",
      )
      expect(candidate.stopped).toBe(1)
      expect(context.journal.record).toBeUndefined()
    },
  )
})

// eslint-disable-next-line max-lines-per-function -- fault matrix shares deterministic fakes
describe("atomic commit and recovery", () => {
  test("rolls exclusive resources back when the durable point is not reached", async () => {
    const context = setup()
    context.journal.failPersist = true
    await expectRejection(
      context.coordinator.prepareAndCutover(spec),
      "crash before durable point",
    )
    expect(context.resources.rollbacks).toBe(1)
    expect(context.resources.finishes).toBe(0)
    expect(context.projection.generation).toBe("old")
    expect(context.state.diffs).toEqual([])
  })

  test("does not acquire exclusive resources for overlap-safe activation", async () => {
    const context = setup({
      candidate: new FakeRunner("new", "artifact-new", { resources: [] }),
    })
    await context.coordinator.prepareAndCutover(spec)
    expect(context.resources.handoffs).toBe(0)
    expect(context.resources.finishes).toBe(0)
  })

  test("exclusive handoff failure changes no public or durable state", async () => {
    const context = setup()
    context.resources.failHandoff = true
    await expectRejection(
      context.coordinator.prepareAndCutover(spec),
      "exclusive handoff failed",
    )
    expect(context.journal.record).toBeUndefined()
    expect(context.projection.generation).toBe("old")
    expect(context.state.diffs).toEqual([])
  })

  test("restarts the selected generation after a post-durable crash", async () => {
    const context = setup()
    context.projection.failInstall = true
    const result = await context.coordinator.prepareAndCutover(spec)
    expect(result.recovered).toBe(true)
    expect(context.supervisor.restarted).toBe(1)
    expect(context.resources.rollbacks).toBe(0)
    expect(context.resources.recoveries).toBe(1)
    expect(context.projection.generation).toBe("new")
    expect(context.journal.record?.generationId).toBe("new")
    expect(context.state.diffs).toEqual(["commit-new"])
  })

  test("keeps the selected runner after pointer install but before diff", async () => {
    const context = setup()
    context.state.failDiffOnce = true
    const result = await context.coordinator.prepareAndCutover(spec)
    expect(result.recovered).toBe(true)
    expect(context.supervisor.restarted).toBe(0)
    expect(context.candidate.stopped).toBe(0)
    expect(context.resources.rollbacks).toBe(0)
    expect(context.projection.generation).toBe("new")
    expect(context.state.diffs).toEqual(["commit-new"])
    expect(context.old.drained).toBe(1)
  })

  test("retries handoff finalization on the installed runner", async () => {
    const context = setup()
    context.resources.failFinishOnce = true
    const result = await context.coordinator.prepareAndCutover(spec)
    expect(result.recovered).toBe(true)
    expect(context.resources.finishes).toBe(2)
    expect(context.supervisor.restarted).toBe(0)
    expect(context.candidate.stopped).toBe(0)
    expect(context.old.drained).toBe(1)
  })

  test("is idempotent at install, publish, and retry crash points", async () => {
    const context = setup()
    await context.coordinator.prepareAndCutover(spec)
    const again = await context.coordinator.prepareAndCutover(spec)
    expect(again.recovered).toBe(true)
    expect(context.supervisor.spawned).toBe(1)
    expect(context.projection.installs).toBe(1)
    expect(context.state.diffs).toEqual(["commit-new"])
  })

  test("emits one public diff and follows every state transition", async () => {
    const context = setup()
    const result = await context.coordinator.prepareAndCutover(spec)
    expect(result.candidateHistory).toEqual([
      "SPAWNED",
      "NEGOTIATED",
      "PREPARING",
      "PREPARED",
      "COMMITTING",
      "ACTIVE",
    ])
    expect(result.oldHistory).toEqual(["ACTIVE", "DRAINING", "STOPPING"])
    expect(context.state.diffs).toEqual(["commit-new"])
    expect(context.resources.finishes).toBe(1)
  })

  test("actively restores the old owner when handoff rollback fails", async () => {
    const context = setup()
    context.journal.failPersist = true
    context.resources.failRollback = true
    await expectRejection(
      context.coordinator.prepareAndCutover(spec),
      "old generation was actively restored",
    )
    expect(context.resources.restorations).toBe(1)
    expect(context.supervisor.restorations).toBe(1)
    expect(context.projection.generation).toBe("old")
    expect(context.state.diffs).toEqual([])
  })

  test.each(["handoff", "journal"] as const)(
    "bounds and aborts a hanging %s operation",
    async (operation) => {
      const context = setup({ operationTimeoutMs: 5 })
      let operationSignal: AbortSignal | undefined
      if (operation === "handoff") {
        context.resources.handoff = (_input, signal) => {
          operationSignal = signal
          return hangs()
        }
      } else {
        context.journal.commitDurably = (_key, _record, signal) => {
          operationSignal = signal
          return hangs()
        }
      }
      await expectRejection(
        context.coordinator.prepareAndCutover(spec),
        "timed out",
      )
      expect(operationSignal?.aborted).toBe(true)
      expect(context.projection.generation).toBe("old")
      expect(context.state.diffs).toEqual([])
    },
  )

  test("serializes concurrent recovery and starts one selected runner", async () => {
    const context = setup()
    context.journal.record = committedRecord()
    const results = await Promise.all([
      context.coordinator.recoverCommitted(),
      context.coordinator.recoverCommitted(),
    ])
    expect(results.every((result) => result.recovered)).toBe(true)
    expect(context.supervisor.restarted).toBe(1)
    expect(context.supervisor.restartRunner?.stopped).toBe(0)
    expect(context.old.stopped).toBe(1)
    expect(context.projection.generation).toBe("new")
    expect(context.state.diffs).toEqual(["commit-new"])
  })

  test("recovers the durable snapshot and keeps fresh runner events", async () => {
    const context = setup()
    context.journal.record = committedRecord({
      snapshot: { value: "durable" },
      events: [
        {
          kind: "notice",
          sequence: 1,
          event: gatewayEvent("notice"),
        },
      ],
    })
    const restarted = new FakeRunner("new", "artifact-new", {
      ready: { snapshot: { value: "restart-only" } },
    })
    const prepare = restarted.prepareImpl
    restarted.prepareImpl = async (requested, signal) => {
      restarted.emit({
        kind: "notice",
        sequence: 1,
        event: gatewayEvent("notice"),
      })
      return await prepare(requested, signal)
    }
    context.supervisor.restartRunner = restarted
    await context.coordinator.recoverCommitted()
    expect(context.projection.snapshot).toEqual({ value: "durable" })
    expect(context.state.diffEventCounts).toEqual([1])
    expect(context.state.publicEvents).toHaveLength(1)
  })

  test("restarts when projection is selected but the live runner is stale", async () => {
    const context = setup()
    context.journal.record = committedRecord()
    context.projection.generation = "new"
    await context.coordinator.recoverCommitted()
    expect(context.supervisor.restarted).toBe(1)
    expect(context.old.stopped).toBe(1)
    expect(context.projection.generation).toBe("new")
  })

  test("does not deadlock if publication schedules reentrant recovery", async () => {
    const context = setup()
    let reentrant: Promise<unknown> | undefined
    context.state.duringDiff = () => {
      context.state.duringDiff = undefined
      reentrant = context.coordinator.recoverCommitted()
    }
    await context.coordinator.prepareAndCutover(spec)
    await reentrant
    expect(context.state.diffs).toEqual(["commit-new"])
    expect(context.state.commitLocks).toBe(1)
  })

  test.each([
    { commitId: "different" },
    { generationId: "different" },
    { artifactId: "different" },
  ])("rejects mismatched durable recovery identity", async (mismatch) => {
    const context = setup()
    context.journal.record = committedRecord(mismatch)
    await expectRejection(
      context.coordinator.prepareAndCutover(spec),
      "durable selection does not match",
    )
    expect(context.supervisor.spawned).toBe(0)
    expect(context.supervisor.restarted).toBe(0)
  })

  test.each(["installed", "published"] as const)(
    "bounds and aborts the journal %s marker",
    async (marker) => {
      const context = setup({ operationTimeoutMs: 5 })
      const signals: Array<AbortSignal> = []
      if (marker === "installed") {
        context.journal.markInstalled = (_commitId, signal) => {
          signals.push(signal)
          return hangs()
        }
      } else {
        context.journal.markPublished = (_commitId, signal) => {
          signals.push(signal)
          return hangs()
        }
      }
      await expectRejection(
        context.coordinator.prepareAndCutover(spec),
        "marker timed out",
      )
      expect(signals.length).toBeGreaterThanOrEqual(2)
      expect(signals.every((signal) => signal.aborted)).toBe(true)
      expect(context.journal.record?.generationId).toBe("new")
      expect(context.resources.rollbacks).toBe(0)
      expect(context.supervisor.restarted).toBe(0)
      expect(context.candidate.stopped).toBe(0)
      expect(context.old.drained).toBe(1)
    },
  )

  test("bounds the drain wait and never stops the old generation while it drains", async () => {
    const context = setup({ operationTimeoutMs: 5 })
    let drainSignal: AbortSignal | undefined
    let releaseDrain: (() => void) | undefined
    let drainCalls = 0
    context.old.beginDrainImpl = (signal) => {
      drainCalls += 1
      if (drainCalls === 1) {
        drainSignal = signal
        return hangs()
      }
      return new Promise<void>((resolve) => {
        releaseDrain = resolve
      })
    }
    const result = await context.coordinator.prepareAndCutover(spec)
    expect(result.generationId).toBe("new")
    expect(drainSignal?.aborted).toBe(true)
    expect(context.projection.generation).toBe("new")
    expect(result.oldHistory).toEqual(["ACTIVE", "DRAINING"])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(context.old.stopped).toBe(0)
    releaseDrain?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(context.old.stopped).toBe(1)
  })

  test("still stops an old generation whose drain failed outright", async () => {
    const context = setup()
    context.old.beginDrainImpl = () => Promise.reject(new Error("crashed"))
    const result = await context.coordinator.prepareAndCutover(spec)
    expect(result.oldHistory).toEqual(["ACTIVE", "DRAINING", "STOPPING"])
    expect(context.old.stopped).toBe(1)
  })
})

describe("event and lease cutover semantics", () => {
  test("buffers candidate events until install", async () => {
    const candidate = new FakeRunner("new", "artifact-new")
    const originalPrepare = candidate.prepareImpl
    candidate.prepareImpl = async (requested, signal) => {
      candidate.emit({
        kind: "notice",
        sequence: 1,
        event: gatewayEvent("notice"),
      })
      expect(context.state.publicEvents).toEqual([])
      expect(context.state.diffs).toEqual([])
      return await originalPrepare(requested, signal)
    }
    const context = setup({ candidate })
    await context.coordinator.prepareAndCutover(spec)
    expect(context.state.diffs).toEqual(["commit-new"])
  })

  test("holds candidate events between pointer install and the cutover diff", async () => {
    const context = setup()
    context.state.duringDiff = () => {
      context.candidate.emit({
        kind: "state",
        sequence: 1,
        revision: 1,
        event: gatewayEvent(),
      })
      expect(context.state.publicEvents).toEqual([])
    }
    await context.coordinator.prepareAndCutover(spec)
    expect(context.state.timeline).toEqual(["diff:commit-new", "event:new"])
  })

  test("freezes the durable event set before persistence", async () => {
    const context = setup()
    const persist = context.journal.commitDurably.bind(context.journal)
    context.journal.commitDurably = (key, record, signal) => {
      context.candidate.emit({
        kind: "notice",
        sequence: 1,
        event: gatewayEvent("notice"),
      })
      return persist(key, record, signal)
    }
    await context.coordinator.prepareAndCutover(spec)
    expect(context.journal.record?.events).toEqual([])
    expect(context.state.diffEventCounts).toEqual([0])
    expect(context.state.timeline).toEqual(["diff:commit-new", "event:new"])
  })

  test.each(["sequence", "revision"] as const)(
    "resyncs an active %s gap without publishing it",
    async (gap) => {
      const context = setup()
      await context.coordinator.prepareAndCutover(spec)
      context.candidate.emit(
        gap === "sequence" ?
          {
            kind: "notice",
            sequence: 2,
            event: gatewayEvent("notice"),
          }
        : {
            kind: "state",
            sequence: 1,
            revision: 2,
            event: gatewayEvent(),
          },
      )
      await Promise.resolve()
      expect(context.candidate.resyncs).toHaveLength(1)
      expect(context.candidate.resyncs[0]?.reason).toContain(
        gap === "sequence" ? "active sequence gap" : "state revision gap",
      )
      expect(context.state.publicEvents).toEqual([])
    },
  )

  test.each(["count", "bytes"] as const)(
    "rejects candidate event buffer %s overflow",
    async (limit) => {
      const candidate = new FakeRunner("new", "artifact-new")
      const originalPrepare = candidate.prepareImpl
      candidate.prepareImpl = async (requested, signal) => {
        candidate.emit({
          kind: "notice",
          sequence: 1,
          event: gatewayEvent("notice"),
        })
        if (limit === "count") {
          candidate.emit({
            kind: "notice",
            sequence: 2,
            event: gatewayEvent("notice"),
          })
        }
        return await originalPrepare(requested, signal)
      }
      const context = setup({
        candidate,
        maxBufferedEvents: limit === "count" ? 1 : 10,
        maxBufferedBytes: limit === "bytes" ? 1 : 10_000,
      })
      await expectRejection(
        context.coordinator.prepareAndCutover(spec),
        "buffer overflow",
      )
      await Promise.resolve()
      expect(candidate.resyncs).toHaveLength(1)
      expect(context.state.diffs).toEqual([])
    },
  )

  test("bounds the installed event buffer and requests resync", async () => {
    const context = setup({ maxBufferedEvents: 1 })
    context.state.duringDiff = () => {
      context.candidate.emit({
        kind: "notice",
        sequence: 1,
        event: gatewayEvent("notice"),
      })
      context.candidate.emit({
        kind: "notice",
        sequence: 2,
        event: gatewayEvent("notice"),
      })
    }
    await context.coordinator.prepareAndCutover(spec)
    await Promise.resolve()
    expect(context.state.publicEvents).toHaveLength(1)
    expect(context.candidate.resyncs.at(-1)?.reason).toBe(
      "active event buffer overflow",
    )
  })

  test("suppresses old non-call events but allows old call callbacks", async () => {
    const context = setup()
    context.old.beginDrainImpl = () => {
      context.old.emit({
        kind: "state",
        sequence: 1,
        revision: 1,
        event: gatewayEvent(),
      })
      context.old.emit({
        kind: "notice",
        sequence: 2,
        event: gatewayEvent("notice"),
      })
      context.old.emit({
        kind: "call",
        sequence: 3,
        callId: "old-call",
        value: "finished",
      })
      return Promise.resolve()
    }
    await context.coordinator.prepareAndCutover(spec)
    expect(context.state.publicEvents).toEqual([])
    expect(context.state.callbacks).toEqual([
      { generationId: "old", callId: "old-call", value: "finished" },
    ])
  })

  test("switches new leases only at atomic pointer install", async () => {
    const context = setup()
    const leaseBeforePrepare = context.projection.acquireLease()
    let leaseDuringPrepare = ""
    let leaseDuringHandoff = ""
    const originalPrepare = context.candidate.prepareImpl
    context.candidate.prepareImpl = async (requested, signal) => {
      leaseDuringPrepare = context.projection.acquireLease()
      return await originalPrepare(requested, signal)
    }
    const originalHandoff = context.resources.handoff.bind(context.resources)
    context.resources.handoff = async (input, signal) => {
      leaseDuringHandoff = context.projection.acquireLease()
      return await originalHandoff(input, signal)
    }
    await context.coordinator.prepareAndCutover(spec)
    const leaseAfterInstall = context.projection.acquireLease()
    expect([
      leaseBeforePrepare,
      leaseDuringPrepare,
      leaseDuringHandoff,
      leaseAfterInstall,
    ]).toEqual(["old", "old", "old", "new"])
    expect(leaseBeforePrepare).toBe("old")
  })
})
