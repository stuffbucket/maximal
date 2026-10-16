import { expect, it } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { resolve } from "node:path"

import {
  CONTROL_PROTOCOL,
  CONTROL_PROTOCOL_VERSION,
  ControlFrameDecoder,
  type ControlEnvelope,
  encodeControlEnvelope,
} from "../src/control-protocol.ts"
import { BrokerWireConfigurationSchema } from "../src/wire-config.ts"

const GENERATION = "serve-test-generation"
const API_KEY = "serve-test-key-that-is-longer-than-32-bytes"

class EnvelopeQueue {
  readonly #envelopes: Array<ControlEnvelope> = []
  readonly #waiters = new Set<() => void>()

  push(envelopes: Array<ControlEnvelope>): void {
    this.#envelopes.push(...envelopes)
    for (const wake of this.#waiters) {
      wake()
    }
    this.#waiters.clear()
  }

  async take(
    operation: ControlEnvelope["operation"],
  ): Promise<ControlEnvelope> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const index = this.#envelopes.findIndex(
        (envelope) => envelope.operation === operation,
      )
      if (index !== -1) {
        return this.#envelopes.splice(index, 1)[0]
      }

      await new Promise<void>((resolveWake) => {
        const timer = setTimeout(() => {
          this.#waiters.delete(wake)
          resolveWake()
        }, 100)
        const wake = () => {
          clearTimeout(timer)
          resolveWake()
        }
        this.#waiters.add(wake)
      })
    }

    throw new Error(`Timed out waiting for ${operation}`)
  }
}

const writeEnvelope = (
  child: ChildProcessWithoutNullStreams,
  envelope: ControlEnvelope,
): void => {
  child.stdin.write(encodeControlEnvelope(envelope))
}

it("handshakes, reports readiness, takes updates, and shuts down over framed IPC", async () => {
  const child = spawn(
    process.execPath,
    [
      resolve(import.meta.dir, "../src/main.ts"),
      "serve",
      "--generation",
      GENERATION,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  )
  const decoder = new ControlFrameDecoder()
  const queue = new EnvelopeQueue()
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => queue.push(decoder.push(chunk)))
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4096)
  })

  try {
    const hello = await queue.take("hello")
    expect(hello).toMatchObject({
      generation: GENERATION,
      sequence: 0,
      payload: { binaryVersion: "0.0.0" },
    })

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
    writeEnvelope(child, {
      protocol: CONTROL_PROTOCOL,
      version: CONTROL_PROTOCOL_VERSION,
      generation: GENERATION,
      sequence: 0,
      deadlineMs: Date.now() + 10_000,
      requestId: "configure-1",
      operation: "configure",
      payload: { apiKey: API_KEY, configuration },
    })

    expect(await queue.take("response")).toMatchObject({
      requestId: "configure-1",
      payload: { ok: true },
    })
    const ready = await queue.take("ready")
    expect(ready).toMatchObject({
      payload: { host: "127.0.0.1" },
    })
    if (ready.operation !== "ready") {
      throw new Error("Expected ready envelope")
    }
    expect(ready.payload.port).toBeGreaterThan(0)
    expect(await queue.take("status")).toMatchObject({
      payload: { state: "ready" },
    })

    // A live update to how new sessions start is taken; one that changes
    // how the endpoint is served is refused, and the broker keeps running.
    const update = (sequence: number, protocol: "legacy" | "auto") =>
      writeEnvelope(child, {
        protocol: CONTROL_PROTOCOL,
        version: CONTROL_PROTOCOL_VERSION,
        generation: GENERATION,
        sequence,
        deadlineMs: Date.now() + 10_000,
        requestId: `update-${sequence}`,
        operation: "update",
        payload: {
          configuration: {
            ...configuration,
            endpoints: configuration.endpoints.map((endpoint) => ({
              ...endpoint,
              protocol,
              callTimeoutMs: 60_000,
            })),
          },
        },
      })
    update(1, "legacy")
    expect(await queue.take("response")).toMatchObject({
      requestId: "update-1",
      payload: { ok: true },
    })
    update(2, "auto")
    expect(await queue.take("response")).toMatchObject({
      requestId: "update-2",
      payload: { ok: false, code: "RESTART_REQUIRED" },
    })

    writeEnvelope(child, {
      protocol: CONTROL_PROTOCOL,
      version: CONTROL_PROTOCOL_VERSION,
      generation: GENERATION,
      sequence: 3,
      deadlineMs: Date.now() + 10_000,
      requestId: "shutdown-1",
      operation: "shutdown",
      payload: {},
    })
    expect(await queue.take("response")).toMatchObject({
      requestId: "shutdown-1",
      payload: { ok: true },
    })

    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.once("exit", resolveExit)
    })
    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    decoder.finish()
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL")
    }
  }
})
