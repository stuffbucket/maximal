import { Server } from "@modelcontextprotocol/server"
import { expect, it } from "bun:test"
import { startHTTPServer } from "mcp-proxy"

it("binds to an OS-selected IPv4 loopback port", async () => {
  const listener = await startHTTPServer({
    apiKey: "test-only-api-key-that-is-at-least-32-bytes",
    createServer: async () =>
      new Server(
        { name: "listener-test", version: "1.0.0" },
        { capabilities: {} },
      ),
    host: "127.0.0.1",
    port: 0,
    sseEndpoint: null,
    streamEndpoint: "/mcp",
  })

  try {
    expect(listener.address.address).toBe("127.0.0.1")
    expect(listener.address.port).toBeGreaterThan(0)

    const response = await fetch(
      `http://127.0.0.1:${listener.address.port}/ping`,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("pong")
  } finally {
    await listener.close()
  }
})
