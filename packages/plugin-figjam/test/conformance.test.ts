/**
 * The generic plugin conformance suite (`@stuffbucket/maximal-plugin-host/testing`)
 * for FigJam, on a spare port with a temporary bridge data directory.
 */
import { runPluginConformance } from "@stuffbucket/maximal-plugin-host/testing"
import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { createFigjamPlugin } from "../src/index"

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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "figjam-conformance-"))
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

runPluginConformance(() => createFigjamPlugin({ dataDir }), {
  config: { port: freePort() },
  changedConfig: { port: freePort() },
  settled: (harness, id) => {
    const state = harness.snapshot(id).status?.state
    return state !== undefined && state !== "working"
  },
})
