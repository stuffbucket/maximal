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

const startFixtureBroker = async (): Promise<RunningBrokerServer> => {
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
  return broker
}

/** Launch the adapter the way Claude Desktop does: a child on stdio. */
const connectAdapter = async (
  broker: RunningBrokerServer,
): Promise<{ client: Client; transport: StdioClientTransport }> => {
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
  await client.connect(transport, { timeout: 5_000 })
  return { client, transport }
}

const whoami = async (client: Client): Promise<number> => {
  const result = await client.callTool({ name: "whoami", arguments: {} })
  const [content] = result.content as Array<{ text: string }>
  return Number(content.text.replace("pid:", ""))
}

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitUntil = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return
    await Bun.sleep(100)
  }
  throw new Error("timed out waiting")
}

it("proxies stdio to an authenticated loopback MCP endpoint", async () => {
  const { client } = await connectAdapter(await startFixtureBroker())
  try {
    expect(
      await client.callTool({ name: "ordinary", arguments: {} }),
    ).toMatchObject({
      content: [{ type: "text", text: "ordinary-ok" }],
    })
  } finally {
    await client.close()
  }
})

describe("adapter shutdown ends its broker session", () => {
  it("when the client closes stdin", async () => {
    const { client } = await connectAdapter(await startFixtureBroker())
    const pid = await whoami(client)
    expect(isRunning(pid)).toBe(true)

    await client.close()
    await waitUntil(() => !isRunning(pid))
  })

  it("when the client sends SIGTERM", async () => {
    const { client, transport } = await connectAdapter(
      await startFixtureBroker(),
    )
    try {
      const pid = await whoami(client)
      expect(transport.pid).toBeNumber()
      process.kill(transport.pid as number, "SIGTERM")
      await waitUntil(() => !isRunning(pid))
    } finally {
      await client.close()
    }
  })
})
