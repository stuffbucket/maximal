import type { PluginGenerationLease } from "@stuffbucket/maximal-plugin-sdk/gateway"

export type GenerationDrainReason =
  | "top-level-call"
  | "nested-callback"
  | "reverse-rpc"
  | "elicitation"
  | "spool-reference"
  | "spend-acknowledgment"
  | "session-affinity"
  | (string & {})

export interface GenerationDrainBlocker {
  readonly generationId: string
  readonly reason: GenerationDrainReason
  readonly detail?: string
}

export interface GenerationDrainDiagnostics {
  readonly generationId: string
  readonly count: number
  readonly blockers: ReadonlyArray<GenerationDrainBlocker>
}

export interface GenerationDrainLease {
  release(): void
}

/** Extensible parent-side accounting for everything that keeps a generation alive. */
export class GenerationLeaseCounter {
  readonly #blockers = new Map<number, GenerationDrainBlocker>()
  #nextId = 0

  acquire(
    generationId: string,
    reason: GenerationDrainReason,
    detail?: string,
  ): GenerationDrainLease {
    const id = this.#nextId++
    this.#blockers.set(id, {
      generationId,
      reason,
      ...(detail === undefined ? {} : { detail }),
    })
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.#blockers.delete(id)
      },
    }
  }

  diagnostics(): Array<GenerationDrainDiagnostics> {
    const generations = new Map<string, Array<GenerationDrainBlocker>>()
    for (const blocker of this.#blockers.values()) {
      const entries = generations.get(blocker.generationId) ?? []
      entries.push({ ...blocker })
      generations.set(blocker.generationId, entries)
    }
    return [...generations.entries()].map(([generationId, blockers]) => ({
      generationId,
      count: blockers.length,
      blockers,
    }))
  }
}

export interface SessionAffinityDiagnostics {
  readonly sessionId: string
  readonly generationId: string
  readonly activeCalls: number
  readonly migrating: boolean
  readonly drainDeadline?: number
}

export interface GenerationAffinityDiagnostics {
  readonly pinnedSessions: ReadonlyArray<SessionAffinityDiagnostics>
  readonly drainBlockers: ReadonlyArray<GenerationDrainDiagnostics>
}

export interface GenerationAffinityOptions {
  acquireGeneration(): PluginGenerationLease
  releaseUpstreamSession(
    generationId: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void>
  closeDownstream(sessionId: string, reason: string): void | Promise<void>
  onMigrated(sessionId: string): void
  leaseCounter?: GenerationLeaseCounter
  now?: () => number
}

export interface AffinedGenerationCall {
  readonly generation: PluginGenerationLease
  release(): void
}

interface Cutover {
  readonly epoch: number
  readonly generationId: string
  readonly deadline: number
  readonly timer: ReturnType<typeof setTimeout>
}

interface Affinity {
  readonly sessionId: string
  generation: PluginGenerationLease
  affinityLease: GenerationDrainLease
  activeCalls: number
  closed: boolean
  affinityReleased: boolean
  migration?: Promise<void>
  migrationAbort?: AbortController
  notifiedEpoch: number
}

export class SessionAffinityClosedError extends Error {
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`MCP session "${sessionId}" was closed during generation drain.`)
    this.sessionId = sessionId
    this.name = "SessionAffinityClosedError"
  }
}

/**
 * Keeps one downstream MCP session on one generation until it is idle. A
 * cutover changes only future, unaffined acquisitions; pinned sessions move
 * after their old upstream state has been released.
 */
export class GenerationAffinityCoordinator {
  readonly #options: GenerationAffinityOptions
  readonly #counter: GenerationLeaseCounter
  readonly #sessions = new Map<string, Affinity>()
  #cutover: Cutover | undefined
  #epoch = 0

  constructor(options: GenerationAffinityOptions) {
    this.#options = options
    this.#counter = options.leaseCounter ?? new GenerationLeaseCounter()
  }

  async acquire(sessionId: string): Promise<AffinedGenerationCall> {
    let affinity = this.#sessions.get(sessionId)
    if (!affinity) {
      const generation = this.#options.acquireGeneration()
      affinity = {
        sessionId,
        generation,
        affinityLease: this.#counter.acquire(
          generation.generationId,
          "session-affinity",
          sessionId,
        ),
        activeCalls: 0,
        closed: false,
        affinityReleased: false,
        notifiedEpoch: 0,
      }
      this.#sessions.set(sessionId, affinity)
    }
    this.#assertCurrent(affinity)
    while (true) {
      const cutover = this.#cutover
      if (
        cutover
        && affinity.generation.generationId !== cutover.generationId
        && affinity.activeCalls === 0
      ) {
        await this.#migrate(affinity, cutover)
        this.#assertCurrent(affinity)
        continue
      }
      break
    }
    this.#assertCurrent(affinity)
    affinity.activeCalls += 1
    const generation = affinity.generation
    const callLease = this.#counter.acquire(
      generation.generationId,
      "top-level-call",
      sessionId,
    )
    let released = false
    return {
      generation,
      release: () => {
        if (released) return
        released = true
        callLease.release()
        affinity.activeCalls -= 1
        if (affinity.activeCalls === 0) {
          if (affinity.closed) this.#releaseAffinity(affinity)
          else this.#migrateIfNeeded(affinity)
        }
      },
    }
  }

  /** Register a cutover after the gateway's current-generation pointer swaps. */
  cutover(generationId: string, drainDeadline: number): void {
    if (this.#cutover?.generationId === generationId) return
    if (this.#cutover) clearTimeout(this.#cutover.timer)
    const epoch = ++this.#epoch
    const delay = Math.max(0, drainDeadline - this.#now())
    const timer = setTimeout(() => {
      if (this.#cutover?.epoch === epoch) this.expireDrain(drainDeadline)
    }, delay)
    timer.unref()
    this.#cutover = { epoch, generationId, deadline: drainDeadline, timer }
    for (const affinity of this.#sessions.values()) {
      this.#migrateIfNeeded(affinity)
    }
  }

  /** Deterministic clock seam for tests and supervisor deadline handling. */
  expireDrain(now = this.#now()): void {
    const cutover = this.#cutover
    if (!cutover || now < cutover.deadline) return
    for (const affinity of this.#sessions.values()) {
      if (affinity.generation.generationId !== cutover.generationId) {
        void this.#close(affinity, "generation drain deadline expired")
      }
    }
  }

  acquireDrainLease(
    generationId: string,
    reason: GenerationDrainReason,
    detail?: string,
  ): GenerationDrainLease {
    return this.#counter.acquire(generationId, reason, detail)
  }

  /** Hold a session for nested callbacks, reverse RPC, spools, or spend acks. */
  acquireSessionDrainLease(
    sessionId: string,
    reason: GenerationDrainReason,
    detail?: string,
  ): GenerationDrainLease {
    const affinity = this.#sessions.get(sessionId)
    if (!affinity || affinity.closed)
      throw new SessionAffinityClosedError(sessionId)
    affinity.activeCalls += 1
    const lease = this.#counter.acquire(
      affinity.generation.generationId,
      reason,
      detail ?? sessionId,
    )
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        lease.release()
        affinity.activeCalls -= 1
        if (affinity.activeCalls === 0) {
          if (affinity.closed) this.#releaseAffinity(affinity)
          else this.#migrateIfNeeded(affinity)
        }
      },
    }
  }

  async closeSession(
    sessionId: string,
    reason = "downstream closed",
  ): Promise<void> {
    const affinity = this.#sessions.get(sessionId)
    if (affinity) await this.#close(affinity, reason, false)
  }

  async closeAll(): Promise<void> {
    if (this.#cutover) clearTimeout(this.#cutover.timer)
    await Promise.all(
      [...this.#sessions.values()].map((affinity) =>
        this.#close(affinity, "coordinator closed", false),
      ),
    )
  }

  diagnostics(): GenerationAffinityDiagnostics {
    return {
      pinnedSessions: [...this.#sessions.values()]
        .filter((affinity) => !affinity.closed)
        .map((affinity) => ({
          sessionId: affinity.sessionId,
          generationId: affinity.generation.generationId,
          activeCalls: affinity.activeCalls,
          migrating: affinity.migration !== undefined,
          ...(this.#cutover === undefined ?
            {}
          : { drainDeadline: this.#cutover.deadline }),
        })),
      drainBlockers: this.#counter.diagnostics(),
    }
  }

  #assertCurrent(affinity: Affinity): void {
    if (
      affinity.closed
      || affinity.affinityReleased
      || this.#sessions.get(affinity.sessionId) !== affinity
    ) {
      throw new SessionAffinityClosedError(affinity.sessionId)
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }

  #migrateIfNeeded(affinity: Affinity): void {
    const cutover = this.#cutover
    if (
      !cutover
      || affinity.closed
      || affinity.activeCalls !== 0
      || affinity.generation.generationId === cutover.generationId
    )
      return
    void this.#migrate(affinity, cutover).catch(() => undefined)
  }

  #migrate(affinity: Affinity, cutover: Cutover): Promise<void> {
    if (affinity.migration) return affinity.migration
    const abort = new AbortController()
    affinity.migrationAbort = abort
    const migration = (async () => {
      try {
        await this.#options.releaseUpstreamSession(
          affinity.generation.generationId,
          affinity.sessionId,
          abort.signal,
        )
        if (affinity.closed || abort.signal.aborted) return
        this.#releaseAffinity(affinity)
        const target = this.#cutover ?? cutover
        const next = this.#options.acquireGeneration()
        if (next.generationId !== target.generationId) {
          next.release()
          throw new Error(
            `Current generation is "${next.generationId}", expected "${target.generationId}".`,
          )
        }
        affinity.generation = next
        affinity.affinityReleased = false
        affinity.affinityLease = this.#counter.acquire(
          next.generationId,
          "session-affinity",
          affinity.sessionId,
        )
        if (affinity.notifiedEpoch !== target.epoch) {
          affinity.notifiedEpoch = target.epoch
          this.#options.onMigrated(affinity.sessionId)
        }
      } catch (error) {
        if (!affinity.closed) {
          const detail = error instanceof Error ? error.message : String(error)
          await this.#close(affinity, `generation migration failed: ${detail}`)
        }
        throw error
      } finally {
        // This promise is the sole migration writer for the affinity.
        // eslint-disable-next-line require-atomic-updates
        affinity.migration = undefined
        if (affinity.migrationAbort === abort)
          affinity.migrationAbort = undefined
        queueMicrotask(() => this.#migrateIfNeeded(affinity))
      }
    })()
    affinity.migration = migration
    return migration
  }

  async #close(
    affinity: Affinity,
    reason: string,
    notify = true,
  ): Promise<void> {
    if (affinity.closed) return
    affinity.closed = true
    this.#sessions.delete(affinity.sessionId)
    affinity.migrationAbort?.abort(reason)
    if (affinity.activeCalls === 0) this.#releaseAffinity(affinity)
    if (notify) await this.#options.closeDownstream(affinity.sessionId, reason)
  }

  #releaseAffinity(affinity: Affinity): void {
    if (affinity.affinityReleased) return
    affinity.affinityReleased = true
    affinity.affinityLease.release()
    affinity.generation.release()
  }
}
