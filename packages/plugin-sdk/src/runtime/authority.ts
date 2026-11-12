import type { PluginStorageBackend } from "./services"

/**
 * Parent-owned access to the reserved per-plugin `settings.json` document.
 *
 * The plugin host consumes this interface; it never opens or writes the
 * reserved document itself. A future process runner can implement the same
 * interface with reverse RPC. Ordinary trusted plugin storage remains a
 * separate service and is not a sandbox boundary.
 */

export interface PluginSettingsRevision {
  readonly pluginId: string
  /** Monotonic revision of this plugin's reserved document. */
  readonly revision: number
  /** Monotonic revision of all host-owned control-plane state. */
  readonly epoch: number
  /** Exact committed bytes, absent when the document does not exist. */
  readonly text?: string
}

export type PluginSettingsProposalKind =
  | "migration"
  | "config"
  | "permissions"
  | "catalog"
  | "legacy-config"

export interface PluginSettingsProposal {
  readonly pluginId: string
  readonly baseRevision: number
  readonly baseEpoch: number
  readonly kind: PluginSettingsProposalKind
  /** Canonical complete replacement bytes. */
  readonly text: string
}

export interface PluginSettingsCommit {
  readonly pluginId: string
  readonly revision: number
  readonly epoch: number
  readonly text: string
}

export interface PluginSettingsTransaction extends PluginSettingsAuthority {
  /** Atomically make every staged proposal authoritative. */
  finish(): Promise<ReadonlyArray<PluginSettingsCommit>>
  /** Discard every staged proposal. Idempotent. */
  rollback(): void
}

export interface PluginSettingsAuthority {
  /** Immutable snapshot of the latest committed bytes. */
  snapshot(pluginId: string): Promise<PluginSettingsRevision>
  /**
   * Compare-and-swap a complete canonical document. Both the per-plugin
   * revision and global epoch are checked. Stale proposals reject with
   * `PluginSettingsConflictError`; callers may replay against a fresh snapshot.
   */
  commit(proposal: PluginSettingsProposal): Promise<PluginSettingsCommit>
  /** Latest known global epoch. */
  epoch(): Promise<number>
  /**
   * Stage several settings mutations behind one authority commit. Candidate
   * hosts use this while reconciling an inventory so no migration or catalog
   * write is visible until every candidate has proved ready.
   */
  beginTransaction(): PluginSettingsTransaction
}

export class PluginSettingsConflictError extends Error {
  readonly pluginId: string
  readonly expectedRevision: number
  readonly actualRevision: number
  readonly expectedEpoch: number
  readonly actualEpoch: number

  constructor(options: {
    pluginId: string
    expectedRevision: number
    actualRevision: number
    expectedEpoch: number
    actualEpoch: number
  }) {
    super(
      `Plugin settings proposal for "${options.pluginId}" is stale (revision ${options.expectedRevision}/${options.actualRevision}, epoch ${options.expectedEpoch}/${options.actualEpoch}).`,
    )
    this.name = "PluginSettingsConflictError"
    this.pluginId = options.pluginId
    this.expectedRevision = options.expectedRevision
    this.actualRevision = options.actualRevision
    this.expectedEpoch = options.expectedEpoch
    this.actualEpoch = options.actualEpoch
  }
}

export function isPluginSettingsConflictError(
  error: unknown,
): error is PluginSettingsConflictError {
  return (
    error instanceof PluginSettingsConflictError
    || (error instanceof Error && error.name === "PluginSettingsConflictError")
  )
}

/**
 * Minimal direct-loopback authority for SDK/host tests. Production uses the
 * durable parent broker in `src/lib/plugins/state-broker.ts`.
 */
export function createStorageSettingsAuthority(
  storage: PluginStorageBackend,
): PluginSettingsAuthority {
  const revisions = new Map<string, { revision: number; text?: string }>()
  let controlEpoch = 0
  let queue = Promise.resolve()
  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const current = async (pluginId: string) => {
    const text = await storage.readText(pluginId, "settings.json")
    const known = revisions.get(pluginId)
    if (!known) {
      const initial = { revision: 0, ...(text === undefined ? {} : { text }) }
      revisions.set(pluginId, initial)
      return initial
    }
    if (known.text === text) return known
    controlEpoch += 1
    const changed = {
      revision: known.revision + 1,
      ...(text === undefined ? {} : { text }),
    }
    revisions.set(pluginId, changed)
    return changed
  }
  const authority: PluginSettingsAuthority = {
    snapshot: (pluginId) =>
      run(async () => {
        const state = await current(pluginId)
        return Object.freeze({ pluginId, ...state, epoch: controlEpoch })
      }),
    commit: (proposal) =>
      run(async () => {
        const state = await current(proposal.pluginId)
        if (
          state.revision !== proposal.baseRevision
          || controlEpoch !== proposal.baseEpoch
        ) {
          throw new PluginSettingsConflictError({
            pluginId: proposal.pluginId,
            expectedRevision: proposal.baseRevision,
            actualRevision: state.revision,
            expectedEpoch: proposal.baseEpoch,
            actualEpoch: controlEpoch,
          })
        }
        if (state.text !== proposal.text) {
          await storage.writeText(
            proposal.pluginId,
            "settings.json",
            proposal.text,
          )
          controlEpoch += 1
          revisions.set(proposal.pluginId, {
            revision: state.revision + 1,
            text: proposal.text,
          })
        }
        const committed = revisions.get(proposal.pluginId) ?? state
        return Object.freeze({
          pluginId: proposal.pluginId,
          revision: committed.revision,
          epoch: controlEpoch,
          text: proposal.text,
        })
      }),
    epoch: () => run(() => Promise.resolve(controlEpoch)),
    beginTransaction: () => bufferedTransaction(authority),
  }
  return authority
}

/** A data-only transaction adapter. Durable authorities replace `finish`. */
// eslint-disable-next-line max-lines-per-function -- transaction closure shares staged CAS state
function bufferedTransaction(
  authority: PluginSettingsAuthority,
): PluginSettingsTransaction {
  const base = new Map<string, PluginSettingsRevision>()
  const staged = new Map<string, PluginSettingsRevision>()
  let baseEpoch: number | undefined
  let localEpoch: number | undefined
  let closed = false

  const ensureOpen = (): void => {
    if (closed) throw new Error("Plugin settings transaction is closed.")
  }
  const snapshot = async (
    pluginId: string,
  ): Promise<PluginSettingsRevision> => {
    ensureOpen()
    const existing = staged.get(pluginId)
    if (existing) return existing
    let initial = base.get(pluginId)
    if (!initial) {
      initial = await authority.snapshot(pluginId)
      if (baseEpoch !== undefined && initial.epoch !== baseEpoch) {
        throw new PluginSettingsConflictError({
          pluginId,
          expectedRevision: initial.revision,
          actualRevision: initial.revision,
          expectedEpoch: baseEpoch,
          actualEpoch: initial.epoch,
        })
      }
      baseEpoch ??= initial.epoch
      localEpoch ??= initial.epoch
      base.set(pluginId, initial)
    }
    return Object.freeze({ ...initial, epoch: localEpoch ?? initial.epoch })
  }
  const transaction: PluginSettingsTransaction = {
    snapshot,
    async commit(proposal) {
      const state = await snapshot(proposal.pluginId)
      const epoch = localEpoch ?? state.epoch
      if (
        state.revision !== proposal.baseRevision
        || epoch !== proposal.baseEpoch
      ) {
        throw new PluginSettingsConflictError({
          pluginId: proposal.pluginId,
          expectedRevision: proposal.baseRevision,
          actualRevision: state.revision,
          expectedEpoch: proposal.baseEpoch,
          actualEpoch: epoch,
        })
      }
      if (state.text === proposal.text) {
        return Object.freeze({
          pluginId: proposal.pluginId,
          revision: state.revision,
          epoch,
          text: proposal.text,
        })
      }
      localEpoch = epoch + 1
      const next = Object.freeze({
        pluginId: proposal.pluginId,
        revision: state.revision + 1,
        epoch: localEpoch,
        text: proposal.text,
      })
      staged.set(proposal.pluginId, next)
      return next
    },
    epoch: async () => {
      ensureOpen()
      if (localEpoch !== undefined) return localEpoch
      const epoch = await authority.epoch()
      baseEpoch = epoch
      // Transaction methods are serialized by their caller; the await reads authority state.
      // eslint-disable-next-line require-atomic-updates
      localEpoch = epoch
      return epoch
    },
    beginTransaction: () => {
      throw new Error("Nested plugin settings transactions are not supported.")
    },
    async finish() {
      ensureOpen()
      closed = true
      const commits: Array<PluginSettingsCommit> = []
      for (const [pluginId, state] of staged) {
        const original = base.get(pluginId)
        if (!original) continue
        const latest = await authority.snapshot(pluginId)
        if (latest.revision !== original.revision) {
          throw new PluginSettingsConflictError({
            pluginId,
            expectedRevision: original.revision,
            actualRevision: latest.revision,
            expectedEpoch: original.epoch,
            actualEpoch: latest.epoch,
          })
        }
        commits.push(
          await authority.commit({
            pluginId,
            baseRevision: latest.revision,
            baseEpoch: latest.epoch,
            kind: "migration",
            text: state.text ?? "",
          }),
        )
      }
      return commits
    },
    rollback() {
      closed = true
      staged.clear()
    },
  }
  return transaction
}
