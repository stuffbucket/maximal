/**
 * Core attention sources: what the app itself asks for, beside the plugins'.
 */

import { afterEach, describe, expect, test } from "bun:test"

import {
  coreAttention,
  registerCoreAttentionSource,
  runCoreAttentionAction,
} from "~/lib/attention"

const item = (plugin: string, summary: string) => ({
  plugin,
  name: plugin.toUpperCase(),
  summary,
  actions: [{ id: "go", label: "Go" }],
})

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

describe("core attention sources", () => {
  test("lists every source's items in the order they registered", () => {
    disposers.push(
      registerCoreAttentionSource({
        id: "first",
        items: () => [item("first", "a"), item("first", "b")],
        run: () => true,
      }),
      registerCoreAttentionSource({
        id: "second",
        items: () => [item("second", "c")],
        run: () => true,
      }),
    )
    expect(coreAttention().map((entry) => entry.summary)).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  test("reads a source's items each time", () => {
    let items = [item("live", "one")]
    disposers.push(
      registerCoreAttentionSource({
        id: "live",
        items: () => items,
        run: () => true,
      }),
    )
    expect(coreAttention()).toHaveLength(1)
    items = []
    expect(coreAttention()).toEqual([])
  })

  test("runs an action on its own source, and says whether it named anything", () => {
    const ran: Array<string> = []
    disposers.push(
      registerCoreAttentionSource({
        id: "mine",
        items: () => [],
        run: (action) => {
          ran.push(action)
          return action === "known"
        },
      }),
    )
    expect(runCoreAttentionAction("mine", "known")).toBe(true)
    expect(runCoreAttentionAction("mine", "stale")).toBe(false)
    expect(ran).toEqual(["known", "stale"])
  })

  test("an id that isn't a source is left to the plugins", () => {
    expect(runCoreAttentionAction("figjam", "approve")).toBeUndefined()
  })

  test("registering again replaces the source; its disposer removes only itself", () => {
    const old = registerCoreAttentionSource({
      id: "dup",
      items: () => [item("dup", "old")],
      run: () => true,
    })
    const next = registerCoreAttentionSource({
      id: "dup",
      items: () => [item("dup", "new")],
      run: () => true,
    })
    disposers.push(next)
    expect(coreAttention().map((entry) => entry.summary)).toEqual(["new"])

    // The replaced source's disposer no longer reaches the new one.
    old()
    expect(coreAttention()).toHaveLength(1)
    next()
    expect(coreAttention()).toEqual([])
    expect(runCoreAttentionAction("dup", "go")).toBeUndefined()
  })
})
