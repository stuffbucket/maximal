import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { afterEach, describe, expect, it } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
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

const startFixtureBroker = async (
  endpoint: { sessionIdleTimeoutMs?: number } = {},
): Promise<RunningBrokerServer> => {
  const configuration = BrokerWireConfigurationSchema.parse({
    endpoints: [
      {
        id: "fixture",
        label: "Fixture",
        command: process.execPath,
        args: [resolve(import.meta.dir, "fixture.ts"), "--era", "legacy"],
        protocol: "legacy",
        ownership: "exclusive",
        ...endpoint,
      },
    ],
  })
  const broker = await startBrokerServer(configuration, API_KEY)
  runningServers.push(broker)
  return broker
}

/** Launch the adapter the way Claude Desktop does: a child on stdio. */
const connectAdapter = async (
  broker: RunningBrokerServer | string,
  timeout = 5_000,
  extraEnv: Record<string, string> = {},
): Promise<{ client: Client; transport: StdioClientTransport }> => {
  const url =
    typeof broker === "string" ?
      broker
    : `http://${broker.host}:${broker.port}/mcp/fixture`
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
    env: { [ADAPTER_API_KEY_ENV]: API_KEY, ...extraEnv },
    stderr: "pipe",
  })
  transport.stderr?.on("data", () => undefined)
  const client = new Client(
    { name: "adapter-e2e-client", version: "0.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  )
  await client.connect(transport, { timeout })
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

it("ignores a proxy set in the client's environment", async () => {
  // Nothing listens on port 9; a fetch through it would fail.
  const { client } = await connectAdapter(await startFixtureBroker(), 10_000, {
    HTTP_PROXY: "http://127.0.0.1:9",
    http_proxy: "http://127.0.0.1:9",
  })
  try {
    expect(client.getServerVersion()).toBeDefined()
  } finally {
    await client.close()
  }
}, 20_000)

it("proxies stdio to an authenticated loopback MCP endpoint", async () => {
  const { client } = await connectAdapter(await startFixtureBroker())
  try {
    // connectAdapter's connect is the client's `initialize` through it.
    expect(client.getServerVersion()).toBeDefined()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toContain("ordinary")
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

  // Windows has no SIGTERM: kill() there is TerminateProcess, which runs no
  // handler. Clients end the adapter by closing stdin, covered above.
  it.skipIf(process.platform === "win32")("when the client sends SIGTERM", async () => {
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

it("reclaims an idle session whose adapter was killed outright", async () => {
  const { client, transport } = await connectAdapter(
    await startFixtureBroker({ sessionIdleTimeoutMs: 500 }),
  )
  try {
    const pid = await whoami(client)
    // SIGKILL runs no cleanup, so the session is never DELETEd. Only the OS
    // closing the adapter's connections tells the broker it is gone.
    process.kill(transport.pid as number, "SIGKILL")
    await waitUntil(() => !isRunning(pid))
  } finally {
    await client.close()
  }
})

/**
 * Stands in for Maximal's `/mcp/<id>` on a fixed port: answers 503 while the
 * broker is "unavailable", otherwise forwards to whichever broker is current,
 * so a test can swap brokers the way a broker restart does.
 */
interface Gate {
  url: string
  unavailable: boolean
  target: RunningBrokerServer | undefined
  close(): Promise<void>
}

const freePort = async (): Promise<number> => {
  const probe = http.createServer()
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((done) => probe.close(() => done()))
  return port
}

const startGate = async (port: number): Promise<Gate> => {
  const gate: Gate = {
    url: `http://127.0.0.1:${port}/mcp/fixture`,
    unavailable: false,
    target: undefined,
    close: async () => undefined,
  }
  const server = http.createServer((request, response) => {
    const target = gate.target
    if (gate.unavailable || !target) {
      response.writeHead(503, { "content-type": "application/json" })
      response.end('{"error":{"code":"MCP_BROKER_UNAVAILABLE"}}')
      return
    }
    const upstream = http.request({
      host: target.host,
      port: target.port,
      path: "/mcp/fixture",
      method: request.method,
      headers: request.headers,
    })
    upstream.on("response", (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(response)
    })
    upstream.on("error", () => {
      if (response.headersSent) response.destroy()
      else response.writeHead(502).end()
    })
    response.on("close", () => upstream.destroy())
    request.pipe(upstream)
  })
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done))
  gate.close = () =>
    new Promise<void>((done) => {
      server.close(() => done())
      server.closeAllConnections()
    })
  return gate
}

describe("adapter resilience", () => {
  it("waits for Maximal to come up and the broker to be ready", async () => {
    const port = await freePort()
    // Nothing listens yet: the adapter's first tries are refused.
    const connecting = connectAdapter(
      `http://127.0.0.1:${port}/mcp/fixture`,
      20_000,
    )
    await Bun.sleep(700)
    const gate = await startGate(port)
    try {
      // Then Maximal answers 503 while its broker probes.
      gate.unavailable = true
      await Bun.sleep(700)
      gate.target = await startFixtureBroker()
      gate.unavailable = false

      const { client } = await connecting
      try {
        expect(
          await client.callTool({ name: "ordinary", arguments: {} }),
        ).toMatchObject({ content: [{ type: "text", text: "ordinary-ok" }] })
      } finally {
        await client.close()
      }
    } finally {
      await gate.close()
    }
  }, 30_000)

  it("starts a new session when the broker restarted under it", async () => {
    const gate = await startGate(await freePort())
    try {
      const first = await startFixtureBroker()
      gate.target = first
      const { client } = await connectAdapter(gate.url)
      try {
        const before = await whoami(client)

        // The broker restarts: the adapter's session is gone (404 from the
        // new broker), and for a moment Maximal answers 503.
        gate.unavailable = true
        await first.close()
        gate.target = await startFixtureBroker()
        setTimeout(() => {
          gate.unavailable = false
        }, 500)

        const after = await whoami(client)
        expect(after).not.toBe(before)
        expect(isRunning(after)).toBe(true)
        // And it keeps working on the new session.
        expect(await whoami(client)).toBe(after)
      } finally {
        await client.close()
      }
    } finally {
      await gate.close()
    }
  }, 30_000)
})

it("answers the client's initialize with the reason when it can't connect", async () => {
  // An endpoint that refuses every request, as Maximal does without the key.
  const refusing = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("Unauthorized", { status: 401 }),
  })
  try {
    const compiled = process.env.MAXIMAL_MCP_BROKER_BINARY
    const url = `http://127.0.0.1:${refusing.port}/mcp/fixture`
    const child = Bun.spawn(
      compiled ?
        [compiled, "stdio-adapter", "--url", url]
      : [
          process.execPath,
          resolve(import.meta.dir, "../src/main.ts"),
          "stdio-adapter",
          "--url",
          url,
        ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    )
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      })}\n`,
    )
    await child.stdin.flush()
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(1)
    expect(JSON.parse(stdout.trim())).toMatchObject({
      id: 0,
      error: { code: -32_000 },
    })
    expect(stdout).toContain("HTTP 401")
    expect(stderr).toContain(
      "[maximal-mcp-broker] ADAPTER_CONNECT_FAILED status=401",
    )
  } finally {
    await refusing.stop(true)
  }
}, 30_000)
