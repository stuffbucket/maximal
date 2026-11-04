import { describe, expect, it } from "bun:test"

import {
  CONTROL_PROTOCOL,
  CONTROL_PROTOCOL_VERSION,
  ControlFrameDecoder,
  type ControlEnvelope,
  ControlProtocolError,
  ControlSequenceValidator,
  encodeControlEnvelope,
} from "../src/control-protocol.ts"

const makeHeartbeat = (sequence: number): ControlEnvelope => ({
  protocol: CONTROL_PROTOCOL,
  version: CONTROL_PROTOCOL_VERSION,
  generation: "generation-1",
  sequence,
  deadlineMs: 2_000_000_000_000,
  operation: "heartbeat",
  payload: { sentAtMs: 1_999_999_999_000 },
})

const join = (...chunks: Array<Uint8Array>): Uint8Array => {
  const joined = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.byteLength, 0),
  )
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }

  return joined
}

const frameBody = (body: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(4 + body.byteLength)
  new DataView(frame.buffer).setUint32(0, body.byteLength)
  frame.set(body, 4)
  return frame
}

const expectProtocolError = (
  callback: () => unknown,
  code: ControlProtocolError["code"],
): void => {
  try {
    callback()
    throw new Error("Expected a control protocol error")
  } catch (error) {
    expect(error).toBeInstanceOf(ControlProtocolError)
    expect((error as ControlProtocolError).code).toBe(code)
  }
}

describe("control framing", () => {
  it("round-trips an envelope", () => {
    const envelope = makeHeartbeat(0)
    const decoder = new ControlFrameDecoder()

    expect(decoder.push(encodeControlEnvelope(envelope))).toEqual([envelope])
    expect(decoder.finish()).toBeUndefined()
  })

  it("decodes partial and coalesced frames", () => {
    const first = encodeControlEnvelope(makeHeartbeat(0))
    const second = encodeControlEnvelope(makeHeartbeat(1))
    const decoder = new ControlFrameDecoder()

    expect(decoder.push(first.subarray(0, 2))).toEqual([])
    expect(decoder.push(join(first.subarray(2), second))).toEqual([
      makeHeartbeat(0),
      makeHeartbeat(1),
    ])
  })

  it("rejects an oversized length before allocating the body", () => {
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(0, 65)
    const decoder = new ControlFrameDecoder(64)

    expectProtocolError(() => decoder.push(header), "CONTROL_FRAME_OVERSIZED")
  })

  it("rejects empty frames", () => {
    expectProtocolError(
      () => new ControlFrameDecoder().push(new Uint8Array(4)),
      "CONTROL_FRAME_EMPTY",
    )
  })

  it("rejects invalid UTF-8", () => {
    expectProtocolError(
      () =>
        new ControlFrameDecoder().push(
          frameBody(Uint8Array.from([0xc3, 0x28])),
        ),
      "CONTROL_FRAME_INVALID_UTF8",
    )
  })

  it("rejects malformed JSON", () => {
    expectProtocolError(
      () =>
        new ControlFrameDecoder().push(
          frameBody(new TextEncoder().encode("{")),
        ),
      "CONTROL_FRAME_INVALID_JSON",
    )
  })

  it("rejects schema-invalid envelopes", () => {
    expectProtocolError(
      () =>
        new ControlFrameDecoder().push(
          frameBody(new TextEncoder().encode(JSON.stringify({ nope: true }))),
        ),
      "CONTROL_FRAME_SCHEMA_INVALID",
    )
  })

  it("rejects truncated input at EOF", () => {
    const decoder = new ControlFrameDecoder()
    decoder.push(encodeControlEnvelope(makeHeartbeat(0)).subarray(0, 12))

    expectProtocolError(() => decoder.finish(), "CONTROL_FRAME_TRUNCATED")
  })
})

describe("control sequence validation", () => {
  it("accepts only the expected generation and sequence", () => {
    const validator = new ControlSequenceValidator("generation-1")
    validator.accept(makeHeartbeat(0))
    validator.accept(makeHeartbeat(1))

    expectProtocolError(
      () => validator.accept(makeHeartbeat(1)),
      "CONTROL_SEQUENCE_MISMATCH",
    )
  })

  it("rejects a stale generation", () => {
    const validator = new ControlSequenceValidator("generation-2")

    expectProtocolError(
      () => validator.accept(makeHeartbeat(0)),
      "CONTROL_GENERATION_MISMATCH",
    )
  })
})
