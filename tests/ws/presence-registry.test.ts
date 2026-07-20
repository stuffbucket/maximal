import { describe, expect, test } from "bun:test"

import {
  PresenceRegistry,
  type PresenceSocket,
} from "~/lib/ws/presence-registry"

/**
 * Presence registry (spec §1.2). The load-bearing assertion is the
 * identity-checked delete: a reconnecting tab's new socket must NOT be removed by
 * the old socket's late `close`. That is the mutation-test anchor — mutating the
 * `map.get(id) === ws` guard must make a test here fail.
 */

/** A fake socket that records what it was sent (no Bun ServerWebSocket needed). */
function fakeSocket(): PresenceSocket & {
  sent: Array<string>
  closed: boolean
} {
  const state = { sent: [] as Array<string>, closed: false }
  return {
    ...state,
    send(data: string) {
      state.sent.push(data)
    },
    close() {
      state.closed = true
    },
  }
}

describe("PresenceRegistry — active now", () => {
  test("starts empty", () => {
    expect(new PresenceRegistry().size).toBe(0)
  })
})

describe("PresenceRegistry behavior — unskip when implemented", () => {
  test("register then snapshot reflects the tab", () => {
    const reg = new PresenceRegistry()
    reg.register("a", fakeSocket(), { visibility: "visible", focused: true })
    expect(reg.snapshot()).toEqual([
      { tabId: "a", visibility: "visible", focused: true },
    ])
    expect(reg.size).toBe(1)
  })

  test("identity-checked remove: old socket's late close does NOT evict a reconnected tab", () => {
    const reg = new PresenceRegistry()
    const oldSock = fakeSocket()
    const newSock = fakeSocket()
    reg.register("a", oldSock, { visibility: "visible", focused: true }) // first connection
    reg.register("a", newSock, { visibility: "visible", focused: true }) // reconnect supersedes
    expect(reg.remove("a", oldSock)).toBe(false) // stale close is a no-op
    expect(reg.size).toBe(1)
    expect(reg.socketFor("a")).toBe(newSock)
  })

  test("remove with the current socket evicts", () => {
    const reg = new PresenceRegistry()
    const sock = fakeSocket()
    reg.register("a", sock, { visibility: "hidden", focused: false })
    expect(reg.remove("a", sock)).toBe(true)
    expect(reg.size).toBe(0)
  })

  test("remove on an unknown tab is a no-op returning false (never throws)", () => {
    const reg = new PresenceRegistry()
    expect(reg.remove("ghost", fakeSocket())).toBe(false)
    expect(reg.size).toBe(0)
  })

  test("socketFor on an unknown tab returns undefined (never throws)", () => {
    expect(new PresenceRegistry().socketFor("ghost")).toBeUndefined()
  })

  test("updateVisibility changes what the snapshot reports", () => {
    const reg = new PresenceRegistry()
    reg.register("a", fakeSocket(), { visibility: "hidden", focused: false })
    reg.updateVisibility("a", { visibility: "visible", focused: true })
    expect(reg.snapshot()).toEqual([
      { tabId: "a", visibility: "visible", focused: true },
    ])
    // A visible AND focused tab now flips the tray decision to noop.
    expect(reg.trayDecision()).toEqual({ kind: "noop" })
  })

  test("updateVisibility to visible-but-unfocused keeps the reopen decision", () => {
    const reg = new PresenceRegistry()
    reg.register("a", fakeSocket(), { visibility: "hidden", focused: false })
    // Becoming "visible" alone (browser still backgrounded) must NOT noop.
    reg.updateVisibility("a", { visibility: "visible", focused: false })
    expect(reg.trayDecision()).toEqual({
      kind: "close-then-open",
      closeTabIds: ["a"],
    })
  })

  test("updateVisibility on an unknown tab is a silent no-op (never throws)", () => {
    const reg = new PresenceRegistry()
    reg.updateVisibility("ghost", { visibility: "visible", focused: true })
    expect(reg.size).toBe(0)
  })

  test("broadcast fans out to every connected tab", () => {
    const reg = new PresenceRegistry()
    const s1 = fakeSocket()
    const s2 = fakeSocket()
    reg.register("a", s1, { visibility: "visible", focused: true })
    reg.register("b", s2, { visibility: "hidden", focused: false })
    reg.broadcast({ type: "ping" })
    expect(s1.sent).toHaveLength(1)
    expect(s2.sent).toHaveLength(1)
  })

  test("trayDecision delegates to decideTrayOpen over the snapshot", () => {
    const reg = new PresenceRegistry()
    reg.register("a", fakeSocket(), { visibility: "hidden", focused: false })
    expect(reg.trayDecision()).toEqual({
      kind: "close-then-open",
      closeTabIds: ["a"],
    })
  })
})
