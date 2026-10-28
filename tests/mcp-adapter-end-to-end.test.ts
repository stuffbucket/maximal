/**
 * The stdio adapter end to end, the way Claude Desktop uses it: a Node
 * parent runs `maximal-mcp-broker stdio-adapter` against Maximal's
 * `/mcp/<id>` route, which forwards to a real broker serving the test MCP
 * server. The parent writes one raw `initialize` line and must get the
 * result back, then `tools/list`.
 *
 * Needs the broker package's dependencies (`bun run mcp-broker:install`)
 * and `node` on PATH; skipped without them. Uses the compiled broker when
 * MAXIMAL_MCP_BROKER_BINARY is set (CI sets it), else its source.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

import { writeConfig } from "~/lib/config/config"
import { createMcpRoutes } from "~/routes/mcp/route"

const BROKER_DIR = path.resolve(import.meta.dir, "..", "packages", "mcp-broker")
const BROKER_KEY = "adapter-e2e-broker-key-longer-than-32-bytes"
const ENDPOINT_KEY = "adapter-e2e-endpoint-key"

const ready =
  existsSync(path.join(BROKER_DIR, "node_modules", "mcp-proxy"))
  && Bun.which("node") !== null

const request = (id: number, method: string, params: object = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params })

interface RunningBroker {
  host: string
  port: number
  close(): Promise<void>
}

const cleanups: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  writeConfig({})
})

/** A real broker, in this process, serving the broker tests' fixture with
 *  the endpoint's `protocol` (Maximal's default is "auto"). */
const startBroker = async (
  protocol: "auto" | "legacy",
): Promise<RunningBroker> => {
  // Loaded by path at runtime: the broker package has its own dependencies
  // and compiler settings.
  const server = (await import(
    path.join(BROKER_DIR, "src", "broker-server.ts")
  )) as {
    startBrokerServer(
      configuration: unknown,
      apiKey: string,
    ): Promise<RunningBroker>
  }
  const wire = (await import(
    path.join(BROKER_DIR, "src", "wire-config.ts")
  )) as {
    BrokerWireConfigurationSchema: { parse(value: unknown): unknown }
  }
  const broker = await server.startBrokerServer(
    wire.BrokerWireConfigurationSchema.parse({
      endpoints: [
        {
          id: "fixture",
          label: "Fixture",
          command: process.execPath,
          args: [
            path.join(BROKER_DIR, "test", "fixture.ts"),
            "--era",
            "legacy",
          ],
          protocol,
          ownership: "exclusive",
        },
      ],
    }),
    BROKER_KEY,
  )
  cleanups.push(() => broker.close())
  return broker
}

/** Maximal's /mcp route in front of `broker`, on a loopback port. */
const startMaximalRoute = (broker: RunningBroker): string => {
  writeConfig({
    mcpBroker: {
      enabled: true,
      servers: [
        {
          id: "fixture",
          label: "Fixture",
          apiKey: ENDPOINT_KEY,
          transport: { type: "stdio", command: "fixture" },
        },
      ],
    },
  })
  const app = new Hono()
  app.route(
    "/mcp",
    createMcpRoutes({
      getUpstream: () => ({
        origin: `http://${broker.host}:${broker.port}`,
        apiKey: BROKER_KEY,
      }),
      getRequestIp: () => "127.0.0.1",
      heldBack: () => false,
    }),
  )
  // As the server runs it (run-server.ts): no idle timeout for streams.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: (req) => app.fetch(req),
  })
  cleanups.push(() => server.stop(true))
  return `http://127.0.0.1:${server.port}/mcp/fixture`
}

const adapterCommand = (url: string): Array<string> => {
  const compiled = process.env.MAXIMAL_MCP_BROKER_BINARY
  return compiled ?
      [compiled, "stdio-adapter", "--url", url]
    : [
        process.execPath,
        path.join(BROKER_DIR, "src", "main.ts"),
        "stdio-adapter",
        "--url",
        url,
      ]
}

/** Send `lines` through a Node parent; the adapter's replies, one per line. */
const throughNode = async (
  url: string,
  lines: Array<string>,
): Promise<{ replies: Array<string>; stderr: string }> => {
  const child = spawn(
    "node",
    [
      path.join(BROKER_DIR, "test", "pipe-session.mjs"),
      "20000",
      JSON.stringify(lines),
      ...adapterCommand(url),
    ],
    {
      env: { ...process.env, MAXIMAL_MCP_API_KEY: ENDPOINT_KEY },
      windowsHide: true,
    },
  )
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
  const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1) ?? "{}") as {
    replies?: Array<string>
  }
  return { replies: result.replies ?? [], stderr }
}

describe.skipIf(!ready)(
  "the stdio adapter through Maximal's /mcp route",
  () => {
    test.each(["auto", "legacy"] as const)(
      "answers initialize and tools/list from a Node parent (endpoint protocol %s)",
      async (protocol) => {
        const url = startMaximalRoute(await startBroker(protocol))
        const { replies, stderr } = await throughNode(url, [
          request(0, "initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "node-parent", version: "0.0.0" },
          }),
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
          request(1, "tools/list"),
        ])
        expect(replies.length, stderr).toBe(2)
        expect(JSON.parse(replies[0] ?? "{}")).toMatchObject({
          id: 0,
          result: { protocolVersion: "2025-06-18" },
        })
        const tools = JSON.parse(replies[1] ?? "{}") as {
          result?: { tools?: Array<{ name: string }> }
        }
        expect(tools.result?.tools?.map((tool) => tool.name)).toContain(
          "ordinary",
        )
      },
      60_000,
    )
  },
)
