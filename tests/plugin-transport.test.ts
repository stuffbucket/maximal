/* eslint-disable max-lines-per-function -- transport scenario matrices share paired endpoints */
import {
  PLUGIN_API_VERSION,
  PLUGIN_PROTOCOL_VERSION,
  frame,
} from "@stuffbucket/maximal-plugin-protocol"
import { describe, expect, test } from "bun:test"

import {
  BunIpcTransport,
  DuplexRpcDispatcher,
  FairBoundedQueue,
  QueueOverflowError,
  createInMemoryIpcPair,
  type IpcPort,
} from "~/lib/plugins/transport"

const generation = "generation-1"
const nonce = "nonce-0123456789"

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject.")
}

async function pair(
  options: {
    heartbeatTimeoutMs?: number
    queueLimits?: { maxMessages: number; maxBytes: number }
  } = {},
) {
  const ports = createInMemoryIpcPair()
  const errors: Array<Error> = []
  const parent = new BunIpcTransport(ports.parent, {
    role: "parent",
    generation,
    nonce,
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 0,
    queueLimits: options.queueLimits,
    onProtocolError: (error) => errors.push(error),
  })
  const runner = new BunIpcTransport(ports.runner, {
    role: "runner",
    generation,
    nonce,
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 0,
    queueLimits: options.queueLimits,
    onProtocolError: (error) => errors.push(error),
  })
  await Promise.all([parent.connected, runner.connected])
  return { ports, parent, runner, errors }
}

function rawFrame(options: {
  sequence: number
  type: "result" | "error"
  callId: string
  payload: object
  generation?: string
}) {
  return frame({
    generation: options.generation ?? generation,
    id: `raw-${options.sequence}`,
    seq: options.sequence,
    type: options.type,
    callId: options.callId,
    payload: options.payload,
  })
}

async function tick(): Promise<void> {
  await Bun.sleep(0)
}

function noopSubscription(): () => void {
  return () => undefined
}

describe("plugin IPC transport", () => {
  test("requires an exact nonce before accepting protocol frames", async () => {
    const ports = createInMemoryIpcPair()
    const parent = new BunIpcTransport(ports.parent, {
      role: "parent",
      generation,
      nonce,
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
    })
    void parent.connected.catch(() => undefined)
    const runner = new BunIpcTransport(ports.runner, {
      role: "runner",
      generation,
      nonce: "wrong-nonce",
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
    })
    expect(String(await rejection(runner.connected))).toContain("handshake")
    parent.close()
  })

  test("rejects malformed, stale, oversized, and sequence-gap frames", async () => {
    for (const invalid of [
      { nope: true },
      rawFrame({
        sequence: 0,
        type: "result",
        callId: "x",
        payload: { value: null },
        generation: "stale-generation",
      }),
      rawFrame({
        sequence: 2,
        type: "result",
        callId: "x",
        payload: { value: null },
      }),
      rawFrame({
        sequence: 0,
        type: "result",
        callId: "x",
        payload: { value: "x".repeat(1024 * 1024) },
      }),
    ]) {
      const { ports, parent, runner, errors } = await pair()
      ports.parent.inject(invalid)
      await tick()
      expect(parent.closed).toBe(true)
      expect(errors).toHaveLength(1)
      runner.close()
    }
  })

  test("bounds queues and services every priority class", async () => {
    const queue = new FairBoundedQueue<string>(
      { maxMessages: 13, maxBytes: 13 },
      { control: 8, interactive: 4, bulk: 1 },
    )
    const pending: Array<Promise<void>> = []
    for (let index = 0; index < 8; index += 1) {
      pending.push(queue.enqueue(`c${index}`, 1, "control"))
    }
    for (let index = 0; index < 4; index += 1) {
      pending.push(queue.enqueue(`i${index}`, 1, "interactive"))
    }
    pending.push(queue.enqueue("bulk", 1, "bulk"))
    expect(
      await rejection(queue.enqueue("overflow", 1, "bulk")),
    ).toBeInstanceOf(QueueOverflowError)
    const order: Array<string> = []
    while (queue.size > 0) {
      const entry = queue.shift()
      if (!entry) break
      order.push(entry.value)
      entry.delivered()
    }
    await Promise.all(pending)
    expect(order.indexOf("bulk")).toBeLessThanOrEqual(12)
  })

  test("backpressures slow readers and fails closed on queue overflow", async () => {
    const slow = await pair({
      queueLimits: { maxMessages: 2, maxBytes: 16 * 1024 },
    })
    const received: Array<{ type: string; seq: number }> = []
    slow.runner.subscribe((frame) => {
      received.push({ type: frame.type, seq: frame.seq })
    })
    slow.ports.runner.pause()
    await slow.parent.send({
      type: "heartbeat",
      payload: { monotonicMs: 1, inflight: 0 },
    })
    let bulkSettled = false
    const bulk = slow.parent
      .send({
        type: "state-event",
        revision: 0,
        payload: { event: null },
      })
      .then(() => {
        bulkSettled = true
      })
    const control = slow.parent.send({
      type: "heartbeat",
      payload: { monotonicMs: 2, inflight: 0 },
    })
    await tick()
    expect(bulkSettled).toBe(false)
    slow.ports.runner.resume()
    await Promise.all([bulk, control])
    await tick()
    expect(received).toEqual([
      { type: "heartbeat", seq: 0 },
      { type: "heartbeat", seq: 1 },
      { type: "state-event", seq: 2 },
    ])
    slow.parent.close()
    slow.runner.close()

    const overloaded = await pair({
      queueLimits: { maxMessages: 1, maxBytes: 16 * 1024 },
    })
    overloaded.ports.runner.pause()
    await overloaded.parent.send({
      type: "heartbeat",
      payload: { monotonicMs: 1, inflight: 0 },
    })
    const blocked = overloaded.parent.send({
      type: "heartbeat",
      payload: { monotonicMs: 2, inflight: 0 },
    })
    void blocked.catch(() => undefined)
    expect(
      await rejection(
        overloaded.parent.send({
          type: "heartbeat",
          payload: { monotonicMs: 3, inflight: 0 },
        }),
      ),
    ).toBeInstanceOf(QueueOverflowError)
    expect(overloaded.parent.closed).toBe(true)
    expect(await rejection(blocked)).toBeInstanceOf(QueueOverflowError)
    overloaded.runner.close()
  })

  test("settles a hanging port write when the transport closes", async () => {
    const port: IpcPort = {
      send: () => new Promise<boolean>(() => undefined),
      onMessage: noopSubscription,
      onDisconnect: noopSubscription,
    }
    const transport = new BunIpcTransport(port, {
      role: "parent",
      generation,
      nonce,
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
    })
    void transport.connected.catch(() => undefined)
    transport.close("closed during write")
    expect(String(await rejection(transport.connected))).toContain(
      "closed during write",
    )
  })

  test("rejects the shifted frame when its port write fails", async () => {
    const ports = createInMemoryIpcPair()
    let failWrites = false
    const parentPort: IpcPort = {
      send: (message) =>
        failWrites ?
          Promise.reject(new Error("write failed"))
        : ports.parent.send(message),
      onMessage: (listener) => ports.parent.onMessage(listener),
      onDisconnect: (listener) => ports.parent.onDisconnect(listener),
      onDrain: (listener) =>
        ports.parent.onDrain?.(listener) ?? (() => undefined),
      disconnect: () => ports.parent.disconnect?.(),
    }
    const parent = new BunIpcTransport(parentPort, {
      role: "parent",
      generation,
      nonce,
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
    })
    const runner = new BunIpcTransport(ports.runner, {
      role: "runner",
      generation,
      nonce,
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
    })
    await Promise.all([parent.connected, runner.connected])

    failWrites = true
    expect(
      String(
        await rejection(
          parent.send({
            type: "heartbeat",
            payload: { monotonicMs: 1, inflight: 0 },
          }),
        ),
      ),
    ).toContain("write failed")
    expect(parent.closed).toBe(true)
    runner.close()
  })

  test("detects heartbeat timeout and parent disconnect", async () => {
    const timed = await pair({ heartbeatTimeoutMs: 20 })
    await Bun.sleep(35)
    expect(timed.parent.closed).toBe(true)
    expect(timed.errors[0]?.message).toContain("timed out")

    const disconnected = await pair()
    disconnected.ports.parent.disconnect?.()
    await tick()
    expect(disconnected.runner.closed).toBe(true)
  })
})

describe("duplex RPC dispatcher", () => {
  test("supports reentrant reverse RPC, progress, spend ack, and no leaks", async () => {
    const { parent, runner } = await pair()
    const spends: Array<{ providerCallId: string; amount: number }> = []
    const parentDispatcher = new DuplexRpcDispatcher(parent, "parent", {
      // eslint-disable-next-line max-params -- dispatcher spend event contract
      onSpend: (_callId, _invocationId, providerCallId, amount) => {
        spends.push({ providerCallId, amount })
      },
    })
    const runnerDispatcher = new DuplexRpcDispatcher(runner, "runner")
    parentDispatcher.register("provider", "catalog", (params) => ({
      echoed: params,
    }))
    runnerDispatcher.register("request", "run", async (params, context) => {
      await context.progress({ progress: 1, total: 2 })
      const provider = await context.callProvider("catalog", params)
      await context.reportSpend("spend-1", "provider-call-1", 7)
      await context.reportSpend("spend-1", "provider-call-2", 8)
      await context.reportSpend("spend-1", "provider-call-2", 8)
      return { provider }
    })
    const progress: Array<number> = []
    expect(
      await parentDispatcher.call(
        "run",
        { input: true },
        {
          onProgress: (event) => progress.push(event.progress),
        },
      ),
    ).toEqual({ provider: { echoed: { input: true } } })
    await tick()
    expect(progress).toEqual([1])
    expect(spends).toEqual([
      { providerCallId: "provider-call-1", amount: 7 },
      { providerCallId: "provider-call-2", amount: 8 },
    ])
    expect(parentDispatcher.inflight).toBe(0)
    expect(runnerDispatcher.inflight).toBe(0)
    parentDispatcher.dispose()
    runnerDispatcher.dispose()
  })

  test("fails closed when spend accounting is unavailable", async () => {
    const { parent, runner } = await pair()
    const parentDispatcher = new DuplexRpcDispatcher(parent, "parent")
    const runnerDispatcher = new DuplexRpcDispatcher(runner, "runner")
    runnerDispatcher.register("request", "spend", async (_params, context) => {
      await context.reportSpend("missing-accounting", "provider-call", 1)
      return null
    })
    expect(
      await rejection(parentDispatcher.call("spend", null)),
    ).toBeInstanceOf(Error)
    expect(parent.closed).toBe(true)
    parentDispatcher.dispose()
    runnerDispatcher.dispose()
  })

  test("turns invalid handler results into typed terminal errors", async () => {
    const { parent, runner } = await pair()
    const parentDispatcher = new DuplexRpcDispatcher(parent, "parent")
    const runnerDispatcher = new DuplexRpcDispatcher(runner, "runner")
    runnerDispatcher.register("request", "invalid", () => undefined)
    expect(
      String(await rejection(parentDispatcher.call("invalid", null))),
    ).toContain("non-JSON")
    expect(parent.closed).toBe(false)
    expect(runner.closed).toBe(false)
    parentDispatcher.dispose()
    runnerDispatcher.dispose()
  })

  test("orders multiple reverse provider calls with stable correlation IDs", async () => {
    const { parent, runner } = await pair()
    const parentDispatcher = new DuplexRpcDispatcher(parent, "parent")
    const runnerDispatcher = new DuplexRpcDispatcher(runner, "runner")
    parentDispatcher.register("provider", "fetch", async (params) => {
      if (params === 1) await Bun.sleep(2)
      return { params }
    })
    runnerDispatcher.register("request", "many", async (_params, context) => {
      const results = await Promise.all([
        context.callProvider("fetch", 1),
        context.callProvider("fetch", 2),
        context.callProvider("fetch", 3),
      ])
      return results
    })
    expect(await parentDispatcher.call("many", null)).toEqual([
      { params: 1 },
      { params: 2 },
      { params: 3 },
    ])
    expect(parent.stats.inboundMessages).toBeGreaterThanOrEqual(4)
    expect(runner.stats.inboundMessages).toBeGreaterThanOrEqual(4)
    parentDispatcher.dispose()
    runnerDispatcher.dispose()
  })

  test("makes cancellation races deterministic", async () => {
    const { parent, runner } = await pair()
    const parentDispatcher = new DuplexRpcDispatcher(parent, "parent")
    const runnerDispatcher = new DuplexRpcDispatcher(runner, "runner")
    let observedAbort = false
    runnerDispatcher.register("request", "slow", (_params, context) => {
      context.signal.addEventListener(
        "abort",
        () => {
          observedAbort = true
        },
        { once: true },
      )
      return new Promise<never>(() => undefined)
    })
    const controller = new AbortController()
    const pending = parentDispatcher.call("slow", null, {
      signal: controller.signal,
    })
    await tick()
    controller.abort("cancelled by test")
    expect(await rejection(pending)).toMatchObject({ name: "AbortError" })
    await tick()
    expect(observedAbort).toBe(true)
    expect(parentDispatcher.inflight).toBe(0)
    expect(runnerDispatcher.inflight).toBe(0)
    parentDispatcher.dispose()
    runnerDispatcher.dispose()
  })

  test("rejects duplicate terminals and closes only the bad runner channel", async () => {
    const { ports, parent, runner, errors } = await pair()
    const parentDispatcher = new DuplexRpcDispatcher(parent, "parent")
    const pending = parentDispatcher.call("manual", null)
    await tick()
    ports.parent.inject(
      rawFrame({
        sequence: 0,
        type: "result",
        callId: "parent:0",
        payload: { value: { ok: true } },
      }),
    )
    expect(await pending).toEqual({ ok: true })
    ports.parent.inject(
      rawFrame({
        sequence: 1,
        type: "result",
        callId: "parent:0",
        payload: { value: { twice: true } },
      }),
    )
    await tick()
    expect(parent.closed).toBe(true)
    expect(errors[0]?.message).toContain("already terminated")
    runner.close()
  })

  test("round-trips elicitation through the host service", async () => {
    const { parent, runner } = await pair()
    const parentDispatcher = new DuplexRpcDispatcher(parent, "parent")
    const runnerDispatcher = new DuplexRpcDispatcher(runner, "runner")
    parentDispatcher.register("host", "elicitation", () => ({
      action: "accept",
      content: { answer: 42 },
    }))
    runnerDispatcher.register("request", "ask", async (_params, context) => {
      return context.elicit("Continue?", { type: "object" })
    })
    expect(await parentDispatcher.call("ask", null)).toEqual({
      action: "accept",
      content: { answer: 42 },
    })
    parentDispatcher.dispose()
    runnerDispatcher.dispose()
  })
})

test("handshake constants remain exact", () => {
  expect(PLUGIN_PROTOCOL_VERSION).toBe(2)
  expect(PLUGIN_API_VERSION).toBe(1)
})
