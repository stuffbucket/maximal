import type { Random } from "../util"
import type { RetryPolicy } from "./limits"

/** Extra wait added to a server's `Retry-After` (never earlier than the hint). */
export const HINT_JITTER_MS = 250

/**
 * A uniform draw in [0, 1) that is 0 when `random()` returns 0.5, so a
 * fixed `() => 0.5` in tests means "no jitter" for both kinds of jitter.
 */
function spread(random: Random): number {
  return Math.abs(2 * random() - 1)
}

/**
 * Wait before retry number `retry` (0 = the first retry): the larger of
 * the server's hint (plus 0–250 ms) and the fallback schedule with equal
 * jitter (`fallback × (1 ± jitter)`). Callers retry at distinct times even
 * when they were throttled together.
 */
export function backoffDelay(
  policy: Pick<RetryPolicy, "fallbackDelaysMs" | "jitter">,
  retry: number,
  options: { hintMs: number | undefined; random: Random },
): number {
  const { hintMs, random } = options
  const delays = policy.fallbackDelaysMs
  const base = delays[Math.min(retry, delays.length - 1)] ?? 0
  const factor = 1 + policy.jitter * (2 * random() - 1)
  const fallback = Math.max(0, Math.round(base * factor))
  if (hintMs === undefined) return fallback
  return Math.max(
    hintMs + Math.round(HINT_JITTER_MS * spread(random)),
    fallback,
  )
}

/**
 * How long a throttle closes the shared cool-down: the server's hint, else
 * the low end of the jittered fallback. Each retrying caller then waits its
 * own jittered delay past it, so callers throttled together do not all
 * resume at the cool-down's end.
 */
export function cooldownFor(
  policy: Pick<RetryPolicy, "fallbackDelaysMs" | "jitter">,
  retry: number,
  hintMs: number | undefined,
): number {
  if (hintMs !== undefined) return hintMs
  const delays = policy.fallbackDelaysMs
  const base = delays[Math.min(retry, delays.length - 1)] ?? 0
  return Math.max(0, Math.round(base * (1 - policy.jitter)))
}
