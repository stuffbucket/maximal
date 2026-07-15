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

describe.skip("PresenceRegistry behavior — unskip when implemented", () => {
  test("register then snapshot reflects the tab", () => {
    const reg = new PresenceRegistry()
    reg.register("a", fakeSocket(), "visible")
    expect(reg.snapshot()).toEqual([{ tabId: "a", visibility: "visible" }])
    expect(reg.size).toBe(1)
  })

  test("identity-checked remove: old socket's late close does NOT evict a reconnected tab", () => {
    const reg = new PresenceRegistry()
    const oldSock = fakeSocket()
    const newSock = fakeSocket()
    reg.register("a", oldSock, "visible") // first connection
    reg.register("a", newSock, "visible") // reconnect supersedes
    expect(reg.remove("a", oldSock)).toBe(false) // stale close is a no-op
    expect(reg.size).toBe(1)
    expect(reg.socketFor("a")).toBe(newSock)
  })

  test("remove with the current socket evicts", () => {
    const reg = new PresenceRegistry()
    const sock = fakeSocket()
    reg.register("a", sock, "hidden")
    expect(reg.remove("a", sock)).toBe(true)
    expect(reg.size).toBe(0)
  })

  test("broadcast fans out to every connected tab", () => {
    const reg = new PresenceRegistry()
    const s1 = fakeSocket()
    const s2 = fakeSocket()
    reg.register("a", s1, "visible")
    reg.register("b", s2, "hidden")
    reg.broadcast({ type: "ping" })
    expect(s1.sent).toHaveLength(1)
    expect(s2.sent).toHaveLength(1)
  })

  test("trayDecision delegates to decideTrayOpen over the snapshot", () => {
    const reg = new PresenceRegistry()
    reg.register("a", fakeSocket(), "hidden")
    expect(reg.trayDecision()).toEqual({
      kind: "close-then-open",
      closeTabIds: ["a"],
    })
  })
})
