import type {
  PluginGenerationResourceLifecycle,
  PluginLifecycleCallOptions,
  PluginResourceLifecycle,
  PluginResourcePhase,
  PluginResourceView,
} from "@stuffbucket/maximal-plugin-sdk"

import {
  ExclusiveResourceLeaseRegistry,
  normalizeResourceDeclaration,
  PluginLifecycleTimeoutError,
  runPluginLifecycleHook,
} from "@stuffbucket/maximal-plugin-sdk"

const DEFAULT_TRANSITION_MS = 10_000
const DEFAULT_RECOVERY_MS = 10_000

/** One plugin's serialized, lease-fenced lifecycle. */
export class ManagedPluginResourceLifecycle {
  readonly #pluginId: string
  readonly #owner: string
  readonly #hooks: PluginResourceLifecycle
  readonly #leases: ExclusiveResourceLeaseRegistry
  /** Resources this slot currently holds parent leases for. */
  readonly #held = new Set<string>()
  #phase: PluginResourcePhase = "new"
  #tail: Promise<void> = Promise.resolve()

  constructor(options: {
    pluginId: string
    generationId: string
    hooks: PluginResourceLifecycle
    leases: ExclusiveResourceLeaseRegistry
  }) {
    this.#pluginId = options.pluginId
    this.#owner = `${options.generationId}/${options.pluginId}`
    this.#hooks = options.hooks
    this.#leases = options.leases
    normalizeResourceDeclaration(options.pluginId, options.hooks.declaration)
  }

  view(): PluginResourceView {
    return {
      pluginId: this.#pluginId,
      declaration: normalizeResourceDeclaration(
        this.#pluginId,
        this.#hooks.declaration,
      ),
      phase: this.#phase,
    }
  }

  prepare(options?: PluginLifecycleCallOptions): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#phase !== "new") return
      this.#phase = "preparing"
      try {
        await this.#run("prepare", options)
        this.#phase = "prepared"
      } catch (error) {
        this.#phase = "new"
        throw error
      }
    })
  }

  commit(options?: PluginLifecycleCallOptions): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#phase === "committed") return
      if (this.#phase !== "prepared") {
        throw new Error(
          `Plugin "${this.#pluginId}" cannot commit resources from phase ${this.#phase}.`,
        )
      }
      const resources = this.#exclusiveResources()
      this.#acquire(resources)
      this.#phase = "committing"
      try {
        await this.#run("commit", options)
        this.#phase = "committed"
      } catch (error) {
        await this.#rollbackAcquired(error, resources, "prepared")
      }
    })
  }

  revoke(options?: PluginLifecycleCallOptions): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#phase === "revoked") return
      if (this.#phase === "new") {
        this.#phase = "revoking"
        try {
          await this.#run("revoke", options)
          this.#phase = "revoked"
        } catch (error) {
          this.#phase = "new"
          throw error
        }
        return
      }
      if (this.#phase !== "prepared" && this.#phase !== "committed") {
        throw new Error(
          `Plugin "${this.#pluginId}" cannot revoke resources from phase ${this.#phase}.`,
        )
      }
      const prior = this.#phase
      this.#phase = "revoking"
      try {
        await this.#run("revoke", options)
        this.#release([...this.#held])
        this.#phase = "revoked"
      } catch (error) {
        this.#phase = prior
        throw error
      }
    })
  }

  resume(options?: PluginLifecycleCallOptions): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#phase === "committed") return
      if (this.#phase !== "revoked") {
        throw new Error(
          `Plugin "${this.#pluginId}" cannot resume resources from phase ${this.#phase}.`,
        )
      }
      const resources = this.#exclusiveResources()
      this.#acquire(resources)
      this.#phase = "resuming"
      try {
        await this.#run("resume", options)
        this.#phase = "committed"
      } catch (error) {
        await this.#rollbackAcquired(error, resources, "revoked")
      }
    })
  }

  /**
   * A committed generation's declaration changed after activation (a plugin
   * was enabled, disabled, or restarted later). Bring the parent leases in
   * line, acquiring every new lease before asking the child to bind. The child
   * commit always runs because a restarted slot can be prepared even when its
   * declaration is unchanged. A failed commit retains newly acquired leases:
   * the child may own a physical singleton until recovery is acknowledged.
   */
  sync(options?: PluginLifecycleCallOptions): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#phase !== "committed") return
      const declared = this.#exclusiveResources()
      const dropped = [...this.#held].filter(
        (resource) => !declared.includes(resource),
      )
      const added = declared.filter((resource) => !this.#held.has(resource))
      // Keep the old lease through replacement. If acquisition or the child
      // commit fails, both the old physical owner and every ambiguously bound
      // replacement remain fenced until an acknowledged retry converges.
      this.#acquire(added)
      await this.#run("commit", options)
      this.#release(dropped)
    })
  }

  /** Roll a generation-wide partial commit back to its prepared state. */
  rollbackCommit(options?: PluginLifecycleCallOptions): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#phase !== "committed") return
      this.#phase = "revoking"
      try {
        await this.#run("revoke", options)
        this.#release([...this.#held])
        this.#phase = "prepared"
      } catch (error) {
        this.#phase = "committed"
        throw error
      }
    })
  }

  #acquire(resources: ReadonlyArray<string>): void {
    this.#leases.acquire(this.#owner, resources)
    for (const resource of resources) this.#held.add(resource)
  }

  #release(resources: ReadonlyArray<string>): void {
    this.#leases.release(this.#owner, resources)
    for (const resource of resources) this.#held.delete(resource)
  }

  async #rollbackAcquired(
    transitionError: unknown,
    resources: ReadonlyArray<string>,
    releasedPhase: "prepared" | "revoked",
  ): Promise<never> {
    try {
      await this.#run("revoke", {
        purpose: "recovery",
        deadline: Date.now() + DEFAULT_RECOVERY_MS,
      })
      this.#release(resources)
      this.#phase = releasedPhase
    } catch (cleanupError) {
      // The hook may still own a physical singleton. Keep both its handle and
      // the parent lease quarantined so a later revoke can retry cleanup.
      this.#phase = "committed"
      throw new AggregateError(
        [transitionError, cleanupError],
        `Plugin "${this.#pluginId}" activation failed and resource cleanup did not complete.`,
      )
    }
    throw transitionError
  }

  #exclusiveResources(): ReadonlyArray<string> {
    const { declaration } = this.#hooks
    return declaration.mode === "exclusive" ? declaration.resources : []
  }

  #run(
    step: "prepare" | "commit" | "revoke" | "resume",
    options?: PluginLifecycleCallOptions,
  ): Promise<void> {
    return runPluginLifecycleHook(
      (context) => this.#hooks[step](context),
      options,
      DEFAULT_TRANSITION_MS,
    )
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(task, task)
    this.#tail = run.catch(() => undefined)
    return run
  }
}

/** A generation view assembled from its currently active plugin slots. */
export class HostGenerationResourceLifecycle implements PluginGenerationResourceLifecycle {
  readonly #slots: () => Array<ManagedPluginResourceLifecycle>
  readonly #overlapSafe: () => Array<string>

  constructor(options: {
    slots: () => Array<ManagedPluginResourceLifecycle>
    overlapSafe: () => Array<string>
  }) {
    this.#slots = options.slots
    this.#overlapSafe = options.overlapSafe
  }

  list(): Array<PluginResourceView> {
    const explicit = this.#slots().map((slot) => slot.view())
    const explicitIds = new Set(explicit.map((item) => item.pluginId))
    const implicit = this.#overlapSafe()
      .filter((pluginId) => !explicitIds.has(pluginId))
      .map((pluginId) => ({
        pluginId,
        declaration: { mode: "overlap-safe" as const },
        phase: "committed" as const,
      }))
    return [...explicit, ...implicit].sort((a, b) =>
      a.pluginId.localeCompare(b.pluginId),
    )
  }

  prepare(options?: PluginLifecycleCallOptions): Promise<void> {
    return this.#each("prepare", options)
  }

  commit(options?: PluginLifecycleCallOptions): Promise<void> {
    return this.#commit(options)
  }

  revoke(options?: PluginLifecycleCallOptions): Promise<void> {
    return this.#each("revoke", options)
  }

  resume(options?: PluginLifecycleCallOptions): Promise<void> {
    return this.#each("resume", options)
  }

  async #commit(options?: PluginLifecycleCallOptions): Promise<void> {
    const committed: Array<ManagedPluginResourceLifecycle> = []
    for (const slot of this.#sortedSlots()) {
      const wasCommitted = slot.view().phase === "committed"
      try {
        await slot.commit(options)
        if (!wasCommitted && slot.view().phase === "committed")
          committed.push(slot)
      } catch (transitionError) {
        const rollbackErrors: Array<unknown> = []
        for (const activated of committed.reverse()) {
          try {
            await activated.rollbackCommit({
              purpose: "recovery",
              deadline: Date.now() + DEFAULT_RECOVERY_MS,
            })
          } catch (error) {
            rollbackErrors.push(error)
          }
        }
        if (rollbackErrors.length > 0)
          throw new AggregateError(
            [transitionError, ...rollbackErrors],
            "Plugin resource commit failed and rollback did not complete.",
          )
        throw transitionError
      }
    }
  }

  async #each(
    step: "prepare" | "commit" | "revoke" | "resume",
    options?: PluginLifecycleCallOptions,
  ): Promise<void> {
    const errors: Array<unknown> = []
    for (const slot of this.#sortedSlots()) {
      try {
        await slot[step](options)
      } catch (error) {
        if (step === "prepare" || step === "commit") throw error
        errors.push(error)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1)
      throw new AggregateError(errors, `Plugin resource ${step} failed.`)
  }

  #sortedSlots(): Array<ManagedPluginResourceLifecycle> {
    return this.#slots().sort((a, b) =>
      a.view().pluginId.localeCompare(b.view().pluginId),
    )
  }
}

export type DurableCommitState = "committed" | "not-committed"
export type ResourceHandoffDurableState = DurableCommitState | "unknown"

export class ResourceHandoffError extends Error {
  readonly transitionError: unknown
  readonly recoveryError: unknown
  readonly durableState: ResourceHandoffDurableState

  // Four fields preserve the transition, recovery and durable diagnoses.
  // eslint-disable-next-line max-params
  constructor(
    message: string,
    transitionError: unknown,
    recoveryError?: unknown,
    durableState: ResourceHandoffDurableState = "not-committed",
  ) {
    super(message, { cause: transitionError })
    this.name = "ResourceHandoffError"
    this.transitionError = transitionError
    this.recoveryError = recoveryError
    this.durableState = durableState
  }
}

export interface PluginResourceHandoffOptions {
  current: PluginGenerationResourceLifecycle
  candidate: PluginGenerationResourceLifecycle
  /** Stable across retries; the durable store must enforce this key. */
  idempotencyKey: string
  /** Atomically commit the generation and report the durable state. */
  commitDurably: (
    idempotencyKey: string,
  ) => DurableCommitState | Promise<DurableCommitState>
  /** Query the same durable record after crash, retry, or callback failure. */
  queryDurableCommit: (
    idempotencyKey: string,
  ) => DurableCommitState | Promise<DurableCommitState>
  signal?: AbortSignal
  deadline?: number
  recoveryDeadline?: number
}

interface ActiveHandoff {
  readonly identity: string
  readonly lockKeys: ReadonlySet<string>
  readonly promise: Promise<void>
}

let nextGenerationIdentity = 0
const generationIdentities = new WeakMap<object, number>()
const activeHandoffs = new Map<string, ActiveHandoff>()

function generationIdentity(
  generation: PluginGenerationResourceLifecycle,
): number {
  const found = generationIdentities.get(generation)
  if (found !== undefined) return found
  const identity = ++nextGenerationIdentity
  generationIdentities.set(generation, identity)
  return identity
}

function exclusiveResources(
  generation: PluginGenerationResourceLifecycle,
): Array<string> {
  return generation
    .list()
    .flatMap((view) =>
      view.declaration.mode === "exclusive" ? view.declaration.resources : [],
    )
}

function handoffIdentity(options: PluginResourceHandoffOptions): {
  identity: string
  lockKeys: ReadonlySet<string>
} {
  const current = generationIdentity(options.current)
  const candidate = generationIdentity(options.candidate)
  const resources = [
    ...new Set([
      ...exclusiveResources(options.current),
      ...exclusiveResources(options.candidate),
    ]),
  ].sort()
  const lockKeys = new Set([
    `generation:${current}`,
    `generation:${candidate}`,
    ...resources.map((resource) => `resource:${resource}`),
  ])
  return {
    identity: `${current}>${candidate}:${resources.join(",")}`,
    lockKeys,
  }
}

function assertTransitionOpen(options: PluginResourceHandoffOptions): void {
  options.signal?.throwIfAborted()
  if (options.deadline !== undefined && Date.now() >= options.deadline)
    throw new PluginLifecycleTimeoutError(options.deadline)
}

function durableState(value: unknown): DurableCommitState {
  if (value === "committed" || value === "not-committed") return value
  throw new TypeError(
    'A durable resource handoff must report "committed" or "not-committed".',
  )
}

function recoveryOptions(options: PluginResourceHandoffOptions): {
  purpose: "recovery"
  deadline: number
} {
  return {
    purpose: "recovery",
    deadline: options.recoveryDeadline ?? Date.now() + DEFAULT_RECOVERY_MS,
  }
}

async function recoverPreDurable(
  options: PluginResourceHandoffOptions,
  transitionError: unknown,
  oldRevokeStarted: boolean,
): Promise<never> {
  const recovery = recoveryOptions(options)
  const recoveryErrors: Array<unknown> = []
  try {
    await options.candidate.revoke(recovery)
  } catch (error) {
    recoveryErrors.push(error)
  }
  if (oldRevokeStarted) {
    // Re-acknowledge quiesce first. Cancellation may have raced a successful
    // physical stop and left the managed phase conservatively committed.
    try {
      await options.current.revoke(recovery)
    } catch (error) {
      recoveryErrors.push(error)
    }
    try {
      await options.current.resume(recovery)
    } catch (error) {
      recoveryErrors.push(error)
    }
  }
  let recoveryError: unknown
  if (recoveryErrors.length === 1) [recoveryError] = recoveryErrors
  else if (recoveryErrors.length > 1)
    recoveryError = new AggregateError(
      recoveryErrors,
      "Resource handoff recovery failed.",
    )
  throw new ResourceHandoffError(
    recoveryError === undefined ?
      "Candidate resource handoff failed; the previous generation was restored."
    : "Candidate resource handoff failed and recovery did not complete.",
    transitionError,
    recoveryError,
  )
}

async function completeCommittedHandoff(
  options: PluginResourceHandoffOptions,
): Promise<void> {
  const recovery = recoveryOptions(options)
  try {
    // A retry can observe the durable point after a crash at any earlier local
    // instruction. Converge to N+1 and never recreate N.
    await options.candidate.prepare(recovery)
    await options.current.revoke(recovery)
    await options.candidate.commit(recovery)
  } catch (error) {
    throw new ResourceHandoffError(
      "The handoff is durably committed but candidate resource recovery did not complete.",
      error,
      undefined,
      "committed",
    )
  }
}

async function queryState(
  options: PluginResourceHandoffOptions,
  cause?: unknown,
): Promise<DurableCommitState> {
  try {
    return durableState(
      await options.queryDurableCommit(options.idempotencyKey),
    )
  } catch (queryError) {
    throw new ResourceHandoffError(
      "The durable resource handoff outcome is ambiguous; retry with the same idempotency key.",
      cause ?? queryError,
      cause === undefined ? undefined : queryError,
      "unknown",
    )
  }
}

async function executeHandoff(
  options: PluginResourceHandoffOptions,
): Promise<void> {
  const initialState = await queryState(options)
  if (initialState === "committed") {
    await completeCommittedHandoff(options)
    return
  }

  const transition = {
    purpose: "handoff" as const,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
  }
  let oldRevokeStarted = false
  try {
    await options.candidate.prepare(transition)
    oldRevokeStarted = true
    await options.current.revoke(transition)
    await options.candidate.commit(transition)
    // This is the explicit durable point. Recheck both cancellation sources
    // after readiness and immediately before invoking the durable writer.
    assertTransitionOpen(options)
  } catch (transitionError) {
    await recoverPreDurable(options, transitionError, oldRevokeStarted)
  }

  let state: DurableCommitState
  try {
    state = durableState(await options.commitDurably(options.idempotencyKey))
  } catch (commitError) {
    state = await queryState(options, commitError)
    if (state === "committed") {
      await completeCommittedHandoff(options)
      return
    }
    await recoverPreDurable(options, commitError, oldRevokeStarted)
  }
  if (state === "committed") return
  await recoverPreDurable(
    options,
    new Error("The durable writer declined the resource handoff."),
    oldRevokeStarted,
  )
}

/**
 * Perform a lease-fenced handoff with an explicit, queryable durable point.
 * Equal concurrent calls share one operation. Calls conflicting by generation
 * or exclusive resource are rejected and may be retried after the winner.
 */
export function handoffPluginResources(
  options: PluginResourceHandoffOptions,
): Promise<void> {
  if (options.idempotencyKey.trim() === "")
    return Promise.reject(
      new TypeError("A handoff idempotency key is required."),
    )

  const { identity, lockKeys } = handoffIdentity(options)
  const sameKey = activeHandoffs.get(options.idempotencyKey)
  if (sameKey) {
    if (sameKey.identity === identity) return sameKey.promise
    return Promise.reject(
      new Error(
        "The handoff idempotency key is already active for another transition.",
      ),
    )
  }
  for (const active of activeHandoffs.values()) {
    if ([...lockKeys].some((key) => active.lockKeys.has(key)))
      return Promise.reject(
        new Error("A conflicting resource handoff is already active."),
      )
  }

  const promise = Promise.resolve().then(() => executeHandoff(options))
  const active = { identity, lockKeys, promise }
  activeHandoffs.set(options.idempotencyKey, active)
  void promise.then(
    () => {
      if (activeHandoffs.get(options.idempotencyKey) === active)
        activeHandoffs.delete(options.idempotencyKey)
    },
    () => {
      if (activeHandoffs.get(options.idempotencyKey) === active)
        activeHandoffs.delete(options.idempotencyKey)
    },
  )
  return promise
}
