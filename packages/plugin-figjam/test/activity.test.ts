/**
 * Tool use through the FigJam bridge reaches the plugin's status as
 * `activity`: counts, times and the tool's name, never the call's input.
 */
import { loadPlugin, waitFor } from "@stuffbucket/maximal-plugin-sdk/testing"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createFigjamPlugin, FIGMA_PLUGIN_DIR } from "../src/index"
import { pairActionIds, toPluginActivity } from "../src/status"

const NOW = 1_800_000_000_000

describe("toPluginActivity", () => {
  const idle = {
    inFlight: 0,
    startedAtMs: null,
    lastActivityAtMs: null,
    lastTool: null,
  }

  test("is absent before any call", () => {
    expect(toPluginActivity(idle, NOW)).toBeUndefined()
  })

  test("reports a running call with its start and tool name", () => {
    expect(
      toPluginActivity(
        {
          inFlight: 2,
          startedAtMs: NOW - 3000,
          lastActivityAtMs: NOW - 1000,
          lastTool: "get_board",
        },
        NOW,
      ),
    ).toEqual({
      activeCalls: 2,
      startedAtMs: NOW - 3000,
      lastActivityAtMs: NOW - 1000,
      lastTool: "get_board",
    })
  })

  test("keeps a call that just ended, and drops an old one", () => {
    const ended = {
      ...idle,
      lastActivityAtMs: NOW - 5000,
      lastTool: "find_nodes",
    }
    expect(toPluginActivity(ended, NOW)).toEqual({
      activeCalls: 0,
      startedAtMs: null,
      lastActivityAtMs: NOW - 5000,
      lastTool: "find_nodes",
    })
    expect(
      toPluginActivity({ ...ended, lastActivityAtMs: NOW - 61_000 }, NOW),
    ).toBeUndefined()
  })

  test("strips control characters from the tool name", () => {
    const activity = toPluginActivity(
      { ...idle, lastActivityAtMs: NOW, lastTool: "get\nboard" },
      NOW,
    )
    expect(activity?.lastTool).toBe("get board")
  })
})

describe("FigJam plugin: tool activity", () => {
  let root: string
  let port: number
  const cleanups: Array<() => Promise<void> | void> = []

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "figjam-plugin-activity-"))
    const probe = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    })
    ;({ port } = probe)
    probe.stop(true)
  })

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    await rm(root, { recursive: true, force: true })
  })

  test("a running call shows in the status with its tool name, and lingers after it ends", async () => {
    const dataDir = path.join(root, "data")
    // The bridge keeps an admin token that is already on disk, so the test
    // picks its own instead of reading the generated one back.
    const token = "activity-test-admin-token"
    await mkdir(path.join(dataDir, "figjam"), { recursive: true })
    await writeFile(
      path.join(dataDir, "figjam", "pairing-token"),
      `${token}\n`,
      {
        mode: 0o600,
      },
    )
    const loaded = await loadPlugin(
      createFigjamPlugin({ dataDir }),
      { port },
      { storageDir: path.join(root, "plugins") },
    )
    cleanups.push(() => loaded.dispose())
    await waitFor(() => loaded.status()?.code === "plugin-not-built")
    await loaded.runAction("setup")
    await waitFor(() => loaded.status()?.code === "ready")
    expect(loaded.status()?.activity).toBeUndefined()

    // The panel Maximal wrote carries the key the bridge demands.
    const html = await readFile(
      path.join(root, "plugins", "figjam", FIGMA_PLUGIN_DIR, "ui.html"),
      "utf8",
    )
    const { relayKey } = JSON.parse(
      /^const PANEL_BUILD = (.*);$/m.exec(html)?.[1] ?? "{}",
    ) as { relayKey: string }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`, [relayKey])
    cleanups.push(() => ws.close())
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          session: "activity-lynx",
          board: { name: "Roadmap", boardId: "act1", fileKey: "kact1" },
          plugin: { version: "test" },
          tools: [],
        }),
      )
    })
    const toolIds: Array<string> = []
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string
        id?: string
      }
      if (message.type === "tool" && message.id) toolIds.push(message.id)
    })
    const { approveId } = pairActionIds("activity-lynx")
    await waitFor(() => loaded.actions().includes(approveId))
    await loaded.runAction(approveId)
    await waitFor(
      () =>
        loaded.status()?.facts?.some((fact) => fact.value === "Roadmap")
        === true,
    )

    const call = fetch(`http://127.0.0.1:${port}/tool`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: "get_board",
        input: { note: "do-not-keep-this" },
      }),
    })
    await waitFor(() => loaded.status()?.activity?.activeCalls === 1)
    const running = loaded.status()?.activity
    expect(running?.lastTool).toBe("get_board")
    expect(running?.startedAtMs).toBeNumber()
    expect(JSON.stringify(loaded.status())).not.toContain("do-not-keep-this")

    ws.send(
      JSON.stringify({
        type: "tool-result",
        id: toolIds[0],
        ok: true,
        result: {},
      }),
    )
    expect((await call).status).toBe(200)
    await waitFor(() => loaded.status()?.activity?.activeCalls === 0)
    expect(loaded.status()?.activity).toMatchObject({
      activeCalls: 0,
      startedAtMs: null,
      lastTool: "get_board",
    })
  })
})
