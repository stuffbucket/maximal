// Tool use through the bridge is reported as counts, times and the tool's
// name, never its input: events on start and end, and `status().activity`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { BridgeEvent, BridgeHandle } from "../src/server"

import { startBridge } from "../src/server"

let dir: string
let handle: BridgeHandle
let ws: WebSocket
let token: string
const events: Array<BridgeEvent> = []
/** Tool messages the fake panel received, each answered by `release`. */
const received: Array<{ id: string; name: string }> = []
const answers = new Map<string, () => void>()

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10)
  expect(check()).toBe(true)
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "figjam-bridge-activity-"))
  handle = await startBridge({
    port: 0,
    dataDir: dir,
    onEvent: (event) => {
      events.push(event)
    },
  })
  ws = new WebSocket(`ws://127.0.0.1:${handle.port}/plugin`)
  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        session: "activity-panel",
        board: { name: "Activity board", boardId: "act1", fileKey: "kact1" },
        plugin: { version: "test" },
        tools: [],
      }),
    )
  })
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      type: string
      id?: string
      name?: string
    }
    if (message.type !== "tool" || !message.id || !message.name) return
    const { id, name } = message
    received.push({ id, name })
    answers.set(id, () =>
      ws.send(
        JSON.stringify({ type: "tool-result", id, ok: true, result: {} }),
      ),
    )
  })
  token = (
    await readFile(path.join(dir, "figjam", "pairing-token"), "utf8")
  ).trim()
  await until(() => handle.status().pending.length === 1)
  await handle.approve("activity-panel")
  await until(() => handle.status().boards.length === 1)
})

afterAll(async () => {
  ws.close()
  await handle.stop()
  await rm(dir, { recursive: true, force: true })
})

describe("bridge tool activity", () => {
  test("starts with none", () => {
    expect(handle.status().activity).toEqual({
      inFlight: 0,
      startedAtMs: null,
      lastActivityAtMs: null,
      lastTool: null,
    })
  })

  test("a call in flight is counted with its name, and its input is not kept", async () => {
    const call = fetch(`http://127.0.0.1:${handle.port}/tool`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: "get_board",
        input: { note: "do-not-keep-this" },
      }),
    })
    await until(() => received.length === 1)
    const running = handle.status().activity
    expect(running.inFlight).toBe(1)
    expect(running.lastTool).toBe("get_board")
    expect(running.startedAtMs).toBeNumber()
    expect(JSON.stringify(running)).not.toContain("do-not-keep-this")
    expect(events).toContainEqual({
      type: "tool-started",
      name: "get_board",
      board: "activity-panel",
    })

    answers.get(received[0].id)?.()
    expect((await call).status).toBe(200)
    const done = handle.status().activity
    expect(done).toMatchObject({
      inFlight: 0,
      startedAtMs: null,
      lastTool: "get_board",
    })
    expect(done.lastActivityAtMs).toBeGreaterThanOrEqual(
      running.startedAtMs ?? 0,
    )
    expect(events).toContainEqual({
      type: "tool-finished",
      name: "get_board",
      board: "activity-panel",
    })
  })

  test("a tool name is bounded", async () => {
    const long = `get_${"x".repeat(200)}`
    const call = fetch(`http://127.0.0.1:${handle.port}/tool`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: long, input: {} }),
    })
    await until(() => received.length === 2)
    expect(handle.status().activity.lastTool).toHaveLength(80)
    answers.get(received[1].id)?.()
    await call
  })
})
