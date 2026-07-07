/**
 * Observable in-process caches with named registration and metrics.
 *
 * Every cache in the proxy should declare scope and be visible in
 * `/_debug/state`. Two shapes today:
 *
 * - `Cache<K, V>` — keyed LRU with capacity, hits/misses, evictions.
 *   Used for per-request prefetch caches and other multi-entry stores.
 * - `SingletonCache<V>` — a single tracked value. Used for
 *   `state.models` and `state.copilotToken` where the interesting
 *   signal is "when was it last refreshed" and "how many refreshes
 *   has it seen", not hit-rate (every reader hits a singleton if it
 *   has been loaded). Hits/misses are not tracked because they map
 *   ~1:1 to request count and would only add noise.
 *
 * Both register in the same global so `allCacheMetrics()` is the
 * single read point. The metrics shape is a discriminated union on
 * `kind` — consumers that just want to render JSON don't have to
 * branch.
 *
 * Not designed for high concurrency — there's no locking. Single
 * event-loop access only, which fits the proxy's threading model.
 */

export interface LruCacheMetrics {
  kind: "lru"
  name: string
  size: number
  max: number
  hits: number
  misses: number
  evictions: number
}

export interface SingletonCacheMetrics {
  kind: "singleton"
  name: string
  size: 0 | 1
  refreshes: number
  loaded_at_ms: number | null
}

export type CacheMetrics = LruCacheMetrics | SingletonCacheMetrics

interface Observable {
  metrics: () => CacheMetrics
}

export interface CacheOpts {
  name: string
  max: number
  /** When `true` the cache is excluded from the global registry —
   *  appropriate for per-request scope where one entry in
   *  /_debug/state is plenty (the live request's would dominate the
   *  view). */
  transient?: boolean
}

const cacheRegistry = new Set<Observable>()

export class Cache<K, V> {
  readonly name: string
  readonly max: number
  private readonly store = new Map<K, V>()
  private hits = 0
  private misses = 0
  private evictions = 0

  constructor(opts: CacheOpts) {
    this.name = opts.name
    this.max = opts.max
    if (!opts.transient) {
      cacheRegistry.add(this)
    }
  }

  get(key: K): V | undefined {
    const value = this.store.get(key)
    if (value === undefined) {
      this.misses++
      return undefined
    }
    // Refresh recency by re-inserting — Map keeps insertion order so
    // delete+set moves the entry to the back.
    this.store.delete(key)
    this.store.set(key, value)
    this.hits++
    return value
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) {
      // Touching an existing key — refresh recency, no eviction.
      this.store.delete(key)
      this.store.set(key, value)
      return
    }
    if (this.store.size >= this.max) {
      // Evict the oldest (first-inserted) entry.
      const firstKey = this.store.keys().next().value
      if (firstKey !== undefined) {
        this.store.delete(firstKey)
        this.evictions++
      }
    }
    this.store.set(key, value)
  }

  has(key: K): boolean {
    return this.store.has(key)
  }

  clear(): void {
    this.store.clear()
  }

  get size(): number {
    return this.store.size
  }

  metrics(): LruCacheMetrics {
    return {
      kind: "lru",
      name: this.name,
      size: this.store.size,
      max: this.max,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    }
  }

  /** Disconnect this instance from the global registry. Use for
   *  per-request caches that should not show up in long-lived
   *  introspection. */
  unregister(): void {
    cacheRegistry.delete(this)
  }
}

export interface SingletonCacheOpts {
  name: string
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Tracks a single value plus when it was last set and how many times
 * it has been refreshed. Reads are uncounted by design — see header.
 *
 * Typical use:
 *
 *   const tokenCache = new SingletonCache<string>({ name: "copilot_token" })
 *   tokenCache.set(token)         // refresh — bumps counter, stamps time
 *   const tok = tokenCache.get()  // returns string | undefined
 */
export class SingletonCache<V> {
  readonly name: string
  private readonly clock: () => number
  private value: V | undefined = undefined
  private refreshes = 0
  private loadedAtMs: number | null = null

  constructor(opts: SingletonCacheOpts) {
    this.name = opts.name
    this.clock = opts.now ?? Date.now
    cacheRegistry.add(this)
  }

  get(): V | undefined {
    return this.value
  }

  set(value: V): void {
    this.value = value
    this.refreshes++
    this.loadedAtMs = this.clock()
  }

  has(): boolean {
    return this.value !== undefined
  }

  clear(): void {
    this.value = undefined
    this.loadedAtMs = null
  }

  metrics(): SingletonCacheMetrics {
    return {
      kind: "singleton",
      name: this.name,
      size: this.value === undefined ? 0 : 1,
      refreshes: this.refreshes,
      loaded_at_ms: this.loadedAtMs,
    }
  }

  unregister(): void {
    cacheRegistry.delete(this)
  }
}

/** Snapshot of every registered cache, for /_debug/state and
 *  `maximal debug`. */
export function allCacheMetrics(): Array<CacheMetrics> {
  return [...cacheRegistry].map((c) => c.metrics())
}
