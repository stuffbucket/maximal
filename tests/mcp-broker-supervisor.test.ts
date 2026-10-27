import { describe, expect, test } from "bun:test"
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
import { PendingRequests } from "~/lib/mcp-broker/pending-requests"
import {
  BrokerSupervisor,
  getBrokerEndpointTools,
  getBrokerSupervisorSnapshot,
  getBrokerUpstream,
} from "~/lib/mcp-broker/supervisor"

class FakeBrokerProcess extends ChildProcess {
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

const config = (
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

const frame = (
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

const waitForState = async (state: string): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (getBrokerSupervisorSnapshot().state === state) return
    await Bun.sleep(5)
  }
  throw new Error(
    `timed out waiting for ${state}; got ${getBrokerSupervisorSnapshot().state}`,
  )
}

const waitForChildCount = async (
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

const waitForChild = (
  children: Array<FakeBrokerProcess>,
): Promise<FakeBrokerProcess> => waitForChildCount(children, 1)

const fixture = (
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

const readyPayload = {
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

const sendReadyHandshake = (
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

interface SentFrame {
  operation: string
  requestId?: string
  payload: { configuration?: { endpoints: Array<{ command: string }> } }
}

/** Frames the supervisor wrote to the fake broker, decoded. */
const sentFrames = (child: FakeBrokerProcess): Array<SentFrame> => {
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

const waitForFrame = async (
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
const withServer = (
  changes: Partial<NonNullable<McpBrokerConfig["servers"]>[number]>,
): McpBrokerConfig => {
  const base = config()
  return {
    ...base,
    servers: (base.servers ?? []).map((server) => ({ ...server, ...changes })),
  }
}

/** A supervisor whose broker has finished its handshake. */
const ready = async () => {
  const harness = fixture()
  harness.supervisor.start()
  const child = await waitForChild(harness.children)
  const frames = sentFrames(child)
  sendReadyHandshake(child, "generation-1")
  await waitForState("ready")
  return { ...harness, child, frames }
}

describe("BrokerSupervisor live updates", () => {
  test("a new command reaches the running broker without a restart", async () => {
    const { child, children, frames, supervisor } = await ready()
    const updated = supervisor.update(
      withServer({ transport: { type: "stdio", command: "/new/fixture" } }),
    )
    const sent = await waitForFrame(frames, "update")
    expect(sent.payload.configuration?.endpoints[0]?.command).toBe(
      "/new/fixture",
    )
    child.stdout.write(
      frame(
        { generation: "generation-1", sequence: 3, requestId: "update" },
        "response",
        { ok: true },
      ),
    )
    expect(await updated).toBe(true)
    expect(children).toHaveLength(1)
    expect(getBrokerSupervisorSnapshot().state).toBe("ready")
    await supervisor.stop()
  })

  test("a change to how the endpoint is served isn't sent; the caller restarts", async () => {
    const { frames, supervisor } = await ready()
    expect(
      await supervisor.update(
        withServer({ classification: { protocol: "modern" } }),
      ),
    ).toBe(false)
    expect(frames.some((f) => f.operation === "update")).toBe(false)
    await supervisor.stop()
  })

  test("the broker refusing an update reports false", async () => {
    const { child, frames, supervisor } = await ready()
    const updated = supervisor.update(
      withServer({ timeouts: { callMs: 5_000 } }),
    )
    await waitForFrame(frames, "update")
    child.stdout.write(
      frame(
        { generation: "generation-1", sequence: 3, requestId: "update" },
        "response",
        { ok: false, code: "RESTART_REQUIRED" },
      ),
    )
    expect(await updated).toBe(false)
    await supervisor.stop()
  })
})

const elicitPayload = (
  properties: Record<string, unknown> = {
    confirmed: { type: "boolean", title: "Confirm" },
  },
) => ({
  endpointId: "fixture",
  label: "Fixture",
  toolName: "get_debug_link",
  mechanism: "legacy-form",
  mode: "form",
  message: "Allow the debug link?",
  requestedSchema: { type: "object", properties, required: ["confirmed"] },
  expiresAtMs: Date.now() + 60_000,
})

const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(5)
  }
  throw new Error("timed out waiting")
}

/** A ready supervisor whose requests for input land in its own store. */
const readyWithRequests = async () => {
  const requests = new PendingRequests()
  const harness = fixture(config(), { requests })
  harness.supervisor.start()
  const child = await waitForChild(harness.children)
  const frames = sentFrames(child)
  sendReadyHandshake(child, "generation-1")
  await waitForState("ready")
  return { ...harness, child, frames, requests }
}

describe("BrokerSupervisor requests for user input", () => {
  test("shows a request and sends the answer back to the broker", async () => {
    const { child, frames, requests, supervisor } = await readyWithRequests()
    child.stdout.write(
      frame(
        { generation: "generation-1", sequence: 3, requestId: "elicit-1" },
        "elicit",
        elicitPayload(),
      ),
    )
    await waitFor(() => requests.list().requests.length === 1)
    expect(requests.list().requests[0]).toMatchObject({
      id: "elicit-1",
      label: "Fixture",
      toolName: "get_debug_link",
      fields: [{ name: "confirmed", kind: "boolean", required: true }],
    })

    expect(
      requests.answer("elicit-1", {
        action: "accept",
        content: { confirmed: true },
      }),
    ).toEqual({ ok: true })
    const sent = await waitForFrame(frames, "elicitResult")
    expect(sent).toMatchObject({
      requestId: "elicit-1",
      payload: { action: "accept", content: { confirmed: true } },
    })
    await supervisor.stop()
  })

  test("declines a form Maximal can't show", async () => {
    const { child, frames, requests, supervisor } = await readyWithRequests()
    child.stdout.write(
      frame(
        { generation: "generation-1", sequence: 3, requestId: "elicit-1" },
        "elicit",
        elicitPayload({ tags: { type: "array", items: { type: "string" } } }),
      ),
    )
    const sent = await waitForFrame(frames, "elicitResult")
    expect(sent).toMatchObject({
      requestId: "elicit-1",
      payload: { action: "decline" },
    })
    expect(requests.list().requests).toHaveLength(0)
    await supervisor.stop()
  })

  test("forgets withdrawn requests, and all of a generation's when it fails", async () => {
    const { child, requests, supervisor } = await readyWithRequests()
    for (const [sequence, requestId] of [
      [3, "elicit-1"],
      [4, "elicit-2"],
    ] as const) {
      child.stdout.write(
        frame(
          { generation: "generation-1", sequence, requestId },
          "elicit",
          elicitPayload(),
        ),
      )
    }
    child.stdout.write(
      frame(
        { generation: "generation-1", sequence: 5, requestId: "elicit-1" },
        "elicitWithdrawn",
        {},
      ),
    )
    await waitFor(
      () =>
        requests
          .list()
          .requests.map((request) => request.id)
          .join(",") === "elicit-2",
    )

    // An out-of-order frame fails the generation; its requests go with it.
    child.stdout.write(
      frame({ generation: "generation-1", sequence: 99 }, "heartbeat", {
        sentAtMs: Date.now(),
      }),
    )
    await waitFor(() => requests.list().requests.length === 0)
    await supervisor.stop()
  })
})

describe("BrokerSupervisor readiness", () => {
  test("waits for the handshake, then reports ready", async () => {
    const { children, supervisor } = fixture()
    supervisor.start()
    let settled: string | undefined
    const waiting = supervisor.waitUntilReady(2_000).then((readiness) => {
      settled = readiness
      return readiness
    })
    const child = await waitForChild(children)
    await Bun.sleep(20)
    expect(settled).toBeUndefined()

    sendReadyHandshake(child, "generation-1")
    expect(await waiting).toBe("ready")
    // Already ready: answers at once.
    expect(await supervisor.waitUntilReady(0)).toBe("ready")
    await supervisor.stop()
  })

  test("reports starting when the wait runs out first", async () => {
    const { supervisor } = fixture()
    supervisor.start()
    expect(await supervisor.waitUntilReady(30)).toBe("starting")
    await supervisor.stop()
  })

  test("reports failed when the broker can't run, off when disabled", async () => {
    const missing = fixture(config(), { executableExists: () => false })
    missing.supervisor.start()
    expect(await missing.supervisor.waitUntilReady(2_000)).toBe("failed")
    await missing.supervisor.stop()

    const disabled = fixture({ ...config(), enabled: false })
    disabled.supervisor.start()
    expect(await disabled.supervisor.waitUntilReady(2_000)).toBe("off")
  })

  test("reports failed once restarts open the circuit", async () => {
    const supervisor = new BrokerSupervisor(
      config({
        restartBackoffMinMs: 5,
        restartBackoffMaxMs: 5,
        restartBudget: 1,
        restartWindowMs: 1_000,
        circuitResetMs: 1_000,
      }),
      {
        executableExists: () => true,
        platform: "darwin",
        randomBytes: (size) => Buffer.alloc(size),
        spawnProcess: (() => {
          throw new Error("fixture spawn failure")
        }) as unknown as typeof spawn,
      },
    )
    supervisor.start()
    expect(await supervisor.waitUntilReady(2_000)).toBe("failed")
    await supervisor.stop()
  })
})

describe("BrokerSupervisor launches that can't succeed", () => {
  test("stops as unavailable/not-installed when the executable is missing", async () => {
    const { children, supervisor } = fixture(config(), {
      executableExists: () => false,
    })
    supervisor.start()
    expect(getBrokerSupervisorSnapshot()).toMatchObject({
      state: "unavailable",
      problem: "not-installed",
    })
    // No retry loop: nothing spawns and the state holds.
    await Bun.sleep(50)
    expect(children).toHaveLength(0)
    expect(getBrokerSupervisorSnapshot().state).toBe("unavailable")
    await supervisor.stop()
  })
})

describe("BrokerSupervisor isolation", () => {
  test("exposes the upstream only after the complete handshake", async () => {
    const { children, supervisor } = fixture()
    supervisor.start()
    supervisor.start()
    expect(getBrokerSupervisorSnapshot().state).toBe("starting")
    expect(getBrokerUpstream()).toBeUndefined()

    sendReadyHandshake(await waitForChild(children), "generation-1")
    expect(children).toHaveLength(1)
    await waitForState("ready")

    expect(getBrokerUpstream()).toEqual({
      origin: "http://127.0.0.1:49152",
      apiKey: Buffer.alloc(32, 1).toString("base64url"),
    })
    await supervisor.stop()
    expect(getBrokerUpstream()).toBeUndefined()
  })

  test("records the tools each endpoint offered, until the broker stops", async () => {
    const { children, supervisor } = fixture()
    supervisor.start()
    expect(getBrokerEndpointTools("fixture")).toBeUndefined()
    sendReadyHandshake(await waitForChild(children), "generation-1")
    await waitForState("ready")
    expect(getBrokerEndpointTools("fixture")).toEqual([
      "accept_eula",
      "ask",
      "fetch",
    ])
    await supervisor.stop()
    expect(getBrokerEndpointTools("fixture")).toBeUndefined()
  })

  test("passes the broker's stderr on line by line", async () => {
    const lines: Array<string> = []
    const { children, supervisor } = fixture(config(), {
      onStderrLine: (line) => lines.push(line),
    })
    supervisor.start()
    const child = await waitForChild(children)
    child.stderr.write("[endpoint:fixture] Failed to fetch ")
    child.stderr.write("remote tools\n[maximal-mcp-broker] CODE\n")
    await Bun.sleep(5)
    expect(lines).toEqual([
      "[endpoint:fixture] Failed to fetch remote tools",
      "[maximal-mcp-broker] CODE",
    ])
    await supervisor.stop()
  })

  test("withdraws the upstream when a ready generation fails", async () => {
    const { children, supervisor } = fixture()
    supervisor.start()
    const child = await waitForChild(children)
    sendReadyHandshake(child, "generation-1")
    await waitForState("ready")
    expect(getBrokerUpstream()).toBeDefined()

    child.stdout.write(
      frame({ generation: "generation-1", sequence: 3 }, "ready", readyPayload),
    )
    await waitForState("backoff")
    expect(getBrokerUpstream()).toBeUndefined()
    await supervisor.stop()
  })

  test("reaps a generation that sends an oversized IPC frame", async () => {
    const { children, killedGroups, supervisor } = fixture()
    supervisor.start()

    const oversized = new Uint8Array(4)
    const child = await waitForChild(children)
    new DataView(oversized.buffer).setUint32(0, 1_048_577)
    child.stdout.write(oversized)

    await waitForState("backoff")
    expect(killedGroups).toEqual([40_000])
    await supervisor.stop()
  })

  test("reaps a generation with an out-of-order sequence", async () => {
    const { children, killedGroups, supervisor } = fixture()
    supervisor.start()
    const child = await waitForChild(children)
    child.stdout.write(
      frame({ generation: "generation-1", sequence: 1 }, "hello", {
        binaryVersion: "0.0.0",
      }),
    )

    await waitForState("backoff")
    expect(killedGroups).toEqual([40_000])
    await supervisor.stop()
  })

  test("reaps a generation that claims a different generation id", async () => {
    const { children, killedGroups, supervisor } = fixture()
    supervisor.start()
    const child = await waitForChild(children)
    child.stdout.write(
      frame({ generation: "generation-stale", sequence: 0 }, "hello", {
        binaryVersion: "0.0.0",
      }),
    )

    await waitForState("backoff")
    expect(killedGroups).toEqual([40_000])
    await supervisor.stop()
  })

  test("reaps a generation that repeats hello", async () => {
    const { children, killedGroups, supervisor } = fixture()
    supervisor.start()
    const child = await waitForChild(children)
    child.stdout.write(
      frame({ generation: "generation-1", sequence: 0 }, "hello", {
        binaryVersion: "0.0.0",
      }),
    )
    child.stdout.write(
      frame({ generation: "generation-1", sequence: 1 }, "hello", {
        binaryVersion: "0.0.0",
      }),
    )

    await waitForState("backoff")
    expect(killedGroups).toEqual([40_000])
    await supervisor.stop()
  })

  test("reaps a generation that repeats ready", async () => {
    const { children, killedGroups, supervisor } = fixture()
    supervisor.start()
    const child = await waitForChild(children)
    sendReadyHandshake(child, "generation-1")
    await waitForState("ready")
    child.stdout.write(
      frame({ generation: "generation-1", sequence: 3 }, "ready", readyPayload),
    )

    await waitForState("backoff")
    expect(killedGroups).toEqual([40_000])
    await supervisor.stop()
  })

  test("reaps a generation that sends an unsolicited response", async () => {
    const { children, killedGroups, supervisor } = fixture()
    supervisor.start()
    const child = await waitForChild(children)
    child.stdout.write(
      frame({ generation: "generation-1", sequence: 0 }, "hello", {
        binaryVersion: "0.0.0",
      }),
    )
    child.stdout.write(
      frame(
        { generation: "generation-1", sequence: 1, requestId: "unexpected" },
        "response",
        { ok: true },
      ),
    )

    await waitForState("backoff")
    expect(killedGroups).toEqual([40_000])
    await supervisor.stop()
  })

  test("rejects readiness that omits a configured endpoint", async () => {
    const { children, killedGroups, supervisor } = fixture()
    supervisor.start()
    const child = await waitForChild(children)
    child.stdout.write(
      frame({ generation: "generation-1", sequence: 0 }, "hello", {
        binaryVersion: "0.0.0",
      }),
    )
    child.stdout.write(
      frame(
        { generation: "generation-1", sequence: 1, requestId: "configure" },
        "response",
        { ok: true },
      ),
    )
    child.stdout.write(
      frame({ generation: "generation-1", sequence: 2 }, "ready", {
        host: "127.0.0.1",
        port: 49_152,
        endpoints: [],
      }),
    )

    await waitForState("backoff")
    expect(killedGroups).toEqual([40_000])
    await supervisor.stop()
  })
})

describe("BrokerSupervisor liveness and restarts", () => {
  test("reaps a generation that misses its startup deadline", async () => {
    const { children, killedGroups, supervisor } = fixture(
      config({
        startupTimeoutMs: 20,
        restartBackoffMinMs: 1_000,
        restartBackoffMaxMs: 1_000,
      }),
    )
    supervisor.start()
    await waitForChild(children)
    await waitForState("backoff")

    expect(killedGroups).toEqual([40_000])
    await supervisor.stop()
  })

  test("detects a heartbeat hang after readiness", async () => {
    const { children, killedGroups, supervisor } = fixture(
      config({
        heartbeatIntervalMs: 5,
        heartbeatDeadlineMs: 20,
        restartBackoffMinMs: 1_000,
        restartBackoffMaxMs: 1_000,
      }),
    )
    supervisor.start()
    sendReadyHandshake(await waitForChild(children), "generation-1")
    await waitForState("ready")
    await waitForState("backoff")

    expect(killedGroups).toEqual([40_000])
    await supervisor.stop()
  })

  test("detects a heartbeat hang after a degraded status", async () => {
    const { children, killedGroups, supervisor } = fixture(
      config({
        heartbeatIntervalMs: 5,
        heartbeatDeadlineMs: 20,
        restartBackoffMinMs: 1_000,
        restartBackoffMaxMs: 1_000,
      }),
    )
    supervisor.start()
    const child = await waitForChild(children)
    sendReadyHandshake(child, "generation-1")
    await waitForState("ready")
    child.stdout.write(
      frame({ generation: "generation-1", sequence: 3 }, "status", {
        state: "degraded",
      }),
    )
    await waitForState("degraded")
    await waitForState("backoff")

    expect(killedGroups).toEqual([40_000])
    await supervisor.stop()
  })

  test("resets restart accounting after a stable runtime", async () => {
    const { children, killedGroups, supervisor } = fixture(
      config({
        heartbeatDeadlineMs: 1_000,
        restartBackoffMinMs: 20,
        restartBackoffMaxMs: 20,
        restartBudget: 1,
        restartWindowMs: 1_000,
        circuitResetMs: 60,
      }),
    )
    supervisor.start()
    const first = await waitForChildCount(children, 1)
    sendReadyHandshake(first, "generation-1")
    await waitForState("ready")
    first.stdout.write(
      frame({ generation: "generation-1", sequence: 4 }, "heartbeat", {
        sentAtMs: Date.now(),
      }),
    )
    await waitForState("backoff")

    const second = await waitForChildCount(children, 2)
    sendReadyHandshake(second, "generation-2")
    await waitForState("ready")
    await Bun.sleep(75)
    second.stdout.write(
      frame({ generation: "generation-2", sequence: 4 }, "heartbeat", {
        sentAtMs: Date.now(),
      }),
    )
    await waitForState("backoff")

    expect(killedGroups).toEqual([40_000, 40_001])
    await supervisor.stop()
  })

  test("keeps Windows fail-closed before broker spawn", async () => {
    let spawnCalls = 0
    const supervisor = new BrokerSupervisor(
      config({
        restartBackoffMinMs: 1_000,
        restartBackoffMaxMs: 1_000,
      }),
      {
        executableExists: () => true,
        platform: "win32",
        spawnProcess: (() => {
          spawnCalls += 1
          throw new Error("Windows must not spawn without containment")
        }) as unknown as typeof spawn,
      },
    )

    supervisor.start()
    // Fail-closed and final: no spawn, and no restart loop either — a restart
    // can't add containment, so the UI is told it's unsupported instead.
    await waitForState("unavailable")
    expect(getBrokerSupervisorSnapshot().problem).toBe("unsupported-platform")
    expect(spawnCalls).toBe(0)
    expect(getBrokerUpstream()).toBeUndefined()
    await supervisor.stop()
  })

  test("opens the circuit after the configured restart budget", async () => {
    const configuration = config({
      restartBackoffMinMs: 5,
      restartBackoffMaxMs: 5,
      restartBudget: 2,
      restartWindowMs: 1_000,
      circuitResetMs: 1_000,
    })
    let attempts = 0
    const supervisor = new BrokerSupervisor(configuration, {
      executableExists: () => true,
      platform: "darwin",
      randomBytes: (size) => Buffer.alloc(size),
      randomUUID: () => `generation-${++attempts}`,
      spawnProcess: (() => {
        throw new Error("fixture spawn failure")
      }) as unknown as typeof spawn,
    })

    supervisor.start()
    await waitForState("circuit-open")
    expect(attempts).toBe(3)
    await supervisor.stop()
  })
})
