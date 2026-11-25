import type {
  CommittedPluginGeneration,
  GenerationCommitProposal,
  PluginStateBroker,
  PluginStateTransaction,
} from "../state-broker"

/**
 * Wraps the durable control-plane broker and keeps a synchronous view of its
 * epoch. Every in-process control mutation (settings commits, provider
 * mutations, generation commits, transaction finishes) refreshes the view
 * before its promise resolves, so a fence read between two awaits is never
 * older than the last local mutation. The authoritative `sync()` read and the
 * broker's own CAS remain the commit-time guards.
 */
export class EpochTrackedStateBroker implements PluginStateBroker {
  readonly #inner: PluginStateBroker
  #epoch = 0

  constructor(inner: PluginStateBroker) {
    this.#inner = inner
  }

  /** Last epoch observed by this process; always current for local writers. */
  cachedEpoch(): number {
    return this.#epoch
  }

  /** Authoritative read that also refreshes the cached view. */
  async sync(): Promise<number> {
    const epoch = await this.#inner.epoch()
    this.#epoch = Math.max(this.#epoch, epoch)
    return epoch
  }

  epoch(): Promise<number> {
    return this.sync()
  }

  snapshot(
    ...args: Parameters<PluginStateBroker["snapshot"]>
  ): ReturnType<PluginStateBroker["snapshot"]> {
    return this.#inner.snapshot(...args)
  }

  commit(
    ...args: Parameters<PluginStateBroker["commit"]>
  ): ReturnType<PluginStateBroker["commit"]> {
    return this.#then(() => this.#inner.commit(...args))
  }

  beginTransaction(): PluginStateTransaction {
    const transaction = this.#inner.beginTransaction()
    return {
      snapshot: (...args) => transaction.snapshot(...args),
      commit: (...args) => transaction.commit(...args),
      epoch: () => transaction.epoch(),
      beginTransaction: () => transaction.beginTransaction(),
      selectGeneration: (...args) => {
        transaction.selectGeneration(...args)
      },
      rollback: () => {
        transaction.rollback()
      },
      finish: () => this.#then(() => transaction.finish()),
    }
  }

  commitGeneration(
    proposal: GenerationCommitProposal,
  ): Promise<CommittedPluginGeneration> {
    return this.#then(() => this.#inner.commitGeneration(proposal))
  }

  committedGeneration(): Promise<CommittedPluginGeneration | undefined> {
    return this.#inner.committedGeneration()
  }

  markGenerationInstalled(commitId: string): Promise<void> {
    return this.#inner.markGenerationInstalled(commitId)
  }

  markGenerationPublished(commitId: string): Promise<void> {
    return this.#inner.markGenerationPublished(commitId)
  }

  advanceEpoch(kind: string, mutationDigest?: string): Promise<number> {
    return this.#then(() => this.#inner.advanceEpoch(kind, mutationDigest))
  }

  /** Refresh after the mutation settles, success or failure (a failure may
   *  still have reached the durable commit point). */
  async #then<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } finally {
      await this.sync().catch(() => undefined)
    }
  }
}
