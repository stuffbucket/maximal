/**
 * A BrokerSupervisor wired to fake broker processes, for the supervisor
 * tests: frames the fake writes, the state they lead to, and what the
 * supervisor sent back.
 */
import {
  ChildProcess,
  type ChildProcessWithoutNullStreams,
  type spawn,
} from "node:child_process"
import { PassThrough } from "node:stream"

import type { McpBrokerConfig } from "~/lib/mcp-broker/types"

import {
  CONTROL_PROTOCOL,
  CONTROL_PROTOCOL_VERSION,
} from "~/lib/mcp-broker/control-protocol"
import {
  BrokerSupervisor,
  getBrokerSupervisorSnapshot,
} from "~/lib/mcp-broker/supervisor"

export class FakeBrokerProcess extends ChildProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid: number
  readonly signals: Array<NodeJS.Signals> = []
  exitCode: number | null = null

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal)
    this.exitCode = 1
    queueMicrotask(() => this.emit("exit", 1, signal))
    return true
  }
}

export const config = (
  overrides: McpBrokerConfig["supervision"] = {},
): McpBrokerConfig => ({
  enabled: true,
  executablePath: "/fixture/maximal-mcp-broker",
  supervision: {
    startupTimeoutMs: 1_000,
    heartbeatIntervalMs: 10,
    heartbeatDeadlineMs: 100,
    gracefulShutdownMs: 1,
    restartBackoffMinMs: 1_000,
    restartBackoffMaxMs: 1_000,
    restartBudget: 5,
    restartWindowMs: 10_000,
    circuitResetMs: 10_000,
    ...overrides,
  },
  servers: [
    {
      id: "fixture",
      label: "Fixture",
      transport: { type: "stdio", command: "fixture" },
    },
  ],
})

export const frame = (
  header: { generation: string; sequence: number; requestId?: string },
  operation: string,
  payload: unknown,
): Uint8Array => {
  const { generation, sequence, requestId } = header
  const body = new TextEncoder().encode(
    JSON.stringify({
      protocol: CONTROL_PROTOCOL,
      version: CONTROL_PROTOCOL_VERSION,
      generation,
      sequence,
      deadlineMs: Date.now() + 10_000,
      operation,
      payload,
      ...(requestId ? { requestId } : {}),
    }),
  )
  const result = new Uint8Array(body.byteLength + 4)
  new DataView(result.buffer).setUint32(0, body.byteLength)
  result.set(body, 4)
  return result
}

export const waitForState = async (state: string): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (getBrokerSupervisorSnapshot().state === state) return
    await Bun.sleep(5)
  }
  throw new Error(
    `timed out waiting for ${state}; got ${getBrokerSupervisorSnapshot().state}`,
  )
}

export const waitForChildCount = async (
  children: Array<FakeBrokerProcess>,
  count: number,
): Promise<FakeBrokerProcess> => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const child = children.at(count - 1)
    if (child) return child
    await Bun.sleep(5)
  }
  throw new Error(`timed out waiting for broker process ${count}`)
}

export const waitForChild = (
  children: Array<FakeBrokerProcess>,
): Promise<FakeBrokerProcess> => waitForChildCount(children, 1)

export const fixture = (
  configuration: McpBrokerConfig = config(),
  overrides: Partial<ConstructorParameters<typeof BrokerSupervisor>[1]> = {},
) => {
  const children: Array<FakeBrokerProcess> = []
  const killedGroups: Array<number> = []
  let generationNumber = 0

  const supervisor = new BrokerSupervisor(configuration, {
    executableExists: () => true,
    forceKillProcessGroup: (pid) => {
      killedGroups.push(pid)
      return true
    },
    platform: "darwin",
    processPid: 99,
    randomBytes: (size) => Buffer.alloc(size, 1),
    randomUUID: () => `generation-${++generationNumber}`,
    spawnProcess: (() => {
      const child = new FakeBrokerProcess(40_000 + children.length)
      children.push(child)
      return child as unknown as ChildProcessWithoutNullStreams
    }) as unknown as typeof spawn,
    ...overrides,
  })

  return { children, killedGroups, supervisor }
}

export const readyPayload = {
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
      tools: ["accept_eula", "ask", "fetch"],
    },
  ],
}

export const sendReadyHandshake = (
  child: FakeBrokerProcess,
  generation: string,
): void => {
  child.stdout.write(
    frame({ generation: generation, sequence: 0 }, "hello", {
      binaryVersion: "0.0.0",
    }),
  )
  child.stdout.write(
    frame(
      { generation: generation, sequence: 1, requestId: "configure" },
      "response",
      { ok: true },
    ),
  )
  child.stdout.write(
    frame({ generation: generation, sequence: 2 }, "ready", readyPayload),
  )
}

export interface SentFrame {
  operation: string
  requestId?: string
  payload: { configuration?: { endpoints: Array<{ command: string }> } }
}

/** Frames the supervisor wrote to the fake broker, decoded. */
export const sentFrames = (child: FakeBrokerProcess): Array<SentFrame> => {
  const frames: Array<SentFrame> = []
  let buffered = Buffer.alloc(0)
  child.stdin.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.byteLength >= 4) {
      const length = buffered.readUInt32BE(0)
      if (buffered.byteLength < 4 + length) break
      frames.push(
        JSON.parse(buffered.subarray(4, 4 + length).toString()) as SentFrame,
      )
      buffered = buffered.subarray(4 + length)
    }
  })
  return frames
}

export const waitForFrame = async (
  frames: ReturnType<typeof sentFrames>,
  operation: string,
) => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const found = frames.find((f) => f.operation === operation)
    if (found) return found
    await Bun.sleep(5)
  }
  throw new Error(`timed out waiting for ${operation}`)
}

/** `config()` with the fixture endpoint's settings changed. */
export const withServer = (
  changes: Partial<NonNullable<McpBrokerConfig["servers"]>[number]>,
): McpBrokerConfig => {
  const base = config()
  return {
    ...base,
    servers: (base.servers ?? []).map((server) => ({ ...server, ...changes })),
  }
}

/** A supervisor whose broker has finished its handshake. */
export const ready = async () => {
  const harness = fixture()
  harness.supervisor.start()
  const child = await waitForChild(harness.children)
  const frames = sentFrames(child)
  sendReadyHandshake(child, "generation-1")
  await waitForState("ready")
  return { ...harness, child, frames }
}
