import { describe, expect, test } from "bun:test"
import { type spawn } from "node:child_process"

import { PendingRequests } from "~/lib/mcp-broker/pending-requests"
import {
  BrokerSupervisor,
  getBrokerEndpointTools,
  getBrokerSupervisorSnapshot,
  getBrokerUpstream,
} from "~/lib/mcp-broker/supervisor"

import {
  config,
  fixture,
  frame,
  ready,
  readyPayload,
  sendReadyHandshake,
  sentFrames,
  waitForChild,
  waitForChildCount,
  waitForFrame,
  waitForState,
  withServer,
} from "./helpers/broker-supervisor"

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
