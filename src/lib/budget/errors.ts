/**
 * The refusal a spent limit produces, and the error that carries it to the
 * routes. `proxyErrorHandler` renders it (`~/lib/errors/proxy-errors`).
 * Imports nothing but types, so the error module can depend on it.
 */

import type { RefusalUnit } from "./metric"
import type { BudgetScope } from "./schema"

export interface BudgetRefusal {
  limitId: string
  label: string | null
  scope: BudgetScope
  /** What the figures below are in: nano-AIU (cost), a token measure, or a
   *  count of requests (`maxRequests`). */
  unit: RefusalUnit
  /** The limit and what counts against it, in `unit`. */
  limit: number
  used: number
  held: number
  /** This request's estimate; 0 for a call that can't be estimated. */
  requested: number
  /** When the period ends; null for a limit that never resets. */
  resetsAtMs: number | null
  /** The period's end is Maximal's guess, not the provider's. */
  resetEstimated: boolean
  /** Refused only because requests in progress hold the room: it comes
   *  back by itself in moments, not at the reset. */
  inFlight: boolean
  /** For a rule that asks: `pending` while a request for more room waits for
   *  the person, `declined` once they said to keep it blocked this period. */
  approval?: "pending" | "declined"
  /** One plain sentence for the person and for the model. */
  message: string
  /** USD per AI credit, for the figures a body reports in dollars. */
  creditUsd: number
}

export class BudgetExceededError extends Error {
  readonly refusal: BudgetRefusal

  constructor(refusal: BudgetRefusal) {
    super(refusal.message)
    this.name = "BudgetExceededError"
    this.refusal = refusal
  }
}
