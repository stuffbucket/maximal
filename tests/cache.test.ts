import { describe, expect, it } from "bun:test"

import { allCacheMetrics, Cache } from "~/lib/cache"

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
})
