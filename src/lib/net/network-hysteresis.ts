/**
 * Debounce + recovery-notify state machine for the network-issue banner.
 *
 * The raw diagnosis engine (`network-diagnostics.ts`) can flip on every probe:
 * a single dropped packet during a Wi-Fi roam produces a one-off
 * `scope-unreachable`/`offline` verdict that clears on the next attempt. Showing
 * a banner for that is noise. This module sits between the raw verdict and the
 * banner signal (`state.setNetworkDiagnosis`) and applies two rules:
 *
 *   1. ONSET debounce — a failure must PERSIST for `NETWORK_BANNER_ONSET_MS`
 *      before it's promoted to a banner-worthy `bannerDiagnosis`. A blip shorter
 *      than that never reaches the UI. `firstFailureAt` anchors the window;
 *      distinct failure verdicts arriving during the window don't reset it (the
 *      outage is continuous — we track *when it started*, not the latest kind).
 *
 *   2. RECONNECT notify — when a failure clears (a null / ok input), we signal a
 *      "you're back" notification ONLY if the outage lasted longer than
 *      `NOTIFY_ON_RECONNECT_MS`. A sub-threshold blip clears silently (the banner
 *      just disappears); a real outage earns the notification so the user can
 *      tell something actually recovered.
 *
 * PURE + injected clock: `step` takes the previous state, the raw diagnosis, and
 * `now` (epoch ms), and returns the next state plus the two derived signals. It
 * touches no globals, so it's exhaustively unit-testable with a fake clock. The
 * module-singleton holder (`getHysteresisState` / `advanceHysteresis` /
 * `__resetHysteresisForTests`) mirrors the diagnostics cache: production code
 * carries one shared machine; tests reset it deterministically.
 *
 * Mirrors the `now`/DI seam style of `network-diagnostics.ts`.
 */

import type { NetworkDiagnosis } from "~/lib/net/network-diagnostics"

/** A failure must persist at least this long before the banner is shown, so a
 *  transient sub-window blip never surfaces a banner. */
export const NETWORK_BANNER_ONSET_MS = 20_000

/** If a cleared outage lasted longer than this, signal a reconnect
 *  notification on recovery. A shorter blip clears silently. */
export const NOTIFY_ON_RECONNECT_MS = 30_000

/**
 * The machine's carried state. `firstFailureAt` is the epoch-ms of the first
 * failure in the current continuous outage (null when there is no active
 * outage); `active` records whether that outage was ever promoted to a shown
 * banner (so recovery can decide whether a reconnect notification is warranted).
 */
export interface HysteresisState {
  /** Epoch ms of the first failure in the current outage, or null if none. */
  firstFailureAt: number | null
  /** Whether the current outage was ever promoted to a shown banner. */
  active: boolean
}

/** The starting state — no outage, nothing shown. */
export const initialHysteresisState: HysteresisState = {
  firstFailureAt: null,
  active: false,
}

export interface HysteresisStep {
  /** The next machine state to carry forward. */
  state: HysteresisState
  /** The diagnosis to publish as the banner signal, or null to clear it.
   *  Non-null only once a failure has persisted past the onset window. */
  bannerDiagnosis: NetworkDiagnosis | null
  /** True exactly on the recovery transition of an outage that lasted longer
   *  than NOTIFY_ON_RECONNECT_MS. The caller fires the reconnect notification. */
  notifyReconnect: boolean
}

/**
 * Advance the machine one tick. Pure: no globals, injected `now`.
 *
 * - `rawDiagnosis` non-null (a failure): start (or continue) the outage window.
 *   The failure is promoted to `bannerDiagnosis` once it has persisted for
 *   `NETWORK_BANNER_ONSET_MS`; before that the banner stays cleared.
 * - `rawDiagnosis` null (ok / no failure): clear the outage. `notifyReconnect`
 *   is true iff the outage had actually been shown-or-not tracked AND its
 *   duration exceeded `NOTIFY_ON_RECONNECT_MS`.
 */
export function step(
  prevState: HysteresisState,
  rawDiagnosis: NetworkDiagnosis | null,
  now: number,
): HysteresisStep {
  if (rawDiagnosis === null) {
    // Recovery / no failure. Only fire a reconnect notification when an outage
    // was in progress AND it lasted longer than the notify threshold — a
    // sub-threshold blip clears silently. `wasActive` gates on there having
    // been a tracked outage at all (firstFailureAt set), independent of whether
    // its banner was shown, so a >30s but <20s-onset edge case still notifies.
    const wasActive = prevState.firstFailureAt !== null
    const notifyReconnect =
      wasActive
      && now - (prevState.firstFailureAt as number) > NOTIFY_ON_RECONNECT_MS
    return {
      state: initialHysteresisState,
      bannerDiagnosis: null,
      notifyReconnect,
    }
  }

  // A failure. Anchor the outage window on the FIRST failure and keep it
  // anchored across subsequent failures (a continuous outage tracks when it
  // began, not the latest verdict).
  const firstFailureAt = prevState.firstFailureAt ?? now
  const persistedForMs = now - firstFailureAt
  const shouldShow = persistedForMs >= NETWORK_BANNER_ONSET_MS

  return {
    state: { firstFailureAt, active: prevState.active || shouldShow },
    bannerDiagnosis: shouldShow ? rawDiagnosis : null,
    notifyReconnect: false,
  }
}

// ── Module-singleton holder ──────────────────────────────────────────────────
// Production carries one shared machine (the refresh loop and the connectivity
// poller both feed the same outage timeline). `advanceHysteresis` is the stateful
// wrapper over the pure `step`; tests reach the pure function directly and reset
// this holder between cases (mirrors network-diagnostics.ts's cache).

let current: HysteresisState = initialHysteresisState

/** The current carried state (read-only view for callers/tests). */
export function getHysteresisState(): HysteresisState {
  return current
}

/**
 * Feed a raw diagnosis through the shared machine and advance it, returning the
 * banner signal + reconnect flag. `now` defaults to `Date.now`; injectable for
 * deterministic tests.
 */
export function advanceHysteresis(
  rawDiagnosis: NetworkDiagnosis | null,
  now: number = Date.now(),
): HysteresisStep {
  const result = step(current, rawDiagnosis, now)
  current = result.state
  return result
}

/** Reset the shared machine. Test-only. */
export function __resetHysteresisForTests(): void {
  current = initialHysteresisState
}
