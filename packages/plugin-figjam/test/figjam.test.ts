/**
 * The FigJam plugin against the real bridge: a fake panel connects over
 * WebSocket the way the Figma plugin does, on a spare port with a temporary
 * data directory (never the real one, never port 4150).
 */
import { loadPlugin, waitFor } from "@stuffbucket/maximal-plugin-sdk/testing"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  createFigjamPlugin,
  FIGMA_PLUGIN_DIR,
  IMPORT_INSTRUCTIONS,
} from "../src/index"

type Loaded = Awaited<ReturnType<typeof loadPlugin>>

let root: string
let dataDir: string
let storageDir: string
let port: number
const cleanups: Array<() => Promise<void> | void> = []

function freePort(): number {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  })
  const { port: free } = probe
  probe.stop(true)
  return free
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "figjam-plugin-"))
  dataDir = path.join(root, "data")
  storageDir = path.join(root, "plugins")
  port = freePort()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await rm(root, { recursive: true, force: true })
})

async function load(config: Record<string, unknown> = {}): Promise<Loaded> {
  const loaded = await loadPlugin(
    createFigjamPlugin({ dataDir }),
    { port, ...config },
    { storageDir },
  )
  cleanups.push(() => loaded.dispose())
  return loaded
}

const status = (loaded: Loaded) => loaded.status()
const fact = (loaded: Loaded, label: string) =>
  status(loaded)?.facts?.find((item) => item.label === label)?.value
const actionIds = (loaded: Loaded) =>
  (status(loaded)?.actions ?? []).map((action) => action.id)
const statusIs = (loaded: Loaded, code: string) => () =>
  status(loaded)?.code === code

async function portIsFree(candidate: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${candidate}/status`)
    return false
  } catch {
    return true
  }
}

interface Panel {
  ws: WebSocket
  next(type: string): Promise<void>
}

function openPanel(name: string): Panel {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`)
  const seen: Array<string> = []
  const waiters: Array<{ type: string; resolve: () => void }> = []
  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        session: name,
        board: { name: "Roadmap", boardId: "plugin1", fileKey: "kplugin1" },
        plugin: { version: "test" },
        tools: [],
      }),
    )
  })
  ws.addEventListener("message", (event) => {
    const type = (JSON.parse(String(event.data)) as { type: string }).type
    seen.push(type)
    for (const waiter of waiters.filter((item) => item.type === type))
      waiter.resolve()
  })
  cleanups.push(() => ws.close())
  return {
    ws,
    next: (type) =>
      seen.includes(type) ?
        Promise.resolve()
      : new Promise((resolve) => waiters.push({ type, resolve })),
  }
}

describe("FigJam plugin: setup", () => {
  test("needs setup until the Figma plugin is built, then shows the manifest", async () => {
    const loaded = await load()
    await waitFor(statusIs(loaded, "plugin-not-built"))
    expect(status(loaded)).toMatchObject({
      state: "needs-setup",
      actions: [{ id: "setup", label: "Set up the Figma plugin" }],
    })
    expect(fact(loaded, "Port")).toBe(String(port))

    await loaded.runAction("setup")
    await waitFor(statusIs(loaded, "ready"))
    const manifestPath = path.join(
      storageDir,
      "figjam",
      FIGMA_PLUGIN_DIR,
      "manifest.json",
    )
    expect(fact(loaded, "Figma plugin manifest")).toBe(manifestPath)
    expect(status(loaded)?.detail).toBe(IMPORT_INSTRUCTIONS)
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      networkAccess: { devAllowedDomains: Array<string> }
    }
    expect(manifest.networkAccess.devAllowedDomains).toContain(
      `ws://localhost:${port}`,
    )
  })

  test("rebuilds on start when the folder is stale", async () => {
    const first = await load()
    await waitFor(statusIs(first, "plugin-not-built"))
    await first.runAction("setup")
    await waitFor(statusIs(first, "ready"))
    await first.dispose()
    await waitFor(() => portIsFree(port))

    const codePath = path.join(
      storageDir,
      "figjam",
      FIGMA_PLUGIN_DIR,
      "code.js",
    )
    const current = await readFile(codePath, "utf8")
    const stale = current.replace(
      /^var PLUGIN_VERSION = ".*"$/m,
      'var PLUGIN_VERSION = "0.0.1"',
    )
    expect(stale).not.toBe(current)
    await writeFile(codePath, stale)

    const second = await load()
    await waitFor(statusIs(second, "ready"))
    expect(await readFile(codePath, "utf8")).toBe(current)
  })
})

describe("FigJam plugin: pairing", () => {
  test("a panel asks, the notice and actions appear, approving pairs it", async () => {
    const loaded = await load()
    await waitFor(statusIs(loaded, "plugin-not-built"))
    await loaded.runAction("setup")
    await waitFor(statusIs(loaded, "ready"))

    const panel = openPanel("test-lynx")
    await panel.next("pair-pending")
    await waitFor(() =>
      actionIds(loaded).some((id) => id.startsWith("approve")),
    )

    const notices = loaded.testbed.events.filter(
      (event) => event.type === "notice",
    )
    expect(notices.map((event) => event.notice)).toEqual([
      {
        code: "figjam-pair-requested",
        message: 'A FigJam panel ("test-lynx") wants to connect.',
        params: { name: "test-lynx" },
      },
    ])
    expect(fact(loaded, "Waiting for approval")).toBe("test-lynx")
    expect(status(loaded)?.actions?.map((action) => action.label)).toContain(
      'Approve "test-lynx"',
    )
    expect(status(loaded)?.actions?.map((action) => action.label)).toContain(
      'Deny "test-lynx"',
    )

    const approve = actionIds(loaded).find((id) => id.startsWith("approve"))
    if (approve === undefined) throw new Error("no approve action")
    await loaded.runAction(approve)
    await panel.next("paired")
    await waitFor(() => fact(loaded, "Connected boards") === "Roadmap")
    expect(fact(loaded, "Waiting for approval")).toBe("None")
    expect(actionIds(loaded)).toEqual(["setup"])
    expect(loaded.actions().filter((id) => id !== "setup")).not.toContain(
      approve,
    )
  })

  test("denying clears the request and its actions", async () => {
    const loaded = await load()
    await waitFor(statusIs(loaded, "plugin-not-built"))

    const panel = openPanel("test-koala")
    await panel.next("pair-pending")
    await waitFor(() => actionIds(loaded).some((id) => id.startsWith("deny")))
    const deny = actionIds(loaded).find((id) => id.startsWith("deny"))
    if (deny === undefined) throw new Error("no deny action")
    await loaded.runAction(deny)
    await waitFor(() => fact(loaded, "Waiting for approval") === "None")
    expect(actionIds(loaded)).toEqual(["setup"])
    expect(loaded.actions()).not.toContain(deny)
  })
})

describe("FigJam plugin: the port", () => {
  test("stopping the plugin frees the port", async () => {
    const loaded = await load()
    await waitFor(statusIs(loaded, "plugin-not-built"))
    expect(await portIsFree(port)).toBe(false)
    await loaded.dispose()
    await waitFor(() => portIsFree(port))
  })

  test("a taken port is an error, and Try again works once it is free", async () => {
    const blocker = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    })
    cleanups.push(() => {
      blocker.stop(true)
    })
    const loaded = await load()
    await waitFor(statusIs(loaded, "port-in-use"))
    expect(status(loaded)).toMatchObject({
      state: "error",
      summary: `Port ${port} is already in use`,
      actions: [{ id: "retry", label: "Try again" }],
    })

    blocker.stop(true)
    await loaded.runAction("retry")
    await waitFor(statusIs(loaded, "plugin-not-built"))
    expect(existsSync(path.join(dataDir, "figjam"))).toBe(true)
  })
})
