/**
 * The connectors bench end to end, in-process: the real Work IQ connector
 * (fake upstream, instant fake sign-in) composed into the real app, driven
 * through the Settings API and a real MCP client — the same scripted
 * session `bun run bench:connectors --drive` runs against `runServer`.
 */

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { writeConfig } from "~/lib/config/config"
import { startPlugins, stopPlugins } from "~/lib/plugins/runtime"
import { setListeningPort } from "~/lib/start/proxy-port"
import { pluginMcpRoutes } from "~/routes/plugins/mcp"
import { server } from "~/server"

import {
  type BenchEntitlement,
  type ConnectorsBench,
  driveConnectorsBench,
  formatChecks,
  type StartBenchServer,
  startConnectorsBench,
} from "../scripts/bench/connectors-bench"
import { serveApp } from "./helpers/plugins"

/** Serve the app on a loopback port and boot the plugin runtime with the
 *  bench's gateway (what `runServer({ pluginGateway })` does after binding). */
const startInProcess: StartBenchServer = async (gateway) => {
  const app = await serveApp(server.fetch)
  setListeningPort(Number(new URL(app.origin).port))
  await startPlugins({ gateway })
  return {
    origin: app.origin,
    async stop() {
      await pluginMcpRoutes.closeAll()
      await stopPlugins()
      await app.close()
      setListeningPort(undefined)
    },
  }
}

let bench: ConnectorsBench | undefined
const storageRoots: Array<string> = []

/** A fresh plugin storage dir, so every run starts at the terms gate. */
function freshStorage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-plugins-"))
  storageRoots.push(dir)
  return dir
}

afterEach(async () => {
  const current = bench
  bench = undefined
  await current?.stop()
  writeConfig({})
  for (const dir of storageRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

async function drive(entitlement: BenchEntitlement) {
  const started = await startConnectorsBench({
    entitlement,
    startServer: startInProcess,
    storageRoot: freshStorage(),
  })
  bench = started
  const rows = await driveConnectorsBench(started)
  const table = formatChecks(rows)
  expect(
    rows.filter((row) => !row.ok),
    table,
  ).toEqual([])
  return rows
}

describe("bench:connectors --drive", () => {
  test("full entitlement: sign-in, groups, block/unblock, calls, policy denial", async () => {
    const rows = await drive("full")
    expect(rows.map((row) => row.name)).toEqual([
      "Settings shows the terms gate first",
      "Signs in instantly as bench@contoso.com",
      "Settings lists the tools by group",
      "MCP tools/list shows every tool",
      "Block delete_entity in Settings",
      "Calling blocked delete_entity is refused",
      "Unblock delete_entity",
      "Call allowed retrieve",
      "Policy-denied call (HTTP 403) is an error result",
      "Connector still works after the denial",
    ])
    expect(rows[2].detail).toBe(
      "14 tools: read-only 6, write/delete 5, other 3",
    )
  }, 30_000)

  test("partial entitlement: only the tools the tenant allows", async () => {
    const rows = await drive("partial")
    expect(rows[2].detail).toBe("6 tools: read-only 6, write/delete 0, other 0")
  }, 30_000)

  test("no entitlement: admin error, no tools, calls explain why", async () => {
    const rows = await drive("none")
    expect(rows.map((row) => row.name)).toContain(
      "Not-entitled account shows an admin error",
    )
  }, 30_000)

  test("the endpoint and Settings URL point at this server", async () => {
    bench = await startConnectorsBench({
      startServer: startInProcess,
      storageRoot: freshStorage(),
    })
    expect(bench.mcpUrl).toBe(`${bench.origin}/mcp/workiq`)
    expect(bench.settingsUrl).toBe(
      `${bench.origin}/ui/settings/#connectors/workiq`,
    )
    expect(bench.apiKey).toMatch(/^bench-[0-9a-f]{24}$/)
  })
})
