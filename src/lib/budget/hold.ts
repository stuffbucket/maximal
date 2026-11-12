import type { PersistedTokenUsageEvent } from "~/lib/token-usage/store"

export type ObservedBudgetTokens = { input: boolean; output: boolean }

export interface BudgetHold {
  readonly id: string
  /** What is held: the estimate, 0 when no limit covers the call. */
  readonly estimateNanoAiu: number
  /** Whether this hold was durably written before dispatch. */
  readonly persisted: boolean
  /** Atomically persist authoritative usage and commit the durable hold. */
  settle(
    events: ReadonlyArray<PersistedTokenUsageEvent>,
    actual?: { nanoAiu?: number },
    afterPersist?: () => void,
  ): Promise<void>
  /** Commit without usage. Kept for non-billed test and internal paths. */
  commit(actual?: { nanoAiu?: number }): Promise<void>
  /** The provider definitely did not bill this call. Idempotent. */
  release(reason: "upstream-error" | "aborted" | "client-gone"): Promise<void>
  /** Dispatch began but final billing could not be established. */
  unreconcile(
    reason: "stream-interrupted" | "usage-missing" | "settlement-failed",
    events?: ReadonlyArray<PersistedTokenUsageEvent>,
    options?: {
      afterPersist?: () => void
      observedTokens?: ObservedBudgetTokens
    },
  ): Promise<void>
}
