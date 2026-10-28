/**
 * The stdio adapter on Windows, driven the way real clients drive it: a raw
 * `initialize` line on a pipe from a parent that isn't Bun. Claude Desktop
 * (Node) and PowerShell (.NET) create their pipes differently from Bun, and
 * an adapter that answers Bun's pipes may not answer theirs. Each client
 * writes one line and expects the adapter's `initialize` result back.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { resolve } from "node:path"

import {
  type RunningBrokerServer,
  startBrokerServer,
} from "../src/broker-server.ts"
import { ADAPTER_API_KEY_ENV } from "../src/stdio-adapter.ts"
import { BrokerWireConfigurationSchema } from "../src/wire-config.ts"

const API_KEY = "adapter-pipes-key-that-is-longer-than-32-bytes"
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pipe-client", version: "0.0.0" },
  },
})

const running: Array<RunningBrokerServer> = []
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()))
})

const startBroker = async (): Promise<string> => {
  const broker = await startBrokerServer(
    BrokerWireConfigurationSchema.parse({
      endpoints: [
        {
          id: "fixture",
          label: "Fixture",
          command: process.execPath,
          args: [resolve(import.meta.dir, "fixture.ts"), "--era", "legacy"],
          protocol: "legacy",
          ownership: "exclusive",
        },
      ],
    }),
    API_KEY,
  )
  running.push(broker)
  return `http://${broker.host}:${broker.port}/mcp/fixture`
}

/** The adapter's command line (the compiled one when it's set). */
const adapterCommand = (url: string): Array<string> => {
  const compiled = process.env.MAXIMAL_MCP_BROKER_BINARY
  return compiled ?
      [compiled, "stdio-adapter", "--url", url]
    : [
        process.execPath,
        resolve(import.meta.dir, "../src/main.ts"),
        "stdio-adapter",
        "--url",
        url,
      ]
}

type ClientResult = { line?: string; timeout?: boolean; exited?: number }

/** Run `command` under a client that isn't Bun; what it read back. Async,
 *  so the broker in this process keeps serving meanwhile. */
const throughClient = async (
  client: "node" | "powershell",
  line: string,
  command: Array<string>,
): Promise<ClientResult> => {
  const env = { ...process.env, [ADAPTER_API_KEY_ENV]: API_KEY }
  const [program, args] =
    client === "node" ?
      [
        "node",
        [resolve(import.meta.dir, "pipe-client.mjs"), "15000", line, ...command],
      ]
    : [
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve(import.meta.dir, "pipe-client.ps1"),
          "-TimeoutMs",
          "15000",
          "-Line",
          line,
          "-Command",
          command[0] ?? "",
          "-Arguments",
          ...command.slice(1),
        ],
      ]
  const child = spawn(program, args, { env, windowsHide: true })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4096)
  })
  await new Promise((done) => child.once("close", done))
  const result = { stdout, stderr }
  const last = result.stdout.trim().split(/\r?\n/u).at(-1) ?? ""
  try {
    return JSON.parse(last) as ClientResult
  } catch {
    throw new Error(
      `${client} client printed ${JSON.stringify(result.stdout)}; stderr ${JSON.stringify(result.stderr)}`,
    )
  }
}

const windows = process.platform === "win32"

describe.skipIf(!windows)("the stdio adapter on Windows pipes", () => {
  for (const client of ["node", "powershell"] as const) {
    it(`answers initialize from a ${client} parent`, async () => {
      const result = await throughClient(
        client,
        INITIALIZE,
        adapterCommand(await startBroker()),
      )
      expect(result.line).toContain('"id":1')
      expect(JSON.parse(result.line ?? "{}")).toMatchObject({
        id: 1,
        result: { protocolVersion: "2025-06-18" },
      })
    }, 60_000)
  }

  // Diagnostic: which ways of reading stdin work under each parent. Logged,
  // not asserted.
  it("reports which stdin readers work under each parent", async () => {
    for (const client of ["node", "powershell"] as const) {
      for (const method of ["process-stdin", "bun-stdin", "fs-stream", "fs-read"]) {
        const result = await throughClient(client, "ping", [
          process.execPath,
          resolve(import.meta.dir, "stdin-probe.ts"),
          method,
        ])
        console.log(
          `[stdin-probe] ${client} ${method}: ${JSON.stringify(result)}`,
        )
      }
    }
  }, 120_000)
})
