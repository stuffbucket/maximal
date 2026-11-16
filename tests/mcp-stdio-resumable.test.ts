import {
  isJSONRPCRequest,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type TransportSendOptions,
} from "@modelcontextprotocol/client"
import { describe, expect, test } from "bun:test"

import { ResumableTransport } from "~/lib/mcp-stdio/resumable-transport"

const INITIALIZE: JSONRPCMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
}

class FakeHttpTransport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void

  readonly hasPerRequestStream = true
  readonly sent: Array<JSONRPCMessage> = []
  readonly versions: Array<string> = []
  starts = 0
  closes = 0
  terminations = 0

  readonly sessionId: string | undefined
  readonly handle: (
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ) => Promise<void>

  constructor(
    sessionId: string | undefined,
    handle: (
      message: JSONRPCMessage,
      options?: TransportSendOptions,
    ) => Promise<void> = () => Promise.resolve(),
  ) {
    this.sessionId = sessionId
    this.handle = handle
  }

  start(): Promise<void> {
    this.starts += 1
    return Promise.resolve()
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    this.sent.push(message)
    await this.handle(message, options)
  }

  close(): Promise<void> {
    this.closes += 1
    return Promise.resolve()
  }

  terminateSession(): Promise<void> {
    this.terminations += 1
    return Promise.resolve()
  }

  setProtocolVersion(version: string): void {
    this.versions.push(version)
  }
}

function methodOf(message: JSONRPCMessage): string | undefined {
  return "method" in message ? message.method : undefined
}

describe("resumable MCP HTTP transport", () => {
  test("retries initialize after connection refusal", async () => {
    const refused = Object.assign(new Error("refused"), {
      code: "ECONNREFUSED",
    })
    const first = new FakeHttpTransport(undefined, () =>
      Promise.reject(refused),
    )
    const second = new FakeHttpTransport("session-2")
    const transports = [first, second]
    const transport = new ResumableTransport(
      () => transports.shift() ?? second,
      1_000,
    )

    await transport.start()
    await transport.send(INITIALIZE)

    expect(first.starts).toBe(1)
    expect(first.closes).toBe(1)
    expect(second.starts).toBe(1)
    expect(second.sent).toEqual([INITIALIZE])
    expect(transport.sessionId).toBe("session-2")
  })

  test("reinitializes a lost session before retrying the request", async () => {
    const first = new FakeHttpTransport("session-1", (message) => {
      if (methodOf(message) === "tools/list") {
        return Promise.reject(
          Object.assign(new Error("missing"), { status: 404 }),
        )
      }
      return Promise.resolve()
    })
    const second = new FakeHttpTransport("session-2", (message) => {
      if (isJSONRPCRequest(message) && methodOf(message) === "initialize") {
        queueMicrotask(() => {
          second.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "maximal", version: "test" },
            },
          })
        })
      }
      return Promise.resolve()
    })
    const transports = [first, second]
    const transport = new ResumableTransport(
      () => transports.shift() ?? second,
      1_000,
    )
    const request: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }

    await transport.start()
    await transport.send(INITIALIZE)
    transport.setProtocolVersion("2025-06-18")
    await transport.send(request)

    expect(first.sent).toEqual([INITIALIZE, request])
    expect(second.starts).toBe(1)
    expect(second.versions).toEqual(["2025-06-18"])
    expect(second.sent.map((message) => methodOf(message))).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ])
    expect(second.sent.at(-1)).toEqual(request)
    expect(transport.sessionId).toBe("session-2")
  })

  test("does not replay a stale response into a replacement session", async () => {
    const first = new FakeHttpTransport("session-1", (message) =>
      "result" in message ?
        Promise.reject(Object.assign(new Error("missing"), { status: 404 }))
      : Promise.resolve(),
    )
    const second = new FakeHttpTransport("session-2", (message) => {
      if (isJSONRPCRequest(message) && methodOf(message) === "initialize") {
        queueMicrotask(() => {
          second.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "maximal", version: "test" },
            },
          })
        })
      }
      return Promise.resolve()
    })
    const transports = [first, second]
    const transport = new ResumableTransport(
      () => transports.shift() ?? second,
      1_000,
    )
    const stale: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 99,
      result: { action: "accept" },
    }

    await transport.start()
    await transport.send(INITIALIZE)
    await transport.send(stale)

    expect(second.sent.map((message) => methodOf(message))).toEqual([
      "initialize",
      "notifications/initialized",
    ])
    expect(second.sent).not.toContainEqual(stale)
  })
})
