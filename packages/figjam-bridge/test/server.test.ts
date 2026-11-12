// The bridge as a library: start it in-process on a free port with a throwaway
// data directory, drive a fake panel over WebSocket, and watch onEvent/status.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { BridgeEvent, BridgeHandle } from "../src/server"

import { startBridge } from "../src/server"

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

function openPanel(port: number, name: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`)
  const seen: Array<string> = []
  const waiters: Array<{ type: string; resolve: () => void }> = []
  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        session: name,
        board: { name: "Lib board", boardId: "lib1", fileKey: "klib1" },
        plugin: { version: "test" },
        tools: [],
      }),
    )
  })
  ws.addEventListener("message", (event) => {
    const type = (JSON.parse(String(event.data)) as { type: string }).type
    seen.push(type)
    for (const w of waiters.filter((x) => x.type === type)) w.resolve()
  })
  const next = (type: string): Promise<void> =>
    seen.includes(type) ?
      Promise.resolve()
    : new Promise((resolve) => waiters.push({ type, resolve }))
  return { ws, next }
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
    for (let i = 0; i < 100 && handle.status().boards.length > 0; i++)
      await Bun.sleep(20)
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

  test("forget revokes a paired client", () => {
    const [client] = handle.status().clients
    expect(handle.forget(client.id)).toBe(true)
    expect(handle.forget(client.id)).toBe(false)
    expect(handle.status().clients).toEqual([])
  })

  test("stop frees the port", async () => {
    const { port } = handle
    await handle.stop()
    expect(
      await failure(fetch(`http://127.0.0.1:${port}/status`)),
    ).toBeDefined()
    const again = await startBridge({ port, dataDir: dir })
    expect(again.port).toBe(port)
    await again.stop()
    // afterAll calls stop() on the first handle, which is a no-op by now.
  })
})
