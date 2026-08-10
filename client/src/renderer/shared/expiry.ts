// Shared "time until an ISO expiry" derivation. Both `first-run` and
// `settings` compute a countdown against `AuthStatus.expires_at` (the device
// code's expiry) — this is the one place that arithmetic happens, so the two
// surfaces can't independently pick different (and differently wrong) guards
// for the same unparseable-timestamp input.

export interface ExpiryInfo {
  /** Milliseconds remaining, clamped to >= 0. Meaningless when `expired` is
   *  true from an unparseable/absent input — callers that need a countdown
   *  should always check `expired` first. */
  remainingMs: number
  /** True once `expiresAtIso` has passed, *or* when it is absent or fails to
   *  parse. Treating "we don't know" as "expired" is the safer default here:
   *  it steers the UI toward "request a new code" rather than rendering a
   *  countdown that never ends (e.g. the previous `Infinity`/`NaN` output). */
  expired: boolean
}

/**
 * Derives remaining time and expiry from an ISO timestamp. `now` is
 * injectable so callers can recompute deterministically on a timer without
 * this function reaching for the clock itself.
 */
export function deriveExpiry(expiresAtIso: string | undefined, now: number = Date.now()): ExpiryInfo {
  const expiresAtMs = expiresAtIso ? Date.parse(expiresAtIso) : NaN
  if (!Number.isFinite(expiresAtMs)) {
    return { remainingMs: 0, expired: true }
  }
  const remainingMs = expiresAtMs - now
  return { remainingMs: Math.max(0, remainingMs), expired: remainingMs <= 0 }
}
