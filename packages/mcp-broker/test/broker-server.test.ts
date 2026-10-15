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

const startFixtureBroker = async (
  endpoint: { maxSessions?: number } = {},
): Promise<RunningBrokerServer> => {
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
        ...endpoint,
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
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (condition()) return
    await Bun.sleep(100)
  }
  throw new Error("timed out waiting")
}

/** End the session the way a well-behaved client does: DELETE it. */
const closeSession = async (client: Client): Promise<void> => {
  const transport = client.transport as StreamableHTTPClientTransport | undefined
  await transport?.terminateSession()
  await client.close()
}

const initialize = (server: RunningBrokerServer): Promise<Response> =>
  fetch(`http://${server.host}:${server.port}/mcp/fixture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "limit-probe", version: "0" },
      },
    }),
  })

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

  it("gives every session its own upstream instance", async () => {
    const server = await startFixtureBroker()
    const first = await connectClient(server)
    const second = await connectClient(server)

    try {
      const [a, b] = await Promise.all([whoami(first), whoami(second)])
      expect(a).not.toBe(b)
      // Both sessions keep working side by side.
      expect(await whoami(first)).toBe(a)
      expect(await whoami(second)).toBe(b)
    } finally {
      await first.close()
      await second.close()
    }
  })

  it("stops a session's instance when the session closes", async () => {
    const server = await startFixtureBroker()
    const client = await connectClient(server)
    const pid = await whoami(client)
    expect(isRunning(pid)).toBe(true)

    await closeSession(client)
    await waitUntil(() => !isRunning(pid))
  })

  it("refuses sessions past the endpoint's limit with a clear 503", async () => {
    const server = await startFixtureBroker({ maxSessions: 1 })
    const owner = await connectClient(server)

    try {
      const response = await initialize(server)
      expect(response.status).toBe(503)
      expect(await response.text()).toContain("already has 1 sessions open")
    } finally {
      await owner.close()
    }
  })
})
