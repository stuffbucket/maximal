import type {
  ConnectorLaneLimits,
  ConnectorLimits,
} from "@stuffbucket/maximal-plugin-sdk"

/** The retry policy of one connector, fully resolved. */
export interface RetryPolicy {
  /** Attempts in total, the first included. */
  attempts: number
  /** Fallback waits when the server gives no `Retry-After` (the last repeats). */
  fallbackDelaysMs: ReadonlyArray<number>
  /** Equal jitter on fallback waits (0.25 ⇒ ×0.75–1.25). */
  jitter: number
  /** Longest single wait; a longer `Retry-After` fails fast. */
  maxWaitMs: number
  /** Queueing plus backoff per call. */
  budgetMs: number
  retryWritesOn429: boolean
}

/** Every rate-limiting number a connector uses, defaults filled in. */
export interface ResolvedLimits {
  maxConcurrency: number
  minConcurrency: number
  /** Per-lane caps; a lane without `maxConcurrency` is bounded by the global cap only. */
  lanes: Readonly<Record<string, ConnectorLaneLimits>>
  maxQueue: number
  queueTimeoutMs: number
  retry: RetryPolicy
  fetchBatchSize: number
  progressIntervalMs: number
}

/**
 * Defaults. Concurrency 4 matches Outlook's documented four concurrent
 * requests per app and mailbox; 5 attempts at 2/4/8/16 s is agent-kit's
 * policy; a 30 s single wait keeps an interactive caller responsive (a
 * longer `Retry-After` is reported, not waited for).
 */
export const DEFAULT_LIMITS: ResolvedLimits = {
  maxConcurrency: 4,
  minConcurrency: 1,
  lanes: {},
  maxQueue: 32,
  queueTimeoutMs: 30_000,
  retry: {
    attempts: 5,
    fallbackDelaysMs: [2000, 4000, 8000, 16_000],
    jitter: 0.25,
    maxWaitMs: 30_000,
    budgetMs: 120_000,
    retryWritesOn429: true,
  },
  fetchBatchSize: 20,
  progressIntervalMs: 1000,
}

/** agent-kit policy: 5 attempts in total, waiting 2, 4, 8 and 16 s between them. */
export const DEFAULT_RETRY_DELAYS_MS: ReadonlyArray<number> =
  DEFAULT_LIMITS.retry.fallbackDelaysMs

function defined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>
}

function positiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}

/**
 * Defaults ← manifest `connector.limits` ← option `limits` (lanes and retry
 * merge per key). `retryDelaysMs` (the older option) sets the fallback
 * waits and, unless `retry.attempts` is given, the attempts (one more than
 * the waits).
 */
export function resolveLimits(
  layers: ReadonlyArray<ConnectorLimits | undefined>,
  retryDelaysMs?: ReadonlyArray<number>,
): ResolvedLimits {
  let out: ResolvedLimits = DEFAULT_LIMITS
  let attemptsSet = false
  for (const layer of layers) {
    if (!layer) continue
    const lanes: Record<string, ConnectorLaneLimits> = { ...out.lanes }
    for (const [name, lane] of Object.entries(layer.lanes ?? {}))
      lanes[name] = { ...lanes[name], ...defined(lane) }
    if (layer.retry?.attempts !== undefined) attemptsSet = true
    const { lanes: _lanes, retry: _retry, ...numbers } = layer
    out = {
      ...out,
      ...defined(numbers),
      lanes,
      retry: { ...out.retry, ...defined(layer.retry) },
    }
  }
  if (retryDelaysMs && retryDelaysMs.length > 0) {
    out = {
      ...out,
      retry: {
        ...out.retry,
        fallbackDelaysMs: [...retryDelaysMs],
        ...(attemptsSet ? {} : { attempts: retryDelaysMs.length + 1 }),
      },
    }
  }
  const maxConcurrency = positiveInt(out.maxConcurrency, 1)
  return {
    ...out,
    maxConcurrency,
    minConcurrency: Math.min(
      maxConcurrency,
      positiveInt(out.minConcurrency, 1),
    ),
    retry: {
      ...out.retry,
      attempts: positiveInt(out.retry.attempts, 1),
      fallbackDelaysMs:
        out.retry.fallbackDelaysMs.length > 0 ?
          out.retry.fallbackDelaysMs
        : [0],
    },
  }
}
