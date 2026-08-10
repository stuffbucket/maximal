// Small formatting helpers shared by the Settings sections. Plain functions,
// no framework or capability dependency, so they're trivial to reuse and to
// reason about in isolation.

import { deriveExpiry } from '../shared/expiry'

/** Renders an ISO timestamp as a locale-formatted date + time, or an em dash
 *  when the value is absent (some fields, e.g. `connected_since`, are
 *  optional — the account may predate that field being recorded). */
export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Whole minutes remaining until `expiresAtIso`, floored, never negative. An
 *  unparseable/absent value is treated as already-expired (0), matching
 *  `hasExpired` below — see `deriveExpiry`, the derivation shared with
 *  first-run's countdown so the two surfaces can't disagree on this. `now` is
 *  injectable so a caller can recompute deterministically on a timer without
 *  this function reaching for the clock itself. */
export function minutesRemaining(expiresAtIso: string, now: number = Date.now()): number {
  return Math.floor(deriveExpiry(expiresAtIso, now).remainingMs / 60_000)
}

/** True once `expiresAtIso` has passed, or is absent/unparseable. Lets the
 *  device-code panel show "expired" immediately, rather than waiting for the
 *  next server round trip to collapse the state (see the comment on
 *  `SettingsCapabilities.account.status`). */
export function hasExpired(expiresAtIso: string, now: number = Date.now()): boolean {
  return deriveExpiry(expiresAtIso, now).expired
}

const ADDED_VIA_LABEL = {
  'device-code': 'Signed in here',
  'gh-cli': 'GitHub CLI',
  migration: 'Migrated account',
} as const

/** Human label for `AccountSummary.added_via`. */
export function addedViaLabel(addedVia: keyof typeof ADDED_VIA_LABEL): string {
  return ADDED_VIA_LABEL[addedVia]
}

/** Renders an unknown thrown value as user-facing text without ever showing
 *  "[object Object]" — the common failure mode of `String(caughtValue)`. */
export function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
