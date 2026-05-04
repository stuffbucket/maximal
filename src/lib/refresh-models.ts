/**
 * Activity-driven lazy refresh of the Copilot models cache (L1a).
 *
 * `cacheModels()` runs once at startup. Without this, the cached
 * `state.models` value persists for the lifetime of the process — a
 * proxy left running for days will keep using its boot-time view of
 * the models list, which is wrong when Copilot adds/removes a model
 * mid-week.
 *
 * Strategy: on each request, check whether the SingletonCache's
 * `loaded_at_ms` is older than `STALE_AFTER_MS ± JITTER_MS`. If so,
 * fire `cacheModels()` in the background and proceed. The triggering
 * request gets the (slightly stale) cache; the next request gets
 * fresh. Stale-while-revalidate, no timer, no daemon, idle proxy
 * does no work.
 *
 * Spec: docs/spec/model-protocol-strategy.md, "Layer 1 — Detection".
 */

import type { Context, Next } from "hono"

import { createHash } from "node:crypto"

import { state } from "./state"

export const STALE_AFTER_MS = 6 * 60 * 60 * 1000 // 6 hours
export const JITTER_MS = 2 * 60 * 60 * 1000 // 2 hour total spread (±1 hour)

/** Per-process jitter offset in `[-JITTER_MS/2, +JITTER_MS/2)` —
 *  i.e. ±1 hour around the 6-hour staleness baseline, so the
 *  effective refresh window is roughly [5h, 7h]. Keyed on
 *  macMachineId so two proxies on different machines drift to
 *  different refresh minutes deterministically; same machine, same
 *  proxy invocation gets the same jitter every time (good — staleness
 *  is monotonically predictable). Falls back to 0 when macMachineId
 *  isn't populated yet (pre-cacheMacMachineId at startup). */
function jitterFor(machineId: string | undefined): number {
  if (!machineId) return 0
  const hash = createHash("sha256").update(machineId).digest()
  // Read first 4 bytes as unsigned int, map into [0, JITTER_MS), then
  // shift to center on zero.
  const raw = hash.readUInt32BE(0)
  return (raw % JITTER_MS) - JITTER_MS / 2
}

export interface IsStaleArgs {
  now: number
  loadedAtMs: number | null
  staleAfterMs: number
  jitterMs: number
}

/** Pure staleness predicate. Returns false when the cache hasn't
 *  been primed yet (startup not finished); never want to fire a
 *  refresh before the initial fetch. */
export function isStale(args: IsStaleArgs): boolean {
  if (args.loadedAtMs === null) return false
  return args.now > args.loadedAtMs + args.staleAfterMs + args.jitterMs
}

// ────────────────────────────────────────────────────────────────────
// Single-flight orchestrator. Module-level state is appropriate here
// because there's only ever one models cache per process.
// ────────────────────────────────────────────────────────────────────

let refreshInFlight = false

export interface RefreshOpts {
  /** Reads the models cache's last-load timestamp. */
  getLoadedAtMs: () => number | null
  /** Performs the actual refresh. Should call `setModels` on success. */
  refresh: () => Promise<void>
  /** Source of `now` for tests. */
  now?: () => number
  /** Override the jitter source for tests. Defaults to a hash of
   *  `state.macMachineId`. */
  jitterMs?: number
  /** Override the staleness threshold for tests. */
  staleAfterMs?: number
  /** Optional structured logger. Failures keep the stale cache; we
   *  log so the operator can see retry attempts. */
  onError?: (err: unknown) => void
}

/** Fires a refresh in the background when the cache is past its
 *  staleness window. Single-flight guard prevents two concurrent
 *  triggering requests from each starting one. Returns `"fired"` if
 *  it kicked off a refresh, otherwise the reason it didn't.
 *
 *  Always non-blocking — the returned promise resolves as soon as
 *  the decision is made; the actual refresh runs to completion in
 *  the background. */
export function refreshIfStale(
  opts: RefreshOpts,
): "fired" | "fresh" | "in_flight" | "not_primed" {
  const now = (opts.now ?? Date.now)()
  const loadedAtMs = opts.getLoadedAtMs()
  const jitterMs = opts.jitterMs ?? jitterFor(state.macMachineId)
  const staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS

  if (loadedAtMs === null) return "not_primed"
  if (refreshInFlight) return "in_flight"
  if (!isStale({ now, loadedAtMs, staleAfterMs, jitterMs })) return "fresh"

  refreshInFlight = true
  // Fire-and-forget. The triggering request continues with the
  // slightly stale cache; the next request after this resolves sees
  // the refresh.
  void opts
    .refresh()
    .catch((err: unknown) => opts.onError?.(err))
    .finally(() => {
      refreshInFlight = false
    })
  return "fired"
}

/** Reset the single-flight guard. Tests only — production never
 *  needs this. */
export function _resetRefreshInFlightForTests(): void {
  refreshInFlight = false
}

// ────────────────────────────────────────────────────────────────────
// Hono middleware. Runs after auth so it doesn't fire for "/" probes
// or the unauthenticated debug page; only real API traffic counts as
// activity for refresh purposes.
// ────────────────────────────────────────────────────────────────────

export interface MiddlewareDeps {
  getLoadedAtMs: () => number | null
  refresh: () => Promise<void>
  onError?: (err: unknown) => void
}

export function staleRefreshMiddleware(deps: MiddlewareDeps) {
  return async (_c: Context, next: Next): Promise<void> => {
    refreshIfStale({
      getLoadedAtMs: deps.getLoadedAtMs,
      refresh: deps.refresh,
      onError: deps.onError,
    })
    await next()
  }
}
