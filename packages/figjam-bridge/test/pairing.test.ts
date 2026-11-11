import type { Subprocess } from "bun"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Starts a real bridge on a spare port with a throwaway data directory, then
// drives it the way the panel and the CLI do: a WebSocket hello from a fake
// panel, and approve/deny over the admin HTTP API.
const PORT = 4300 + Math.floor(Math.random() * 500)
let home: string
let bridge: Subprocess
let token: string

async function waitForBridge(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/status`)
      if (res.status > 0) return
    } catch {
      // not listening yet
    }
    await Bun.sleep(50)
  }
  throw new Error("bridge did not start")
}

async function admin(
  route: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://localhost:${PORT}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  return (await res.json()) as Record<string, unknown>
}

interface FakePanel {
  messages: Array<string>
  closed: Promise<number>
  next: (type: string) => Promise<void>
}

function openPanel(name: string, boardId: string): FakePanel {
  const ws = new WebSocket(`ws://localhost:${PORT}/plugin`)
  const messages: Array<string> = []
  const waiters: Array<{ type: string; resolve: () => void }> = []
  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        session: name,
        board: { name: "Test board", boardId, fileKey: `k${boardId}` },
        plugin: { version: "test" },
        tools: [],
      }),
    )
  })
  ws.addEventListener("message", (event) => {
    const type = (JSON.parse(String(event.data)) as { type: string }).type
    messages.push(type)
    for (const w of waiters.filter((x) => x.type === type)) w.resolve()
  })
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (event) => resolve(event.code))
  })
  const next = (type: string): Promise<void> =>
    messages.includes(type) ?
      Promise.resolve()
    : new Promise((resolve) => waiters.push({ type, resolve }))
  return { messages, closed, next }
}

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "figjam-bridge-"))
  bridge = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "..", "src", "bridge.ts")],
    {
      env: {
        ...process.env,
        COPILOT_API_HOME: home,
        FIGJAM_BRIDGE_PORT: String(PORT),
        FIGJAM_PAIR_TTL_S: "2",
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  )
  await waitForBridge()
  token = (
    await readFile(path.join(home, "figjam", "pairing-token"), "utf8")
  ).trim()
})

afterAll(async () => {
  bridge.kill()
  await bridge.exited
  await rm(home, { recursive: true, force: true })
})

describe("pairing", () => {
  test("approving a name nobody sent says so", async () => {
    const out = await admin("/pair/approve", { name: "sunny-otter" })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain("sunny-otter")
  })

  test("a panel waits for approval, then pairs", async () => {
    const panel = openPanel("grumpy-lynx", "b1")
    await panel.next("pair-pending")
    const out = await admin("/pair/approve", { name: "grumpy-lynx" })
    expect(out.ok).toBe(true)
    await panel.next("paired")
  })

  test("approving an already-paired name is not an error", async () => {
    const out = await admin("/pair/approve", { name: "grumpy-lynx" })
    expect(out.ok).toBe(true)
    expect(out.alreadyPaired).toBe(true)
  })

  test("denying closes the panel's connection", async () => {
    const panel = openPanel("shy-koala", "b3")
    await panel.next("pair-pending")
    expect((await admin("/pair/deny", { name: "shy-koala" })).ok).toBe(true)
    expect(await panel.closed).toBe(4403)
  })

  test("an unauthenticated caller can't approve", async () => {
    const res = await fetch(`http://localhost:${PORT}/pair/approve`, {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
    })
    expect(res.status).toBe(401)
  })
})
