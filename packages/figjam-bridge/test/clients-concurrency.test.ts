import type { Subprocess } from "bun"

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

interface PanelMessage {
  type: string
  token?: string
  clientId?: string
}

function freePort(): number {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  })
  const { port } = probe
  probe.stop(true)
  return port
}

/** Each standalone bridge's relay key, read from the panel it wrote. */
const relayKeys = new Map<number, string>()

async function waitForBridge(port: number, pluginDir: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (
        (await fetch(`http://127.0.0.1:${port}/status`)).ok
        && existsSync(path.join(pluginDir, "ui.html"))
      )
        return
    } catch {
      // It has not bound yet.
    }
    await Bun.sleep(20)
  }
  throw new Error(`bridge on ${port} did not start`)
}

async function startBridge(dataDir: string, port: number): Promise<Subprocess> {
  const pluginDir = path.join(dataDir, `plugin-${port}`)
  const bridge = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "..", "src", "bridge.ts")],
    {
      env: {
        ...process.env,
        COPILOT_API_HOME: dataDir,
        FIGJAM_BRIDGE_PORT: String(port),
        FIGJAM_PLUGIN_OUT: pluginDir,
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  )
  await waitForBridge(port, pluginDir)
  const html = await readFile(path.join(pluginDir, "ui.html"), "utf8")
  const line = /^const PANEL_BUILD = (.*);$/m.exec(html)
  if (!line) throw new Error("no PANEL_BUILD line in ui.html")
  relayKeys.set(port, (JSON.parse(line[1]) as { relayKey: string }).relayKey)
  return bridge
}

function openPanel(port: number, name: string, token?: string) {
  const key = relayKeys.get(port)
  if (key === undefined)
    throw new Error(`no relay key for the bridge on ${port}`)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`, [key])
  const messages: Array<PanelMessage> = []
  const waiters = new Map<string, Array<(message: PanelMessage) => void>>()
  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        session: name,
        token,
        board: { name: `${name} board`, boardId: name, fileKey: `k-${name}` },
        plugin: { version: "test" },
        tools: [],
      }),
    )
  })
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as PanelMessage
    messages.push(message)
    for (const resolve of waiters.get(message.type) ?? []) resolve(message)
    waiters.delete(message.type)
  })
  const next = (type: string): Promise<PanelMessage> => {
    const seen = messages.find((message) => message.type === type)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve) => {
      waiters.set(type, [...(waiters.get(type) ?? []), resolve])
    })
  }
  return { ws, next }
}

async function admin(
  port: number,
  token: string,
  request: { route: string; body: unknown },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${request.route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request.body),
  })
}

interface ClientsFile {
  clients: Array<{ id: string; lastSeen: string }>
}

async function readClients(file: string): Promise<ClientsFile> {
  return JSON.parse(await readFile(file, "utf8")) as ClientsFile
}

async function stop(bridge: Subprocess): Promise<void> {
  bridge.kill()
  await bridge.exited
}

describe("shared clients.json", () => {
  test("serializes approvals, forgets, lastSeen updates, and stale lock recovery", async () => {
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "figjam-shared-clients-"),
    )
    const portA = freePort()
    const portB = freePort()
    const processes: Array<Subprocess> = []
    const sockets: Array<WebSocket> = []
    try {
      const bridgeA = await startBridge(dataDir, portA)
      processes.push(bridgeA)
      const adminToken = (
        await readFile(path.join(dataDir, "figjam", "pairing-token"), "utf8")
      ).trim()
      const seed = openPanel(portA, "seed")
      sockets.push(seed.ws)
      await seed.next("pair-pending")
      expect(
        (
          await admin(portA, adminToken, {
            route: "/pair/approve",
            body: { name: "seed" },
          })
        ).ok,
      ).toBe(true)
      const seedPaired = await seed.next("paired")
      if (!seedPaired.token || !seedPaired.clientId)
        throw new Error("seed pairing did not return credentials")
      seed.ws.close()

      const bridgeB = await startBridge(dataDir, portB)
      processes.push(bridgeB)
      const panelA = openPanel(portA, "panel-a")
      const panelB = openPanel(portB, "panel-b")
      sockets.push(panelA.ws, panelB.ws)
      await Promise.all([
        panelA.next("pair-pending"),
        panelB.next("pair-pending"),
      ])
      const [approvedA, approvedB] = await Promise.all([
        admin(portA, adminToken, {
          route: "/pair/approve",
          body: { name: "panel-a" },
        }),
        admin(portB, adminToken, {
          route: "/pair/approve",
          body: { name: "panel-b" },
        }),
      ])
      expect(approvedA.ok).toBe(true)
      expect(approvedB.ok).toBe(true)
      const [pairedA, pairedB] = await Promise.all([
        panelA.next("paired"),
        panelB.next("paired"),
      ])
      if (!pairedA.clientId || !pairedB.clientId)
        throw new Error("concurrent pairing did not return client ids")
      const clientsFile = path.join(dataDir, "figjam", "clients.json")
      const storedIds = (await readClients(clientsFile)).clients.map(
        (client) => client.id,
      )
      expect(storedIds).toHaveLength(3)
      expect(storedIds).toContain(seedPaired.clientId)
      expect(storedIds).toContain(pairedA.clientId)
      expect(storedIds).toContain(pairedB.clientId)

      const future = new Date(Date.now() + 60_000).toISOString()
      const futureClients = await readClients(clientsFile)
      futureClients.clients = futureClients.clients.map((client) =>
        client.id === seedPaired.clientId ?
          { ...client, lastSeen: future }
        : client,
      )
      await writeFile(
        clientsFile,
        `${JSON.stringify(futureClients, null, 2)}\n`,
        { mode: 0o600 },
      )
      const seenAgain = openPanel(portA, "seed-again", seedPaired.token)
      sockets.push(seenAgain.ws)
      await seenAgain.next("paired")
      expect(
        (await readClients(clientsFile)).clients.find(
          (client) => client.id === seedPaired.clientId,
        )?.lastSeen,
      ).toBe(future)
      seenAgain.ws.close()

      expect(
        (
          await admin(portA, adminToken, {
            route: "/pair/forget",
            body: { clientId: seedPaired.clientId },
          })
        ).ok,
      ).toBe(true)
      const forgotten = openPanel(portB, "forgotten", seedPaired.token)
      sockets.push(forgotten.ws)
      await forgotten.next("pair-pending")
      expect(
        (await readClients(clientsFile)).clients.some(
          (client) => client.id === seedPaired.clientId,
        ),
      ).toBe(false)
      forgotten.ws.close()

      const lock = `${clientsFile}.lock`
      await mkdir(lock)
      await writeFile(
        path.join(lock, "owner.json"),
        `${JSON.stringify({
          pid: 2_147_483_647,
          token: "d".repeat(32),
          createdAtMs: Date.now() - 60_000,
        })}\n`,
        { mode: 0o600 },
      )
      const afterCrash = openPanel(portA, "after-crash")
      sockets.push(afterCrash.ws)
      await afterCrash.next("pair-pending")
      expect(
        (
          await admin(portA, adminToken, {
            route: "/pair/approve",
            body: { name: "after-crash" },
          })
        ).ok,
      ).toBe(true)
      await afterCrash.next("paired")
      expect(
        (await readdir(path.dirname(lock))).some((name) =>
          name.startsWith("clients.json.lock.stale-"),
        ),
      ).toBe(true)
    } finally {
      for (const socket of sockets) socket.close()
      for (const bridge of processes.reverse()) await stop(bridge)
      await rm(dataDir, { recursive: true, force: true })
    }
  }, 20_000)
})
