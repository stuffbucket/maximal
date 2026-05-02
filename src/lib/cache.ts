/**
 * Tiny LRU-ish cache with named registration + hit/miss metrics.
 *
 * Every cache in the proxy should declare scope, bound, and be
 * observable. This is the wrapper that makes that uniform.
 *
 * Eviction strategy: insertion-order (Map iteration). On set, if the
 * cache is at capacity, the oldest entry is evicted first. Touching
 * an existing key (set or get) refreshes its position so it becomes
 * the most-recently-used. `delete`/`set` to refresh and `keys().next()`
 * to evict are both O(1) on V8's Map.
 *
 * Not designed for high concurrency — there's no locking. Single
 * event-loop access only, which fits the proxy's threading model.
 */

export interface CacheMetrics {
  name: string
  size: number
  max: number
  hits: number
  misses: number
  evictions: number
}

export interface CacheOpts {
  name: string
  max: number
  /** When `true` the cache is excluded from the global registry —
   *  appropriate for per-request scope where one entry in
   *  /_debug/state is plenty (the live request's would dominate the
   *  view). Use `aggregateMetrics()` to publish summary stats
   *  separately if needed. */
  transient?: boolean
}

const cacheRegistry = new Set<Cache<unknown, unknown>>()

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
      cacheRegistry.add(this as Cache<unknown, unknown>)
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

  metrics(): CacheMetrics {
    return {
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
    cacheRegistry.delete(this as Cache<unknown, unknown>)
  }
}

/** Snapshot of every registered cache, for /_debug/state and
 *  `copilot-api debug`. */
export function allCacheMetrics(): Array<CacheMetrics> {
  return [...cacheRegistry].map((c) => c.metrics())
}
