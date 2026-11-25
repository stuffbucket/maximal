import type {
  PluginGenerationResourceLifecycle,
  PluginResourceLifecycle,
} from "@stuffbucket/maximal-plugin-sdk"

import {
  handoffPluginResources,
  HostGenerationResourceLifecycle,
  ManagedPluginResourceLifecycle,
  ResourceHandoffError,
} from "@stuffbucket/maximal-plugin-host"
import { ExclusiveResourceLeaseRegistry } from "@stuffbucket/maximal-plugin-sdk"

import type {
  ExclusiveHandoff,
  ExclusiveResourceManager,
} from "./generation-cutover"

interface RegisteredGeneration {
  readonly lifecycle: PluginGenerationResourceLifecycle
}

export interface ParentGenerationPluginResources {
  readonly pluginId: string
  readonly hooks: PluginResourceLifecycle
}

function completedHandoff(): ExclusiveHandoff {
  return {
    rollback: () => Promise.resolve(),
    finish: () => Promise.resolve(),
  }
}

function nextRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const completed = (): void => {
      signal.removeEventListener("abort", aborted)
      resolve()
    }
    const timer = setTimeout(completed, 0)
    const aborted = (): void => {
      clearTimeout(timer)
      reject(new Error("Resource handoff retry was aborted."))
    }
    if (signal.aborted) aborted()
    else signal.addEventListener("abort", aborted, { once: true })
  })
}

/**
 * Parent-owned exclusive-resource authority shared by every live generation.
 * The same lease registry is supplied to direct hosts and to managed lifecycle
 * objects, so N and N+1 can never acquire the same singleton concurrently.
 */
export class DurableExclusiveResourceManager<
  TSnapshot,
> implements ExclusiveResourceManager<TSnapshot> {
  readonly #leases: ExclusiveResourceLeaseRegistry
  readonly #generations = new Map<string, RegisteredGeneration>()

  constructor(leases = new ExclusiveResourceLeaseRegistry()) {
    this.#leases = leases
  }

  get leases(): ExclusiveResourceLeaseRegistry {
    return this.#leases
  }

  /** Options passed to every parent-composed generation host. */
  resourceActivation(mode: "active" | "candidate"): {
    mode: "active" | "candidate"
    leases: ExclusiveResourceLeaseRegistry
  } {
    return { mode, leases: this.#leases }
  }

  /** Build a generation lifecycle whose plugin slots all share this registry. */
  createGeneration(
    generationId: string,
    plugins: ReadonlyArray<ParentGenerationPluginResources>,
    overlapSafe: ReadonlyArray<string> = [],
  ): PluginGenerationResourceLifecycle {
    const slots = plugins.map(
      ({ pluginId, hooks }) =>
        new ManagedPluginResourceLifecycle({
          pluginId,
          generationId,
          hooks,
          leases: this.#leases,
        }),
    )
    const lifecycle = new HostGenerationResourceLifecycle({
      slots: () => [...slots],
      overlapSafe: () => [...overlapSafe],
    })
    this.registerGeneration(generationId, lifecycle)
    return lifecycle
  }

  registerGeneration(
    generationId: string,
    lifecycle: PluginGenerationResourceLifecycle,
  ): () => void {
    const current = this.#generations.get(generationId)
    if (current && current.lifecycle !== lifecycle)
      throw new Error(`Generation ${generationId} already has resource state.`)
    const registration = { lifecycle }
    this.#generations.set(generationId, registration)
    return () => {
      if (this.#generations.get(generationId) === registration)
        this.#generations.delete(generationId)
    }
  }

  async handoff(
    input: Parameters<ExclusiveResourceManager<TSnapshot>["handoff"]>[0],
    signal: AbortSignal,
  ): Promise<ExclusiveHandoff> {
    const current = this.#generation(input.fromGenerationId)
    const candidate = this.#generation(input.toGenerationId)
    const tuple = {
      current,
      candidate,
      idempotencyKey: input.idempotencyKey,
      commitDurably: input.commitDurably,
      queryDurableCommit: input.queryDurableCommit,
      signal,
    }

    for (;;) {
      try {
        await handoffPluginResources(tuple)
        return completedHandoff()
      } catch (error) {
        if (
          !(error instanceof ResourceHandoffError)
          || (error.durableState !== "unknown"
            && error.durableState !== "committed")
        )
          throw error
        if (signal.aborted) throw error
        // Keep this exact object and its current/candidate/key identities. A
        // committed retry converges to N+1; an unknown retry re-queries first.
        await nextRetry(signal)
      }
    }
  }

  async recover(
    record: Parameters<ExclusiveResourceManager<TSnapshot>["recover"]>[0],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    const current = this.#generations.get(record.previousGenerationId)
    const candidate = this.#generation(record.generationId)
    await candidate.prepare({ signal, purpose: "recovery" })
    await current?.lifecycle.revoke({ signal, purpose: "recovery" })
    await candidate.commit({ signal, purpose: "recovery" })
  }

  async restoreOld(
    generationId: string,
    _resources: ReadonlyArray<string>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    await this.#generation(generationId).resume({
      signal,
      purpose: "recovery",
    })
  }

  #generation(generationId: string): PluginGenerationResourceLifecycle {
    const generation = this.#generations.get(generationId)
    if (!generation)
      throw new Error(`Generation ${generationId} has no resource lifecycle.`)
    return generation.lifecycle
  }
}
