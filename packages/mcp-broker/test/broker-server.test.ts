import { Client } from "@modelcontextprotocol/client"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it } from "bun:test"
import { resolve } from "node:path"

import {
  type RunningBrokerServer,
  startBrokerServer,
} from "../src/broker-server.ts"
import { BrokerWireConfigurationSchema } from "../src/wire-config.ts"

const API_KEY = "broker-test-key-that-is-longer-than-32-bytes"
const fixturePath = resolve(import.meta.dir, "fixture.ts")
const runningServers: Array<RunningBrokerServer> = []

const startFixtureBroker = async (): Promise<RunningBrokerServer> => {
  const configuration = BrokerWireConfigurationSchema.parse({
    endpoints: [
      {
        id: "fixture",
        label: "Fixture",
        command: process.execPath,
        args: [fixturePath, "--era", "legacy"],
        protocol: "legacy",
        interaction: "interactive",
        ownership: "exclusive",
      },
    ],
  })
  const server = await startBrokerServer(configuration, API_KEY)
  runningServers.push(server)
  return server
}

const connectClient = async (server: RunningBrokerServer): Promise<Client> => {
  const client = new Client(
    { name: "broker-test-client", version: "0.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  )
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${server.host}:${server.port}/mcp/fixture`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${API_KEY}` },
      },
    },
  )
  await client.connect(transport, { timeout: 5_000 })
  return client
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()))
})

describe("broker server", () => {
  it("authenticates and proxies an ordinary legacy tool call", async () => {
    const server = await startFixtureBroker()

    const unauthorized = await fetch(
      `http://${server.host}:${server.port}/mcp/fixture`,
      { headers: { Origin: "https://example.invalid" }, method: "POST" },
    )
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get("access-control-allow-origin")).toBeNull()

    const client = await connectClient(server)
    try {
      const result = await client.callTool({ name: "ordinary", arguments: {} })
      expect(result).toMatchObject({
        content: [{ type: "text", text: "ordinary-ok" }],
      })
    } finally {
      await client.close()
    }
  })

  it("rejects a second owner for an exclusive legacy endpoint", async () => {
    const server = await startFixtureBroker()
    const owner = await connectClient(server)

    try {
      await expect(connectClient(server)).rejects.toThrow()
    } finally {
      await owner.close()
    }
  })
})
