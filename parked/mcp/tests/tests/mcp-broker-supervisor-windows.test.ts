/**
 * The supervisor on Windows, where the broker contains itself in a
 * kill-on-close Job Object (see the broker's `windows-job.ts`): no process
 * group to kill, TerminateProcess as the last resort, and a broker that
 * Windows wouldn't contain reported instead of restarted.
 */
import { describe, expect, test } from "bun:test"
import {
  type ChildProcessWithoutNullStreams,
  type spawn,
} from "node:child_process"

import type { McpBrokerConfig } from "~/lib/mcp-broker/types"

import { BROKER_CONTAINMENT_EXIT_CODE } from "~/lib/mcp-broker/control-protocol"
import {
  getBrokerSupervisorSnapshot,
  getBrokerUpstream,
} from "~/lib/mcp-broker/supervisor"

import { CONTAINMENT_EXIT_CODE } from "../packages/mcp-broker/src/windows-job"
import {
  config,
  FakeBrokerProcess,
  fixture,
  sendReadyHandshake,
  sentFrames,
  waitForChild,
  waitForChildCount,
  waitForState,
} from "./helpers/broker-supervisor"

/** The fixture on win32, recording how each broker was started. */
const windowsFixture = (configuration: McpBrokerConfig = config()) => {
  const launches: Array<{ args: Array<string>; detached: unknown }> = []
  const children: Array<FakeBrokerProcess> = []
  const harness = fixture(configuration, {
    platform: "win32",
    spawnProcess: ((
      _command: string,
      args: Array<string>,
      options: { detached?: boolean },
    ) => {
      launches.push({ args, detached: options.detached })
      const child = new FakeBrokerProcess(50_000 + children.length)
      children.push(child)
      return child as unknown as ChildProcessWithoutNullStreams
    }) as unknown as typeof spawn,
  })
  return { ...harness, children, launches }
}

describe("BrokerSupervisor on Windows", () => {
  test("agrees with the broker on the exit status for refused containment", () => {
    // The broker's Windows test checks that it exits with this status.
    expect(BROKER_CONTAINMENT_EXIT_CODE).toBe(CONTAINMENT_EXIT_CODE)
  })

  test("starts the broker, which contains itself, watching this process", async () => {
    const { children, launches, supervisor } = windowsFixture()
    supervisor.start()
    const child = await waitForChild(children)
    sendReadyHandshake(child, "generation-1")
    await waitForState("ready")
    expect(launches).toEqual([
      {
        args: ["serve", "--generation", "generation-1", "--parent-pid", "99"],
        detached: true,
      },
    ])
    await supervisor.stop()
  })

  test("a stop that isn't answered in time terminates the broker, which ends its job", async () => {
    const { children, killedGroups, supervisor } = windowsFixture()
    supervisor.start()
    const child = await waitForChild(children)
    const frames = sentFrames(child)
    sendReadyHandshake(child, "generation-1")
    await waitForState("ready")

    await supervisor.stop()
    // Asked first, then TerminateProcess; never a POSIX group kill.
    expect(frames.map((sent) => sent.operation)).toContain("shutdown")
    expect(child.signals).toContain("SIGKILL")
    expect(killedGroups).toEqual([])
    expect(getBrokerSupervisorSnapshot().state).toBe("disabled")
  })

  test("a broker Windows wouldn't contain is unavailable, and isn't restarted", async () => {
    const { children, supervisor } = windowsFixture(
      config({ restartBackoffMinMs: 5, restartBackoffMaxMs: 5 }),
    )
    supervisor.start()
    const child = await waitForChild(children)
    child.exitCode = BROKER_CONTAINMENT_EXIT_CODE
    child.emit("exit", BROKER_CONTAINMENT_EXIT_CODE, null)

    expect(getBrokerSupervisorSnapshot()).toMatchObject({
      state: "unavailable",
      problem: "containment-unavailable",
    })
    expect(await supervisor.waitUntilReady(50)).toBe("failed")
    // No retry loop: a restart would be refused the same way.
    await Bun.sleep(50)
    expect(children).toHaveLength(1)
    expect(getBrokerUpstream()).toBeUndefined()
    await supervisor.stop()
  })

  test("a broker that crashes for another reason is restarted", async () => {
    const { children, supervisor } = windowsFixture(
      config({ restartBackoffMinMs: 5, restartBackoffMaxMs: 5 }),
    )
    supervisor.start()
    const child = await waitForChild(children)
    child.exitCode = 1
    child.emit("exit", 1, null)
    await waitForChildCount(children, 2)
    await supervisor.stop()
  })

  test("off Windows, exit status 78 is an ordinary crash", async () => {
    const { children, supervisor } = fixture(
      config({ restartBackoffMinMs: 5, restartBackoffMaxMs: 5 }),
    )
    supervisor.start()
    const child = await waitForChild(children)
    child.exitCode = BROKER_CONTAINMENT_EXIT_CODE
    child.emit("exit", BROKER_CONTAINMENT_EXIT_CODE, null)
    await waitForChildCount(children, 2)
    expect(getBrokerSupervisorSnapshot().problem).toBeNull()
    await supervisor.stop()
  })
})
