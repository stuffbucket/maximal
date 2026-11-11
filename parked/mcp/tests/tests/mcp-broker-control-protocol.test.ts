import { describe, expect, it } from "bun:test"

import {
  BrokerControlProtocolError,
  BrokerFrameDecoder,
  CONTROL_PROTOCOL,
  CONTROL_PROTOCOL_VERSION,
} from "~/lib/mcp-broker/control-protocol"

function framed(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value))
  const frame = new Uint8Array(4 + body.byteLength)
  new DataView(frame.buffer).setUint32(0, body.byteLength)
  frame.set(body, 4)
  return frame
}

describe("BrokerFrameDecoder", () => {
  it("accepts split frames and endpoint observations", () => {
    const frame = framed({
      protocol: CONTROL_PROTOCOL,
      version: CONTROL_PROTOCOL_VERSION,
      generation: "generation-1",
      sequence: 0,
      deadlineMs: Date.now() + 10_000,
      operation: "ready",
      payload: {
        host: "127.0.0.1",
        port: 49_152,
        endpoints: [
          {
            id: "fixture",
            serverName: "Fixture",
            serverVersion: "1.0.0",
            negotiatedProtocol: "2025-11-25",
            protocolEra: "legacy",
            ownership: "exclusive",
            capabilities: {
              completions: false,
              logging: true,
              prompts: false,
              resources: false,
              tools: true,
            },
            tools: ["accept_eula", "ask", "list_agents"],
          },
        ],
      },
    })
    const decoder = new BrokerFrameDecoder()

    expect(decoder.push(frame.subarray(0, 7))).toEqual([])
    expect(decoder.push(frame.subarray(7))).toHaveLength(1)
  })

  it("rejects oversized declared frames before allocation", () => {
    const frame = new Uint8Array(4)
    new DataView(frame.buffer).setUint32(0, 65)

    expect(() => new BrokerFrameDecoder(64).push(frame)).toThrow(
      BrokerControlProtocolError,
    )
  })

  it("rejects unknown fields", () => {
    expect(() =>
      new BrokerFrameDecoder().push(
        framed({
          protocol: CONTROL_PROTOCOL,
          version: CONTROL_PROTOCOL_VERSION,
          generation: "generation-1",
          sequence: 0,
          deadlineMs: Date.now() + 10_000,
          operation: "heartbeat",
          payload: { sentAtMs: Date.now(), unexpected: true },
        }),
      ),
    ).toThrow(BrokerControlProtocolError)
  })
})
