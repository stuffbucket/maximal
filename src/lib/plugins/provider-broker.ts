import type {
  ProviderCost,
  ProviderInvocation,
  ProviderModelInfo,
  ProviderQuotaWindow,
  ProviderRequestOptions,
  UpstreamProvider,
} from "@stuffbucket/maximal-plugin-sdk"

export interface ProviderBrokerSnapshot {
  readonly revision: number
  readonly available: boolean
  readonly models: ReadonlyArray<ProviderModelInfo>
}

/** Parent-owned provider boundary; credentials never enter a plugin runner. */
export interface ParentProviderBroker {
  readonly id: string
  readonly displayName: string
  snapshot(): ProviderBrokerSnapshot
  subscribe(listener: () => void): () => void
  postJson<T>(
    path: string,
    body: Record<string, unknown> | FormData,
    options: ProviderRequestOptions,
  ): Promise<T>
  adviseError?(upstream: {
    status: number
    text: string
    call?: { provider?: string; endpoint: string; model?: string }
  }): string | undefined
  cost(
    reply: Record<string, unknown>,
    request: { operation: string; model: string },
  ): ProviderCost | undefined
  quotaWindows?(): Promise<ReadonlyArray<ProviderQuotaWindow>>
  refreshQuotaWindows?(): Promise<ReadonlyArray<ProviderQuotaWindow>>
}

export interface ProviderCallObservation {
  readonly invocation: ProviderInvocation
  readonly provider: string
  /** Absent while the provider outcome is ambiguous or reported no price. */
  readonly cost?: ProviderCost
  readonly outcome: "pending" | "success"
}

interface InvocationState {
  readonly calls: Map<string, ProviderCallObservation>
  readonly acknowledged: Map<string, number>
  lastSequence: number
  totalCalls: number
}

export class ProviderInvocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderInvocationError"
  }
}

function validInvocation(invocation: ProviderInvocation): boolean {
  return (
    invocation.invocationId.length > 0
    && invocation.providerCallId.length > 0
    && Number.isSafeInteger(invocation.sequence)
    && invocation.sequence > 0
  )
}

/**
 * Bounded parent journal. A call is reserved before transport, becomes observed
 * after a reply, and is removed only by an idempotent matching acknowledgment.
 * Open durable budget holds provide crash recovery; this journal conservatively
 * settles runner/process-local ambiguity without replaying a provider mutation.
 */
export class ProviderInvocationJournal {
  readonly #invocations = new Map<string, InvocationState>()
  readonly #closedInvocations = new Set<string>()
  readonly #maxInvocations: number
  readonly #maxCallsPerInvocation: number

  constructor(
    options: {
      maxInvocations?: number
      maxCallsPerInvocation?: number
    } = {},
  ) {
    this.#maxInvocations = options.maxInvocations ?? 1024
    this.#maxCallsPerInvocation = options.maxCallsPerInvocation ?? 64
  }

  /** Reserve an identity before transport. Duplicate/reordered calls never run. */
  begin(invocation: ProviderInvocation, provider: string): void {
    if (!validInvocation(invocation))
      throw new ProviderInvocationError(
        "Provider invocation identity is invalid.",
      )
    if (this.#closedInvocations.has(invocation.invocationId))
      throw new ProviderInvocationError(
        "A closed provider invocation cannot be replayed.",
      )
    let state = this.#invocations.get(invocation.invocationId)
    if (!state) {
      if (this.#invocations.size >= this.#maxInvocations) {
        throw new ProviderInvocationError(
          "Provider invocation journal is full.",
        )
      }
      state = {
        calls: new Map(),
        acknowledged: new Map(),
        lastSequence: 0,
        totalCalls: 0,
      }
      this.#invocations.set(invocation.invocationId, state)
    }
    const acknowledgedSequence = state.acknowledged.get(
      invocation.providerCallId,
    )
    if (acknowledgedSequence !== undefined) {
      if (acknowledgedSequence === invocation.sequence)
        throw new ProviderInvocationError(
          "An acknowledged provider call cannot be replayed.",
        )
      throw new ProviderInvocationError(
        "Provider call identity was reused with a different sequence.",
      )
    }
    const previous = state.calls.get(invocation.providerCallId)
    if (previous) {
      if (
        previous.invocation.sequence === invocation.sequence
        && previous.provider === provider
      ) {
        throw new ProviderInvocationError(
          "An ambiguous provider call cannot be replayed.",
        )
      }
      throw new ProviderInvocationError(
        "Provider call identity was reused with different metadata.",
      )
    }
    if (invocation.sequence <= state.lastSequence) {
      throw new ProviderInvocationError(
        "Provider call sequence must increase monotonically.",
      )
    }
    if (state.totalCalls >= this.#maxCallsPerInvocation) {
      throw new ProviderInvocationError(
        "Provider invocation has too many provider calls.",
      )
    }
    state.lastSequence = invocation.sequence
    state.totalCalls += 1
    state.calls.set(invocation.providerCallId, {
      invocation: Object.freeze({ ...invocation }),
      provider,
      outcome: "pending",
    })
  }

  observeSuccess(
    invocation: ProviderInvocation,
    provider: string,
    cost?: ProviderCost,
  ): void {
    const state = this.#invocations.get(invocation.invocationId)
    const previous = state?.calls.get(invocation.providerCallId)
    if (
      !state
      || !previous
      || previous.invocation.sequence !== invocation.sequence
      || previous.provider !== provider
    )
      throw new ProviderInvocationError(
        "Provider success did not match a started call.",
      )
    state.calls.set(invocation.providerCallId, {
      invocation: previous.invocation,
      provider,
      ...(cost === undefined ? {} : { cost }),
      outcome: "success",
    })
  }

  /** Compatibility helper for tests and reverse-RPC success frames. */
  observe(observation: Omit<ProviderCallObservation, "outcome">): void {
    const state = this.#invocations.get(observation.invocation.invocationId)
    if (!state?.calls.has(observation.invocation.providerCallId)) {
      this.begin(observation.invocation, observation.provider)
    }
    this.observeSuccess(
      observation.invocation,
      observation.provider,
      observation.cost,
    )
  }

  /** Remove one observed call. Repeating the same acknowledgment is harmless. */
  acknowledge(
    invocationId: string,
    providerCallId: string,
    sequence: number,
  ): void {
    const state = this.#invocations.get(invocationId)
    if (!state) return
    const acknowledged = state.acknowledged.get(providerCallId)
    if (acknowledged !== undefined) {
      if (acknowledged !== sequence)
        throw new ProviderInvocationError(
          "Provider acknowledgment sequence does not match.",
        )
      return
    }
    const observation = state.calls.get(providerCallId)
    if (!observation) return
    if (observation.invocation.sequence !== sequence)
      throw new ProviderInvocationError(
        "Provider acknowledgment sequence does not match.",
      )
    state.calls.delete(providerCallId)
    state.acknowledged.set(providerCallId, sequence)
  }

  /** Ordered calls that still need conservative settlement. */
  unacknowledged(invocationId: string): ReadonlyArray<ProviderCallObservation> {
    const state = this.#invocations.get(invocationId)
    if (!state) return []
    return [...state.calls.values()].sort(
      (a, b) => a.invocation.sequence - b.invocation.sequence,
    )
  }

  finish(invocationId: string): void {
    if (!this.#invocations.delete(invocationId)) return
    this.#rememberClosed(invocationId)
  }

  /** Recover every open observation for conservative shutdown settlement. */
  recover(): ReadonlyArray<ProviderCallObservation> {
    const observations = [...this.#invocations.values()]
      .flatMap((state) => [...state.calls.values()])
      .sort((a, b) => {
        const byInvocation = a.invocation.invocationId.localeCompare(
          b.invocation.invocationId,
        )
        return byInvocation || a.invocation.sequence - b.invocation.sequence
      })
    for (const invocationId of this.#invocations.keys())
      this.#rememberClosed(invocationId)
    this.#invocations.clear()
    return observations
  }

  reset(): void {
    this.#invocations.clear()
    this.#closedInvocations.clear()
  }

  #rememberClosed(invocationId: string): void {
    this.#closedInvocations.add(invocationId)
    while (this.#closedInvocations.size > this.#maxInvocations) {
      const oldest = this.#closedInvocations.values().next().value
      if (oldest === undefined) break
      this.#closedInvocations.delete(oldest)
    }
  }
}

export const providerInvocationJournal = new ProviderInvocationJournal()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
}

/** Project a parent broker into today's in-process SDK provider interface. */
export function providerFromBroker(
  broker: ParentProviderBroker,
  journal: ProviderInvocationJournal = providerInvocationJournal,
): UpstreamProvider {
  return {
    id: broker.id,
    displayName: broker.displayName,
    async postJson<T>(
      path: string,
      body: Record<string, unknown> | FormData,
      options: ProviderRequestOptions,
    ): Promise<T> {
      const { invocation } = options
      journal.begin(invocation, broker.id)
      const reply = await broker.postJson<T>(path, body, options)
      const observedReply: unknown = reply
      journal.observeSuccess(
        invocation,
        broker.id,
        isRecord(observedReply) ?
          broker.cost(observedReply, {
            operation: invocation.operation,
            model: invocation.model,
          })
        : undefined,
      )
      return reply
    },
    model(id) {
      return broker.snapshot().models.find((model) => model.id === id)
    },
    onCatalogChange: (listener) => broker.subscribe(listener),
    available: () => broker.snapshot().available,
    ...(broker.adviseError === undefined ?
      {}
    : {
        adviseError: (upstream) => broker.adviseError?.(upstream),
      }),
    cost: (reply, request) => broker.cost(reply, request),
    ...(broker.quotaWindows === undefined ?
      {}
    : {
        quotaWindows: () => broker.quotaWindows?.() ?? Promise.resolve([]),
      }),
    ...(broker.refreshQuotaWindows === undefined ?
      {}
    : {
        refreshQuotaWindows: () =>
          broker.refreshQuotaWindows?.() ?? Promise.resolve([]),
      }),
  }
}
