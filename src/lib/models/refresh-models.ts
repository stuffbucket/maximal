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

import consola from "consola"
import { createHash } from "node:crypto"

import { cacheModels } from "~/lib/platform/utils"
import { modelsCached, state } from "~/lib/runtime-state/state"

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

// ────────────────────────────────────────────────────────────────────
// On-demand prime for an EMPTY / never-primed cache.
//
// The stale-while-revalidate path below deliberately declines an unprimed
// cache (`loadedAtMs === null` → the initial fetch hasn't happened), so if a
// transient boot / token-mint failure left the catalog empty, live traffic
// would never repopulate it. This helper is the on-demand recovery: WARN on
// failure and keep serving whatever we have (an empty catalog is non-fatal —
// completion handlers read `state.models?.data ?? []`), and log a recovery
// NOTE when an empty cache repopulates. It never throws.
// ────────────────────────────────────────────────────────────────────

/** Minimal logger shape the prime path needs — satisfied by `consola` and by
 *  a plain `{ info, warn }` in tests. */
export interface PrimeLogger {
  info: (message: string, ...args: Array<unknown>) => void
  warn: (message: string, ...args: Array<unknown>) => void
}

/** Prime the models cache, best-effort. Warns on failure (keeps the
 *  last-known catalog, possibly empty) and logs an info note when an empty
 *  cache transitions to populated. Never throws — a models refresh is not a
 *  hard dependency of serving traffic. */
export async function primeModelsCache(
  refresh: () => Promise<void> = cacheModels,
  log: PrimeLogger = consola,
): Promise<void> {
  const wasEmpty = modelsCached() === 0
  try {
    await refresh()
  } catch (err) {
    log.warn(
      "Models cache prime failed; serving the last-known (possibly empty) catalog. Will retry on the next model-list request or activity.",
      err,
    )
    return
  }
  if (wasEmpty && modelsCached() > 0) {
    log.info(`Models cache recovered: ${modelsCached()} models now available.`)
  }
}

// Single-flight + cooldown for the empty-cache prime. Separate from the stale
// path's `refreshInFlight` (the two states are mutually exclusive — an unprimed
// cache never reaches the stale check). The cooldown is a plain-arithmetic
// compare against the injectable `now()`, NOT a timer, so a persistent outage
// doesn't re-hit the endpoint on every request while staying deterministic in
// tests (no real delays, nothing an afterEach must stop).
let primeInFlight = false
let lastPrimeAttemptMs: number | null = null
export const PRIME_COOLDOWN_MS = 60_000

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
):
  | "fired"
  | "fresh"
  | "in_flight"
  | "priming"
  | "prime_in_flight"
  | "prime_cooldown" {
  const now = (opts.now ?? Date.now)()
  const loadedAtMs = opts.getLoadedAtMs()
  const jitterMs = opts.jitterMs ?? jitterFor(state.macMachineId)
  const staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS

  if (loadedAtMs === null) {
    // Never primed — a transient boot / token-mint failure left the catalog
    // empty. The stale-while-revalidate path only revalidates an ALREADY-primed
    // cache, so without this an empty catalog would never self-heal on live
    // traffic. Fire a bounded, single-flight prime: same fire-and-forget,
    // timer-free shape as the stale path, plus a plain-arithmetic cooldown so a
    // persistent outage doesn't re-hit the endpoint on every request.
    if (primeInFlight) return "prime_in_flight"
    if (
      lastPrimeAttemptMs !== null
      && now < lastPrimeAttemptMs + PRIME_COOLDOWN_MS
    ) {
      return "prime_cooldown"
    }
    lastPrimeAttemptMs = now
    primeInFlight = true
    // primeModelsCache owns the warn/recover logging and never throws.
    void primeModelsCache(opts.refresh).finally(() => {
      primeInFlight = false
    })
    return "priming"
  }
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

/** Reset the on-demand prime single-flight guard + cooldown. Tests only. */
export function _resetPrimeStateForTests(): void {
  primeInFlight = false
  lastPrimeAttemptMs = null
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
