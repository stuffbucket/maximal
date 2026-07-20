import type { ServerWebSocket } from "bun"

import { describe, expect, test } from "bun:test"

import type { LiveFeedSnapshot } from "~/lib/ws/feed-types"

import { LiveFeedHub } from "~/lib/ws/live-feed"
import { PresenceRegistry } from "~/lib/ws/presence-registry"
import {
  createWebSocketHandler,
  parseClientMessage,
  type WsData,
} from "~/routes/ws/route"

/**
 * WS handler orchestration (spec §1.2–1.3): the Bun socket callbacks translate
 * hello/visibility/pong frames into presence-registry mutations and send the
 * complete snapshot on connect. Tested with fake sockets + a real registry and a
 * real LiveFeedHub whose snapshot builder is injected (no subsystem wiring needed).
 */

/** A fake ServerWebSocket recording what it was sent / whether it was closed. */
function fakeWs(data: WsData) {
  const ws = {
    data,
    sent: [] as Array<string>,
    closed: false,
    send(payload: string) {
      ws.sent.push(payload)
    },
    close() {
      ws.closed = true
    },
  }
  return ws
}

type FakeWs = ReturnType<typeof fakeWs>

/** Cast a fake to the handler's expected socket type (structural match). */
function asServerWs(ws: FakeWs): ServerWebSocket<WsData> {
  return ws as unknown as ServerWebSocket<WsData>
}

/** A sentinel snapshot — only identity matters for "was it forwarded?". */
const SENTINEL_SNAPSHOT = { health: "healthy" } as unknown as LiveFeedSnapshot

function makeHandler() {
  const registry = new PresenceRegistry()
  const hub = new LiveFeedHub({
    registry,
    buildSnapshot: () => Promise.resolve(SENTINEL_SNAPSHOT),
  })
  return { registry, handler: createWebSocketHandler({ hub, registry }) }
}

/** Flush the microtask + macrotask queue so the fire-and-forget snapshot lands. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("parseClientMessage", () => {
  test("returns null on malformed JSON (never throws)", () => {
    expect(parseClientMessage("not json")).toBeNull()
  })

  test("returns null on an unknown frame type", () => {
    expect(parseClientMessage(JSON.stringify({ type: "nope" }))).toBeNull()
  })

  test("hello requires both tabId and visibility; focused defaults to false", () => {
    expect(parseClientMessage(JSON.stringify({ type: "hello" }))).toBeNull()
    expect(
      parseClientMessage(JSON.stringify({ type: "hello", tabId: "a" })),
    ).toBeNull()
    expect(
      parseClientMessage(
        JSON.stringify({ type: "hello", tabId: "a", visibility: "visible" }),
      ),
    ).toEqual({
      type: "hello",
      tabId: "a",
      visibility: "visible",
      focused: false,
    })
  })

  test("focused rides hello and visibility frames when present", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "hello",
          tabId: "a",
          visibility: "visible",
          focused: true,
        }),
      ),
    ).toEqual({
      type: "hello",
      tabId: "a",
      visibility: "visible",
      focused: true,
    })
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "visibility",
          visibility: "visible",
          focused: true,
        }),
      ),
    ).toEqual({ type: "visibility", visibility: "visible", focused: true })
  })

  test("a non-boolean focused is coerced to false (only literal true counts)", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "hello",
          tabId: "a",
          visibility: "visible",
          focused: "yes",
        }),
      ),
    ).toEqual({
      type: "hello",
      tabId: "a",
      visibility: "visible",
      focused: false,
    })
  })

  test("pong parses with no payload", () => {
    expect(parseClientMessage(JSON.stringify({ type: "pong" }))).toEqual({
      type: "pong",
    })
  })
})

describe("createWebSocketHandler — open", () => {
  test("an unauthed socket is closed and gets no snapshot", async () => {
    const { handler } = makeHandler()
    const ws = fakeWs({ authed: false, tabId: null })
    handler.open(asServerWs(ws))
    await flush()
    expect(ws.closed).toBe(true)
    expect(ws.sent).toHaveLength(0)
  })

  test("an authed socket is sent the complete snapshot on connect", async () => {
    const { handler } = makeHandler()
    const ws = fakeWs({ authed: true, tabId: null })
    handler.open(asServerWs(ws))
    await flush()
    expect(ws.closed).toBe(false)
    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toEqual({
      type: "snapshot",
      snapshot: { health: "healthy" },
    })
  })
})

describe("createWebSocketHandler — message", () => {
  test("hello registers the tab and stamps the socket's tabId", () => {
    const { registry, handler } = makeHandler()
    const ws = fakeWs({ authed: true, tabId: null })
    handler.message(
      asServerWs(ws),
      JSON.stringify({
        type: "hello",
        tabId: "a",
        visibility: "visible",
        focused: true,
      }),
    )
    expect(ws.data.tabId).toBe("a")
    expect(registry.snapshot()).toEqual([
      { tabId: "a", visibility: "visible", focused: true },
    ])
  })

  test("an unknown visibility string is treated as buried (hidden)", () => {
    const { registry, handler } = makeHandler()
    const ws = fakeWs({ authed: true, tabId: null })
    handler.message(
      asServerWs(ws),
      JSON.stringify({ type: "hello", tabId: "a", visibility: "bogus" }),
    )
    expect(registry.snapshot()).toEqual([
      { tabId: "a", visibility: "hidden", focused: false },
    ])
  })

  test("visibility before hello is a no-op (no tabId yet)", () => {
    const { registry, handler } = makeHandler()
    const ws = fakeWs({ authed: true, tabId: null })
    handler.message(
      asServerWs(ws),
      JSON.stringify({ type: "visibility", visibility: "hidden" }),
    )
    expect(registry.size).toBe(0)
  })

  test("visibility after hello updates presence (visibility + focus)", () => {
    const { registry, handler } = makeHandler()
    const ws = fakeWs({ authed: true, tabId: null })
    const wire = asServerWs(ws)
    handler.message(
      wire,
      JSON.stringify({ type: "hello", tabId: "a", visibility: "hidden" }),
    )
    handler.message(
      wire,
      JSON.stringify({
        type: "visibility",
        visibility: "visible",
        focused: true,
      }),
    )
    expect(registry.snapshot()).toEqual([
      { tabId: "a", visibility: "visible", focused: true },
    ])
  })

  test("a Buffer frame is decoded, and malformed input is ignored", () => {
    const { registry, handler } = makeHandler()
    const ws = fakeWs({ authed: true, tabId: null })
    handler.message(asServerWs(ws), Buffer.from("not json"))
    handler.message(
      asServerWs(ws),
      Buffer.from(
        JSON.stringify({ type: "hello", tabId: "b", visibility: "visible" }),
      ),
    )
    expect(registry.snapshot()).toEqual([
      { tabId: "b", visibility: "visible", focused: false },
    ])
  })
})

describe("createWebSocketHandler — close", () => {
  test("close after hello evicts the tab", () => {
    const { registry, handler } = makeHandler()
    const ws = fakeWs({ authed: true, tabId: null })
    const wire = asServerWs(ws)
    handler.message(
      wire,
      JSON.stringify({ type: "hello", tabId: "a", visibility: "visible" }),
    )
    handler.close(wire)
    expect(registry.size).toBe(0)
  })

  test("a stale socket's close does NOT evict a reconnected tab (identity guard)", () => {
    const { registry, handler } = makeHandler()
    const oldWs = fakeWs({ authed: true, tabId: null })
    const newWs = fakeWs({ authed: true, tabId: null })
    const helloA = JSON.stringify({
      type: "hello",
      tabId: "a",
      visibility: "visible",
    })
    handler.message(asServerWs(oldWs), helloA) // first connection
    handler.message(asServerWs(newWs), helloA) // reconnect supersedes
    handler.close(asServerWs(oldWs)) // late close from the dead socket
    expect(registry.size).toBe(1)
    expect(registry.socketFor("a")).toBe(asServerWs(newWs))
  })

  test("close before any hello is a silent no-op", () => {
    const { registry, handler } = makeHandler()
    const ws = fakeWs({ authed: true, tabId: null })
    handler.close(asServerWs(ws))
    expect(registry.size).toBe(0)
  })
})
