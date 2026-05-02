import { describe, expect, it } from "bun:test"

import { allCacheMetrics, Cache, SingletonCache } from "~/lib/cache"

describe("Cache", () => {
  it("get returns undefined and increments misses for absent keys", () => {
    const c = new Cache<string, number>({ name: "t1", max: 5, transient: true })
    expect(c.get("absent")).toBeUndefined()
    expect(c.metrics().misses).toBe(1)
    expect(c.metrics().hits).toBe(0)
  })

  it("set/get round-trips and increments hits", () => {
    const c = new Cache<string, number>({ name: "t2", max: 5, transient: true })
    c.set("k", 42)
    expect(c.get("k")).toBe(42)
    expect(c.metrics().hits).toBe(1)
    expect(c.metrics().size).toBe(1)
  })

  it("evicts oldest entry when at capacity", () => {
    const c = new Cache<string, number>({ name: "t3", max: 2, transient: true })
    c.set("a", 1)
    c.set("b", 2)
    c.set("c", 3) // evicts "a"
    expect(c.get("a")).toBeUndefined()
    expect(c.get("b")).toBe(2)
    expect(c.get("c")).toBe(3)
    expect(c.metrics().evictions).toBe(1)
    expect(c.metrics().size).toBe(2)
  })

  it("touching an existing key refreshes its recency (LRU semantics)", () => {
    const c = new Cache<string, number>({ name: "t4", max: 2, transient: true })
    c.set("a", 1)
    c.set("b", 2)
    // Touch "a" so it becomes most-recent — next insert should evict "b".
    c.get("a")
    c.set("c", 3)
    expect(c.get("a")).toBe(1)
    expect(c.get("b")).toBeUndefined()
    expect(c.get("c")).toBe(3)
  })

  it("setting an existing key updates value and does not evict", () => {
    const c = new Cache<string, number>({ name: "t5", max: 2, transient: true })
    c.set("a", 1)
    c.set("b", 2)
    c.set("a", 99) // overwrite, not insert
    expect(c.get("a")).toBe(99)
    expect(c.metrics().evictions).toBe(0)
    expect(c.metrics().size).toBe(2)
  })

  it("clear empties the store but does not zero metrics", () => {
    const c = new Cache<string, number>({ name: "t6", max: 5, transient: true })
    c.set("a", 1)
    c.get("a")
    c.clear()
    expect(c.metrics().size).toBe(0)
    expect(c.metrics().hits).toBe(1)
  })

  it("transient caches are excluded from allCacheMetrics()", () => {
    const before = allCacheMetrics().length
    const t = new Cache<string, number>({
      name: "transient-1",
      max: 5,
      transient: true,
    })
    t.set("x", 1)
    const after = allCacheMetrics().length
    expect(after).toBe(before)
  })

  it("non-transient caches register in allCacheMetrics()", () => {
    const c = new Cache<string, number>({ name: "registered-1", max: 5 })
    c.set("x", 1)
    const found = allCacheMetrics().find((m) => m.name === "registered-1")
    expect(found?.size).toBe(1)
    c.unregister()
  })

  it("Cache.metrics() reports kind: 'lru'", () => {
    const c = new Cache<string, number>({ name: "kind-1", max: 1 })
    expect(c.metrics().kind).toBe("lru")
    c.unregister()
  })
})

describe("SingletonCache", () => {
  it("starts empty: get() undefined, size 0, refreshes 0, loaded_at_ms null", () => {
    const s = new SingletonCache<number>({ name: "s-empty" })
    expect(s.get()).toBeUndefined()
    expect(s.has()).toBe(false)
    const m = s.metrics()
    expect(m.kind).toBe("singleton")
    expect(m.size).toBe(0)
    expect(m.refreshes).toBe(0)
    expect(m.loaded_at_ms).toBeNull()
    s.unregister()
  })

  it("set stores value, increments refreshes, stamps loaded_at_ms", () => {
    let now = 1_000_000
    const s = new SingletonCache<number>({
      name: "s-set",
      now: () => now,
    })
    s.set(42)
    expect(s.get()).toBe(42)
    expect(s.has()).toBe(true)
    let m = s.metrics()
    expect(m.size).toBe(1)
    expect(m.refreshes).toBe(1)
    expect(m.loaded_at_ms).toBe(1_000_000)

    now = 2_000_000
    s.set(99)
    m = s.metrics()
    expect(s.get()).toBe(99)
    expect(m.refreshes).toBe(2)
    expect(m.loaded_at_ms).toBe(2_000_000)
    s.unregister()
  })

  it("clear empties the value and resets loaded_at_ms but keeps refresh counter", () => {
    const s = new SingletonCache<number>({ name: "s-clear" })
    s.set(1)
    s.clear()
    const m = s.metrics()
    expect(s.get()).toBeUndefined()
    expect(m.size).toBe(0)
    expect(m.loaded_at_ms).toBeNull()
    expect(m.refreshes).toBe(1)
    s.unregister()
  })

  it("registers in allCacheMetrics() and is removable via unregister()", () => {
    const s = new SingletonCache<number>({ name: "s-registered" })
    s.set(1)
    const found = allCacheMetrics().find((m) => m.name === "s-registered")
    expect(found?.kind).toBe("singleton")
    s.unregister()
    const after = allCacheMetrics().find((m) => m.name === "s-registered")
    expect(after).toBeUndefined()
  })
})
