/* eslint-disable max-lines-per-function -- protocol conformance cases share frame helpers */
import { describe, expect, test } from "bun:test"

import {
  createLoopbackTransportPair,
  decodeFrame,
  decodeMultipart,
  errorToWireError,
  frame,
  PLUGIN_API_VERSION,
  PLUGIN_PROTOCOL_VERSION,
  PROTOCOL_LIMITS,
  ProtocolError,
  ProtocolFence,
  wireErrorToError,
  type CancelFrame,
  type ProgressFrame,
  type RequestFrame,
  type ResultFrame,
  type SpendAckFrame,
  type SpendFrame,
  type StateEventFrame,
} from "../src"

const generation = "generation-1"

function request(seq = 0, callId = "call-1"): RequestFrame {
  return frame<RequestFrame>({
    generation,
    id: `message-${seq}`,
    seq,
    type: "request",
    callId,
    payload: { method: "tools/call", params: { input: true } },
  })
}

function result(seq = 1, callId = "call-1"): ResultFrame {
  return frame<ResultFrame>({
    generation,
    id: `message-${seq}`,
    seq,
    type: "result",
    callId,
    payload: { value: { ok: true } },
  })
}

function protocolCode(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof ProtocolError ? error.code : undefined
  }
}

describe("protocol codec", () => {
  test("accepts an exact bounded envelope", () => {
    expect(decodeFrame(request(), { generation })).toEqual(request())
  })

  test("rejects unknown protocol and API versions", () => {
    expect(
      protocolCode(() =>
        decodeFrame(
          { ...request(), protocol: PLUGIN_PROTOCOL_VERSION + 1 },
          { generation },
        ),
      ),
    ).toBe("version-mismatch")
    expect(
      protocolCode(() =>
        decodeFrame(
          { ...request(), pluginApi: PLUGIN_API_VERSION + 1 },
          { generation },
        ),
      ),
    ).toBe("version-mismatch")
  })

  test("rejects unknown types, fields, and malformed payloads", () => {
    expect(
      protocolCode(() =>
        decodeFrame({ ...request(), type: "future-frame" }, { generation }),
      ),
    ).toBe("malformed")
    expect(
      protocolCode(() =>
        decodeFrame({ ...request(), extra: true }, { generation }),
      ),
    ).toBe("malformed")
    expect(
      protocolCode(() =>
        decodeFrame(
          { ...request(), payload: { method: "x", params: null, extra: true } },
          { generation },
        ),
      ),
    ).toBe("malformed")
  })

  test("rejects stale generations", () => {
    expect(
      protocolCode(() =>
        decodeFrame(request(), { generation: "generation-2" }),
      ),
    ).toBe("stale-generation")
  })

  test("rejects oversized strings, collections, objects, and envelopes", () => {
    expect(
      protocolCode(() =>
        decodeFrame(
          {
            ...request(),
            payload: {
              method: "x",
              params: "x".repeat(PROTOCOL_LIMITS.stringBytes + 1),
            },
          },
          { generation },
        ),
      ),
    ).toBe("oversize")
    expect(
      protocolCode(() =>
        decodeFrame(
          {
            ...request(),
            payload: {
              method: "x",
              params: Array.from(
                { length: PROTOCOL_LIMITS.collectionItems + 1 },
                () => null,
              ),
            },
          },
          { generation },
        ),
      ),
    ).toBe("oversize")
    expect(
      protocolCode(() =>
        decodeFrame(
          {
            ...request(),
            payload: {
              method: "x",
              params: Object.fromEntries(
                Array.from(
                  { length: PROTOCOL_LIMITS.objectKeys + 1 },
                  (_, index) => [index, null],
                ),
              ),
            },
          },
          { generation },
        ),
      ),
    ).toBe("oversize")
    expect(
      protocolCode(() =>
        decodeFrame(
          {
            ...request(),
            payload: {
              method: "x",
              params: [
                "x".repeat(PROTOCOL_LIMITS.stringBytes),
                "x".repeat(PROTOCOL_LIMITS.stringBytes),
                "x".repeat(PROTOCOL_LIMITS.stringBytes),
                "x".repeat(PROTOCOL_LIMITS.stringBytes),
                "x".repeat(PROTOCOL_LIMITS.stringBytes),
              ],
            },
          },
          { generation },
        ),
      ),
    ).toBe("oversize")
  })

  test("validates ordered duplicate-preserving multipart handles", () => {
    const decoded = decodeMultipart(
      {
        parts: [
          { name: "prompt", value: "hello" },
          {
            name: "image",
            value: {
              generation,
              id: "blob-1",
              byteLength: 10,
              filename: "a.png",
            },
          },
          { name: "prompt", value: "again" },
        ],
        aggregateBytes: 20,
      },
      generation,
    )
    expect(decoded.parts.map((part) => part.name)).toEqual([
      "prompt",
      "image",
      "prompt",
    ])
    expect(
      protocolCode(() =>
        decodeMultipart(
          {
            parts: [
              {
                name: "image",
                value: { generation: "old", id: "blob-1", byteLength: 10 },
              },
            ],
            aggregateBytes: 10,
          },
          generation,
        ),
      ),
    ).toBe("stale-generation")
  })

  test("rehydrates validated typed error metadata", () => {
    const dto = errorToWireError(new Error("unavailable"), {
      kind: "operation-unavailable",
      code: "model_not_enabled",
      retry: "never",
    })
    const error = wireErrorToError({ ...dto, operation: "images", model: "m" })
    expect(error.message).toBe("unavailable")
    expect(error.wire).toMatchObject({
      kind: "operation-unavailable",
      operation: "images",
      model: "m",
      retry: "never",
    })
  })

  test("truncates error messages by UTF-8 bytes without splitting surrogates", () => {
    const dto = errorToWireError(
      new Error("😀".repeat(PROTOCOL_LIMITS.stringBytes)),
      {
        kind: "internal",
        code: "large",
        retry: "unknown",
      },
    )
    expect(
      new TextEncoder().encode(dto.message).byteLength,
    ).toBeLessThanOrEqual(PROTOCOL_LIMITS.stringBytes)
    expect(dto.message.endsWith("😀")).toBe(true)
  })
})

describe("protocol fences", () => {
  test("rejects sequence gaps and duplicate terminal frames", () => {
    const sequenceFence = new ProtocolFence({ generation })
    expect(protocolCode(() => sequenceFence.accept(request(1)))).toBe(
      "out-of-order",
    )

    const terminalFence = new ProtocolFence({ generation })
    terminalFence.accept(request())
    terminalFence.accept(result())
    expect(protocolCode(() => terminalFence.accept(result(2)))).toBe(
      "duplicate-terminal",
    )
  })

  test("requires contiguous state revisions after a snapshot", () => {
    const fence = new ProtocolFence({ generation })
    fence.accept(
      frame({
        generation,
        id: "snapshot",
        seq: 0,
        revision: 4,
        type: "snapshot",
        payload: { controlEpoch: 2, inventory: "inventory-1", snapshot: {} },
      }),
    )
    const event = frame<StateEventFrame>({
      generation,
      id: "event",
      seq: 1,
      revision: 6,
      type: "state-event",
      payload: { event: {} },
    })
    expect(protocolCode(() => fence.accept(event))).toBe("out-of-order")
  })

  test("requires spend acknowledgment before terminal completion", () => {
    const fence = new ProtocolFence({ generation })
    fence.accept(request())
    fence.accept(
      frame<SpendFrame>({
        generation,
        id: "spend",
        seq: 1,
        type: "spend",
        callId: "call-1",
        payload: {
          invocationId: "invocation-1",
          providerCallId: "provider-call-1",
          amount: 10,
          unit: "nano_aiu",
        },
      }),
    )
    expect(protocolCode(() => fence.accept(result(2)))).toBe("out-of-order")

    const acknowledged = new ProtocolFence({ generation })
    acknowledged.accept(request())
    acknowledged.accept(
      frame<SpendFrame>({
        generation,
        id: "spend",
        seq: 1,
        type: "spend",
        callId: "call-1",
        payload: {
          invocationId: "invocation-1",
          providerCallId: "provider-call-1",
          amount: 10,
          unit: "nano_aiu",
        },
      }),
    )
    acknowledged.accept(
      frame<SpendAckFrame>({
        generation,
        id: "ack",
        seq: 2,
        type: "spend-ack",
        callId: "call-1",
        payload: {
          invocationId: "invocation-1",
          providerCallId: "provider-call-1",
        },
      }),
    )
    acknowledged.accept(result(3))
  })

  test("tracks two provider calls under one spend invocation independently", () => {
    const fence = new ProtocolFence({ generation })
    fence.accept(request())
    for (const [index, providerCallId] of [
      "provider-1",
      "provider-2",
    ].entries()) {
      const sequence = index * 2 + 1
      fence.accept(
        frame<SpendFrame>({
          generation,
          id: `spend-${index}`,
          seq: sequence,
          type: "spend",
          callId: "call-1",
          payload: {
            invocationId: "invocation-1",
            providerCallId,
            amount: index + 1,
            unit: "nano_aiu",
          },
        }),
      )
      fence.accept(
        frame<SpendAckFrame>({
          generation,
          id: `ack-${index}`,
          seq: sequence + 1,
          type: "spend-ack",
          callId: "call-1",
          payload: { invocationId: "invocation-1", providerCallId },
        }),
      )
    }
    fence.accept(result(5))
  })

  test("rejects terminal-kind and reverse-RPC correlation mismatches", () => {
    const wrongKind = new ProtocolFence({ generation })
    wrongKind.accept(
      frame({
        generation,
        id: "provider-request",
        seq: 0,
        type: "provider-request",
        callId: "provider-call",
        payload: {
          providerCallId: "provider-correlation",
          method: "fetch",
          params: null,
        },
      }),
    )
    expect(
      protocolCode(() => wrongKind.accept(result(1, "provider-call"))),
    ).toBe("out-of-order")

    const correlation = new ProtocolFence({ generation })
    correlation.accept(
      frame({
        generation,
        id: "host-request",
        seq: 0,
        type: "host-request",
        callId: "host-call",
        payload: {
          hostCallId: "host-correlation",
          method: "settings",
          params: null,
        },
      }),
    )
    expect(
      protocolCode(() =>
        correlation.accept(
          frame({
            generation,
            id: "host-result",
            seq: 1,
            type: "host-result",
            callId: "host-call",
            payload: { hostCallId: "changed", value: null },
          }),
        ),
      ),
    ).toBe("out-of-order")
  })

  test("rejects spend replay after acknowledgment", () => {
    const fence = new ProtocolFence({ generation })
    fence.accept(request())
    const spend = frame<SpendFrame>({
      generation,
      id: "spend",
      seq: 1,
      type: "spend",
      callId: "call-1",
      payload: {
        invocationId: "once",
        providerCallId: "provider-call-once",
        amount: 1,
        unit: "nano_aiu",
      },
    })
    fence.accept(spend)
    fence.accept(
      frame<SpendAckFrame>({
        generation,
        id: "ack",
        seq: 2,
        type: "spend-ack",
        callId: "call-1",
        payload: {
          invocationId: "once",
          providerCallId: "provider-call-once",
        },
      }),
    )
    expect(
      protocolCode(() => fence.accept({ ...spend, id: "replay", seq: 3 })),
    ).toBe("out-of-order")
  })

  test("rejects snapshot revision and control epoch rollback", () => {
    const fence = new ProtocolFence({ generation })
    fence.accept(
      frame({
        generation,
        id: "snapshot-1",
        seq: 0,
        revision: 5,
        type: "snapshot",
        payload: { controlEpoch: 4, inventory: "inventory", snapshot: {} },
      }),
    )
    expect(
      protocolCode(() =>
        fence.accept(
          frame({
            generation,
            id: "snapshot-2",
            seq: 1,
            revision: 4,
            type: "snapshot",
            payload: { controlEpoch: 4, inventory: "inventory", snapshot: {} },
          }),
        ),
      ),
    ).toBe("out-of-order")
  })

  test("allows cancellation before exactly one terminal result", () => {
    const fence = new ProtocolFence({ generation })
    fence.accept(request())
    fence.accept(
      frame<CancelFrame>({
        generation,
        id: "cancel",
        seq: 1,
        type: "cancel",
        callId: "call-1",
        payload: { reason: "client disconnected" },
      }),
    )
    fence.accept(
      frame({
        generation,
        id: "aborted",
        seq: 2,
        type: "error",
        callId: "call-1",
        payload: {
          error: {
            kind: "aborted",
            code: "aborted",
            message: "Aborted",
            retry: "never",
          },
        },
      }),
    )
    expect(protocolCode(() => fence.accept(result(3)))).toBe(
      "duplicate-terminal",
    )
  })
})

describe("in-memory loopback transport", () => {
  test("matches the normalized direct-adapter transcript", () => {
    const direct = [
      { type: "progress", payload: { progress: 1, total: 1 } },
      { type: "result", payload: { value: { ok: true } } },
    ]
    const { parent, runner } = createLoopbackTransportPair({ generation })
    runner.subscribe((incoming) => {
      if (incoming.type !== "request") return
      runner.send(
        frame<ProgressFrame>({
          generation,
          id: "progress",
          seq: 0,
          type: "progress",
          callId: "call-1",
          payload: { progress: 1, total: 1 },
        }),
      )
      runner.send(result(1))
    })

    parent.send(request())

    expect(
      JSON.stringify(
        parent.transcript.map(({ type, payload }) => ({ type, payload })),
      ),
    ).toBe(JSON.stringify(direct))
  })

  test("is duplex, reentrant, cloned, and transcript preserving", () => {
    const { parent, runner } = createLoopbackTransportPair({ generation })
    const received: Array<string> = []

    runner.subscribe((incoming) => {
      received.push(`runner:${incoming.type}`)
      runner.send(result(0))
    })
    parent.subscribe((incoming) => {
      received.push(`parent:${incoming.type}`)
    })

    const sent = request()
    parent.send(sent)
    sent.payload.params = { changed: true }

    expect(received).toEqual(["runner:request", "parent:result"])
    expect(runner.transcript[0]).toMatchObject({
      type: "request",
      payload: { params: { input: true } },
    })
    expect(parent.transcript).toEqual([result(0)])
  })

  test("allows identical call IDs in opposite directions without collision", () => {
    const { parent, runner } = createLoopbackTransportPair({ generation })
    parent.send(request(0, "same-id"))
    runner.send(request(0, "same-id"))
    runner.send(result(1, "same-id"))
    parent.send(result(1, "same-id"))
    expect(parent.transcript.map((entry) => entry.type)).toEqual([
      "request",
      "result",
    ])
    expect(runner.transcript.map((entry) => entry.type)).toEqual([
      "request",
      "result",
    ])
  })

  test("round-trips progress and cancellation before terminal completion", () => {
    const { parent, runner } = createLoopbackTransportPair({ generation })
    runner.subscribe((incoming) => {
      if (incoming.type !== "request") return
      runner.send(
        frame<ProgressFrame>({
          generation,
          id: "progress",
          seq: 0,
          type: "progress",
          callId: "call-1",
          payload: { progress: 1, total: 2 },
        }),
      )
    })
    parent.send(request())
    parent.send(
      frame<CancelFrame>({
        generation,
        id: "cancel",
        seq: 1,
        type: "cancel",
        callId: "call-1",
        payload: {},
      }),
    )
    runner.send(
      frame({
        generation,
        id: "error",
        seq: 1,
        type: "error",
        callId: "call-1",
        payload: {
          error: {
            kind: "aborted",
            code: "aborted",
            message: "Aborted",
            retry: "never",
          },
        },
      }),
    )
    expect(parent.transcript.map((entry) => entry.type)).toEqual([
      "progress",
      "error",
    ])
    expect(runner.transcript.map((entry) => entry.type)).toEqual([
      "request",
      "cancel",
    ])
  })
})
