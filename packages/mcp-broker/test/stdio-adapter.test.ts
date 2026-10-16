import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { afterEach, describe, expect, it } from "bun:test"
import { resolve } from "node:path"

import {
  type RunningBrokerServer,
  startBrokerServer,
} from "../src/broker-server.ts"
import { ADAPTER_API_KEY_ENV, parseAdapterUrl } from "../src/stdio-adapter.ts"
import { BrokerWireConfigurationSchema } from "../src/wire-config.ts"

const API_KEY = "adapter-test-key-that-is-longer-than-32-bytes"
const runningServers: Array<RunningBrokerServer> = []

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()))
})

describe("adapter URL", () => {
  it("accepts a loopback MCP endpoint URL", () => {
    expect(parseAdapterUrl("http://127.0.0.1:4141/mcp/workiq").href).toBe(
      "http://127.0.0.1:4141/mcp/workiq",
    )
    expect(parseAdapterUrl("http://localhost:4141/mcp/work.iq").pathname).toBe(
      "/mcp/work.iq",
    )
  })

  it("rejects non-loopback, credentialed, or non-endpoint URLs", () => {
    // Built at runtime so no credentialed URI literal trips secret scanning.
    const credentialed = new URL("http://127.0.0.1:4141/mcp/workiq")
    credentialed.username = "user"
    credentialed.password = "pass"
    for (const value of [
      "not a url",
      "https://127.0.0.1:4141/mcp/workiq",
      "http://192.168.1.2:4141/mcp/workiq",
      credentialed.href,
      "http://127.0.0.1:4141/v1/messages",
      "http://127.0.0.1:4141/mcp/workiq/extra",
    ]) {
      expect(() => parseAdapterUrl(value)).toThrow("ADAPTER_ENDPOINT_INVALID")
    }
  })
})

it("proxies stdio to an authenticated loopback MCP endpoint", async () => {
  const configuration = BrokerWireConfigurationSchema.parse({
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
  })
  const broker = await startBrokerServer(configuration, API_KEY)
  runningServers.push(broker)
  const url = `http://${broker.host}:${broker.port}/mcp/fixture`

  const compiledBroker = process.env.MAXIMAL_MCP_BROKER_BINARY
  const transport = new StdioClientTransport({
    command: compiledBroker ?? process.execPath,
    args:
      compiledBroker ?
        ["stdio-adapter", "--url", url]
      : [
          resolve(import.meta.dir, "../src/main.ts"),
          "stdio-adapter",
          "--url",
          url,
        ],
    env: { [ADAPTER_API_KEY_ENV]: API_KEY },
    stderr: "pipe",
  })
  transport.stderr?.on("data", () => undefined)
  const client = new Client(
    { name: "adapter-e2e-client", version: "0.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  )

  try {
    await client.connect(transport, { timeout: 5_000 })
    expect(
      await client.callTool({ name: "ordinary", arguments: {} }),
    ).toMatchObject({
      content: [{ type: "text", text: "ordinary-ok" }],
    })
  } finally {
    await client.close()
  }
})
