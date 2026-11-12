/**
 * Conditions on enforcing a limit (`when`): it applies only while the person
 * is away. Pure. Presence that isn't known (no shell, a stale report) never
 * meets a condition: unknown is not away.
 */

import type { BudgetWhen } from "./schema"

/** What the menu-bar shell last reported (`~/lib/presence`). */
export interface Presence {
  locked: boolean | null
  idleSeconds: number | null
}

/** Whether a limit with this condition is enforced now. No condition: always. */
export function limitApplies(
  when: BudgetWhen | undefined,
  presence: Presence | undefined,
): boolean {
  if (when === undefined) return true
  if (presence === undefined) return false
  if (when.locked === true && presence.locked === true) return true
  // No idle condition, or no idle time known, never meets one.
  const idleSeconds = presence.idleSeconds ?? Number.NEGATIVE_INFINITY
  const needed = (when.idleMinutes ?? Number.POSITIVE_INFINITY) * 60
  return idleSeconds >= needed
}
