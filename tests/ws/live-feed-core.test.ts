import { describe, expect, test } from "bun:test"

import {
  TAB_ID_STORAGE_KEY,
  computeBackoffMs,
  getTabId,
  liveFeedUrl,
  parseServerMessage,
  serializeClientMessage,
  type StorageLike,
} from "../../shell/src/proxy/live-feed-core"

/**
 * DOM-free live-feed client core (spec §1.2–1.3). The stable tab-id (presence key),
 * the port-derived URL (§1.1 — never a hardcoded 4141), reconnect backoff, and
 * frame parse/serialize are all unit-testable here. Skipped until bodies land.
 */

function fakeStorage(
  initial: Record<string, string> = {},
): StorageLike & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v
    },
  }
}

/** A counting id-minter (`tab-1`, `tab-2`, …) for asserting mint-once behavior. */
function countingMinter(): () => string {
  let n = 0
  return () => `tab-${(n += 1)}`
}

/** A minter that fails the test if called — proves an existing id is reused. */
function throwingMinter(): string {
  throw new Error("should not mint")
}

describe("live-feed core — unskip when implemented", () => {
  test("getTabId mints once and is stable across calls", () => {
    const storage = fakeStorage()
    const mint = countingMinter()
    const first = getTabId(storage, mint)
    const second = getTabId(storage, mint)
    expect(first).toBe("tab-1")
    expect(second).toBe("tab-1") // reused, not re-minted
    expect(storage.data[TAB_ID_STORAGE_KEY]).toBe("tab-1")
  })

  test("getTabId reuses an existing stored id without minting", () => {
    const storage = fakeStorage({ [TAB_ID_STORAGE_KEY]: "existing" })
    expect(getTabId(storage, throwingMinter)).toBe("existing")
  })

  test("liveFeedUrl derives from the inlined bound port and token (not 4141)", () => {
    expect(liveFeedUrl(4242, "tok")).toBe("ws://localhost:4242/ws?key=tok")
  })

  test("computeBackoffMs is bounded and monotonic-ish", () => {
    expect(computeBackoffMs(0)).toBeGreaterThan(0)
    expect(computeBackoffMs(10)).toBeGreaterThanOrEqual(computeBackoffMs(1))
    expect(computeBackoffMs(100)).toBeLessThanOrEqual(30_000) // bounded ceiling
  })

  test("parseServerMessage returns null on malformed input (never throws)", () => {
    expect(parseServerMessage("not json")).toBeNull()
    expect(parseServerMessage(JSON.stringify({ type: "ping" }))).toEqual({
      type: "ping",
    })
  })

  test("serializeClientMessage round-trips a hello frame", () => {
    const frame = serializeClientMessage({
      type: "hello",
      tabId: "a",
      visibility: "visible",
      focused: true,
    })
    expect(JSON.parse(frame)).toEqual({
      type: "hello",
      tabId: "a",
      visibility: "visible",
      focused: true,
    })
  })
})
