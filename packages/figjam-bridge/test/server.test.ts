// The bridge as a library: start it in-process on a free port with a throwaway
// data directory, drive a fake panel over WebSocket, and watch onEvent/status.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { BridgeEvent, BridgeHandle } from "../src/server"

import { createRelayKey, startBridge } from "../src/server"

let dir: string
let handle: BridgeHandle
const events: Array<BridgeEvent> = []

async function failure(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  return undefined
}

interface PanelOptions {
  /** Subprotocols to offer; default: the bridge's relay key, as the panel does. */
  protocols?: Array<string>
  /** Default `null`: the Figma plugin iframe's opaque origin. */
  origin?: string
  token?: string
  boardId?: string
}

interface Message {
  type: string
  token?: string
  clientId?: string
}

function openPanel(port: number, name: string, options: PanelOptions = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`, {
    protocols: options.protocols ?? [handle.relayKey],
    headers: { origin: options.origin ?? "null" },
  })
  const seen: Array<Message> = []
  const waiters: Array<{ type: string; resolve: (m: Message) => void }> = []
  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        session: name,
        board: {
          name: "Lib board",
          boardId: options.boardId ?? "lib1",
          fileKey: "klib1",
        },
        plugin: { version: "test" },
        tools: [],
        ...(options.token === undefined ? {} : { token: options.token }),
      }),
    )
  })
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message
    seen.push(message)
    for (const w of waiters.filter((x) => x.type === message.type))
      w.resolve(message)
  })
  // Settles when the socket opens (true) or fails/closes first (false).
  const opened = new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true))
    ws.addEventListener("error", () => resolve(false))
    ws.addEventListener("close", () => resolve(false))
  })
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (event) => resolve(event.code))
  })
  const next = (type: string): Promise<Message> => {
    const found = seen.find((m) => m.type === type)
    return found ?
        Promise.resolve(found)
      : new Promise((resolve) => waiters.push({ type, resolve }))
  }
  return { ws, seen, opened, closed, next }
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(20)
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "figjam-bridge-lib-"))
  handle = await startBridge({
    port: 0,
    dataDir: dir,
    onEvent: (e) => {
      events.push(e)
    },
  })
})

afterAll(async () => {
  await handle.stop()
  await rm(dir, { recursive: true, force: true })
})

describe("startBridge", () => {
  test("listens on a free port and starts empty", () => {
    expect(handle.port).toBeGreaterThan(0)
    const status = handle.status()
    expect(status.port).toBe(handle.port)
    expect(status.boards).toEqual([])
    expect(status.pending).toEqual([])
  })

  test("a second bridge can't start in the same process", async () => {
    const error = await failure(startBridge({ port: 0, dataDir: dir }))
    expect(error?.message).toContain("already running")
  })

  test("pair, approve, connect and disconnect are reported", async () => {
    const panel = openPanel(handle.port, "lib-lynx")
    await panel.next("pair-pending")
    expect(events).toContainEqual({
      type: "pair-requested",
      name: "lib-lynx",
      board: "Lib board",
    })
    expect(handle.status().pending.map((p) => p.name)).toEqual(["lib-lynx"])

    const result = await handle.approve("lib-lynx")
    expect(result.ok).toBe(true)
    await panel.next("paired")
    const paired = events.find((e) => e.type === "paired")
    expect(paired).toMatchObject({ type: "paired", name: "lib-lynx" })
    expect(events).toContainEqual({
      type: "board-connected",
      name: "lib-lynx",
      board: "Lib board",
    })

    const status = handle.status()
    expect(status.pending).toEqual([])
    expect(status.boards.map((b) => b.id)).toEqual(["lib-lynx"])
    expect(status.clients).toHaveLength(1)

    panel.ws.close()
    await waitUntil(() => handle.status().boards.length === 0)
    expect(events).toContainEqual({
      type: "board-disconnected",
      name: "lib-lynx",
      board: "Lib board",
    })
  })

  test("deny emits pair-denied and closes the panel", async () => {
    const panel = openPanel(handle.port, "lib-koala")
    await panel.next("pair-pending")
    const result = await handle.deny("lib-koala")
    expect(result.ok).toBe(true)
    expect(events).toContainEqual({ type: "pair-denied", name: "lib-koala" })
  })

  test("approving a name nobody sent reports a 404", async () => {
    const result = await handle.approve("nobody")
    expect(result).toMatchObject({ ok: false, status: 404 })
  })

  test("forget revokes a paired client", async () => {
    const [client] = handle.status().clients
    expect(await handle.forget(client.id)).toBe(true)
    expect(await handle.forget(client.id)).toBe(false)
    expect(handle.status().clients).toEqual([])
  })
})

describe("relay key", () => {
  test("each bridge gets a fresh 32-byte key, kept out of status", () => {
    expect(handle.relayKey).toMatch(/^[\w-]{43}$/)
    expect(createRelayKey()).not.toBe(handle.relayKey)
    expect(JSON.stringify(handle.status())).not.toContain(handle.relayKey)
  })

  test("the HTTP API never answers with the key", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/status`)
    expect(await res.text()).not.toContain(handle.relayKey)
  })

  test("a forged Origin: null socket can't open, so no request is pending", async () => {
    const before = events.length
    const forged = [
      openPanel(handle.port, "forged-none", { protocols: [] }),
      openPanel(handle.port, "forged-wrong", {
        protocols: [createRelayKey()],
      }),
      openPanel(handle.port, "forged-short", {
        protocols: [handle.relayKey.slice(0, 42)],
      }),
      openPanel(handle.port, "forged-padded", {
        protocols: [`${handle.relayKey}x`],
      }),
    ]
    for (const panel of forged) expect(await panel.opened).toBe(false)
    await Bun.sleep(50)
    expect(handle.status().pending).toEqual([])
    expect(events.slice(before)).toEqual([])
    for (const panel of forged) expect(panel.seen).toEqual([])
  })

  test("a web page's origin is refused even with the key", async () => {
    const page = openPanel(handle.port, "page-lynx", {
      origin: "https://example.com",
    })
    expect(await page.opened).toBe(false)
    expect(handle.status().pending).toEqual([])
  })

  test("the key may sit among other offered subprotocols, and is the one selected", async () => {
    const panel = openPanel(handle.port, "multi-lynx", {
      protocols: ["chat", handle.relayKey],
      boardId: "multi",
    })
    expect(await panel.opened).toBe(true)
    expect(panel.ws.protocol).toBe(handle.relayKey)
    await panel.next("pair-pending")
    expect((await handle.deny("multi-lynx")).ok).toBe(true)
  })

  test("the keyed panel pairs, then reconnects with its token without asking again", async () => {
    const first = openPanel(handle.port, "keyed-lynx", { boardId: "keyed" })
    await first.next("pair-pending")
    expect((await handle.approve("keyed-lynx")).ok).toBe(true)
    const { token, clientId } = await first.next("paired")
    expect(token).toMatch(/^[\w-]{43}$/)
    first.ws.close()
    await waitUntil(() => handle.status().boards.length === 0)

    const before = events.length
    const again = openPanel(handle.port, "keyed-lynx", {
      boardId: "keyed",
      token,
    })
    const paired = await again.next("paired")
    expect(paired.clientId).toBe(clientId)
    expect(paired.token).toBeUndefined()
    expect(again.seen.map((m) => m.type)).not.toContain("pair-pending")
    expect(events.slice(before).map((e) => e.type)).toEqual(["board-connected"])
    again.ws.close()
    await waitUntil(() => handle.status().boards.length === 0)

    // The per-panel token doesn't stand in for the relay key.
    const tokenOnly = openPanel(handle.port, "keyed-lynx", {
      boardId: "keyed",
      token,
      protocols: [],
    })
    expect(await tokenOnly.opened).toBe(false)
    expect(handle.status().boards).toEqual([])
  })

  test("a malformed key is refused at start", async () => {
    const error = await failure(
      startBridge({ port: 0, dataDir: dir, relayKey: "short" }),
    )
    expect(error?.message).toContain("relay key")
  })

  test("a restart keeps a key it is given, and a new key shuts the old one out", async () => {
    const { port, relayKey } = handle
    await handle.stop()
    expect(
      await failure(fetch(`http://127.0.0.1:${port}/status`)),
    ).toBeDefined()

    const same = await startBridge({ port, dataDir: dir, relayKey })
    try {
      expect(same.port).toBe(port)
      const panel = openPanel(port, "same-key", {
        protocols: [relayKey],
        boardId: "same",
      })
      await panel.next("pair-pending")
      panel.ws.close()
    } finally {
      await same.stop()
    }

    const fresh = await startBridge({ port, dataDir: dir })
    try {
      expect(fresh.relayKey).not.toBe(relayKey)
      const stale = openPanel(port, "stale-key", { protocols: [relayKey] })
      expect(await stale.opened).toBe(false)
      expect(fresh.status().pending).toEqual([])
    } finally {
      await fresh.stop()
    }
    // afterAll calls stop() on the first handle, which is a no-op by now.
  })
})

function occupy() {
  return Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  })
}

describe("port selection", () => {
  test("takes the preferred port when it is free", async () => {
    const probe = occupy()
    const { port } = probe
    probe.stop(true)
    const bridge = await startBridge({ port, dataDir: dir })
    try {
      expect(bridge.port).toBe(port)
      expect(bridge.preferredPort).toBe(port)
      expect(bridge.status().preferredPort).toBe(port)
    } finally {
      await bridge.stop()
    }
  })

  test("walks upward to the next free port when the preferred one is taken", async () => {
    const blocker = occupy()
    try {
      const bridge = await startBridge({ port: blocker.port, dataDir: dir })
      try {
        expect(bridge.preferredPort).toBe(blocker.port)
        expect(bridge.port).toBeGreaterThan(blocker.port)
        expect(bridge.status().port).toBe(bridge.port)
        const res = await fetch(`http://127.0.0.1:${bridge.port}/status`)
        expect(res.ok).toBe(true)
      } finally {
        await bridge.stop()
      }
    } finally {
      blocker.stop(true)
    }
  })

  test("does not walk when portAttempts is 1, and the failure says the port is in use", async () => {
    const blocker = occupy()
    try {
      const error = await failure(
        startBridge({ port: blocker.port, portAttempts: 1, dataDir: dir }),
      )
      expect(error?.message).toMatch(/in use/i)
    } finally {
      blocker.stop(true)
    }
    // A failed start releases the process-wide slot.
    const bridge = await startBridge({ port: 0, dataDir: dir })
    await bridge.stop()
  })
})
