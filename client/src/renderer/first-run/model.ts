import { deriveExpiry } from '../shared/expiry'
import type { AuthStatus } from './capabilities'
import type { BootPhase } from './capabilities'

/**
 * The state model for the first-run flow, derived from three inputs:
 * core lifecycle (`BootPhase`), the latest `AuthStatus` from
 * maximal-core's device-flow controller, and the client's own clock (so a
 * device code that has visibly expired is shown as expired immediately,
 * without waiting on a server round-trip to notice).
 *
 * `maximal-core`'s wire contract (`AuthStatus`, see
 * `@stuffbucket/maximal-core/settings-types`) has exactly five states:
 * `unauthenticated`, `device_code_issued`, `polling`, `authenticated`,
 * `error` — there is no dedicated `authorization_denied` or
 * `device_code_expired` wire state. Both are collapsed into the generic
 * `error` variant's free-text `error` message by
 * `poll-access-token.ts`/`auth-controller.ts` upstream. `deriveFirstRunPhase`
 * below reconstructs the distinct, task-required terminal states from that
 * text (denied / expired / offline) — a heuristic, not a structural
 * discriminant; see the task report for why and what a sturdier upstream
 * contract would look like.
 */

export type ActionError =
  | { kind: 'offline'; message: string }
  | { kind: 'fatal'; message: string }

export type FirstRunPhase =
  /** Core hasn't reported ready yet (or failed/crashed/restarting). */
  | { kind: 'boot'; boot: BootPhase }
  /** Core is ready; the first `auth/status` call is still in flight. */
  | { kind: 'loading' }
  /** No device flow in progress, not signed in. */
  | { kind: 'signed-out' }
  /** A device code is live and (possibly) being polled. */
  | { kind: 'pending'; userCode: string; verificationUri: string; remainingMs: number; polling: boolean }
  /** Signed in. */
  | { kind: 'authorized'; login: string }
  /** The user (or someone) declined the authorization request on GitHub. */
  | { kind: 'authorization-denied'; message: string }
  /** The device code timed out before it was used — client- or
   *  server-detected. */
  | { kind: 'device-code-expired' }
  /** A network problem is blocking sign-in or is persisting while signed out. */
  | { kind: 'offline'; message: string }
  /** Anything else terminal and unexpected. */
  | { kind: 'fatal'; message: string; remediationUrl?: string }

const DENIED_PATTERN = /denied/i
const OFFLINE_PATTERN = /network unreachable|offline|unreachable/i
const EXPIRED_PATTERN = /expired/i

export interface DerivePhaseInput {
  boot: BootPhase
  status: AuthStatus | null
  actionError: ActionError | null
  nowMs: number
}

// One linear precedence ladder (boot -> action error -> loading -> wire
// state); splitting it scatters the ordering that makes it reviewable as a
// single decision.
export function deriveFirstRunPhase(input: DerivePhaseInput): FirstRunPhase {
  const { boot, status, actionError, nowMs } = input

  if (boot.phase !== 'ready') {
    return { kind: 'boot', boot }
  }

  if (actionError) {
    return actionError.kind === 'offline'
      ? { kind: 'offline', message: actionError.message }
      : { kind: 'fatal', message: actionError.message }
  }

  if (!status) {
    return { kind: 'loading' }
  }

  switch (status.state) {
    case 'unauthenticated': {
      // Presence alone is the signal: network_diagnosis is only ever set
      // once a failure has persisted past the onset window (see
      // settings-types.ts) — there is no "diagnosis: none" value to check
      // against.
      if (status.network_diagnosis) {
        return { kind: 'offline', message: describeNetworkDiagnosis(status.network_diagnosis.kind) }
      }
      return { kind: 'signed-out' }
    }

    case 'authenticated': {
      return { kind: 'authorized', login: status.account_login }
    }

    case 'device_code_issued':
    case 'polling': {
      // An unparseable/absent `expires_at` is treated as already-expired
      // (see `deriveExpiry`) rather than as "never expires" — the previous
      // behaviour rendered "Infinity:NaN" via `formatRemaining` instead of
      // ever reaching this branch's expired state.
      const { remainingMs, expired } = deriveExpiry(status.expires_at, nowMs)
      if (expired) {
        return { kind: 'device-code-expired' }
      }
      return {
        kind: 'pending',
        userCode: status.user_code,
        verificationUri: status.verification_uri,
        remainingMs,
        polling: status.state === 'polling',
      }
    }

    case 'error': {
      if (DENIED_PATTERN.test(status.error)) {
        return { kind: 'authorization-denied', message: status.error }
      }
      if (EXPIRED_PATTERN.test(status.error)) {
        return { kind: 'device-code-expired' }
      }
      if (OFFLINE_PATTERN.test(status.error)) {
        return { kind: 'offline', message: status.error }
      }
      return { kind: 'fatal', message: status.error, remediationUrl: status.remediation_url }
    }

    default: {
      return assertNever(status)
    }
  }
}

function describeNetworkDiagnosis(kind: 'offline' | 'dns-failure' | 'scope-unreachable' | 'unknown'): string {
  switch (kind) {
    case 'offline':
      return "It looks like you're offline."
    case 'dns-failure':
      return "Maximal couldn't resolve GitHub's address. Check your network or DNS settings."
    case 'scope-unreachable':
      return "Maximal can't reach GitHub Copilot from this network."
    case 'unknown':
      return 'Maximal is having trouble reaching GitHub.'
    default:
      return assertNever(kind)
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled first-run value: ${JSON.stringify(value)}`)
}

// Re-exported for existing importers (`DeviceCode.tsx`) — the implementation
// lives in `../shared/device-code` so `settings/DeviceCodePanel.tsx` can use
// the exact same spelling without depending on this module's internals.
export { spellOutCode } from '../shared/device-code'

/** "3:41" style countdown from a millisecond duration. Clamped to zero —
 *  callers that need to detect expiry should compare `remainingMs <= 0`
 *  directly rather than parsing this string. */
export function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
