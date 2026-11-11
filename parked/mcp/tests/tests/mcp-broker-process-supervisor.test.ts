/**
 * The process-wide broker supervisor: start, reconfigure, restart, wait,
 * stop. Disabled configs throughout: the supervisor exists but never
 * spawns a broker. The supervisor itself is covered in
 * mcp-broker-supervisor.test.ts.
 */
import { describe, expect, test } from "bun:test"

import {
  reconfigureBroker,
  restartBroker,
  startBrokerSupervisor,
  stopBrokerSupervisor,
  waitForBrokerReady,
} from "~/lib/mcp-broker/supervisor"

describe("process-wide supervisor", () => {
  test("after stop, a reconfigure finds no supervisor and starts nothing", async () => {
    startBrokerSupervisor({})
    expect(await reconfigureBroker({ enabled: false, servers: [] })).toBe(true)
    await stopBrokerSupervisor()
    expect(await reconfigureBroker({ enabled: false })).toBe(false)
  })

  test("waiting for readiness: off without a broker, and follows a reconfigure", async () => {
    expect(await waitForBrokerReady(50)).toBe("off")
    startBrokerSupervisor({ enabled: false })
    // The reconfigure swaps in a new supervisor; the wait follows it.
    const reconfigured = reconfigureBroker({
      enabled: false,
      executablePath: "/elsewhere/maximal-mcp-broker",
    })
    expect(await waitForBrokerReady(2_000)).toBe("off")
    expect(await reconfigured).toBe(true)
    await stopBrokerSupervisor()
  })

  test("a restart needs a running supervisor", async () => {
    expect(await restartBroker()).toBe(false)
    startBrokerSupervisor({ enabled: false })
    expect(await restartBroker()).toBe(true)
    expect(await waitForBrokerReady(50)).toBe("off")
    await stopBrokerSupervisor()
    expect(await restartBroker()).toBe(false)
  })

  test("a stop during a reconfigure keeps the broker stopped", async () => {
    startBrokerSupervisor({})
    const reconfigured = reconfigureBroker({ enabled: false, servers: [] })
    // Let the reconfigure begin stopping the old supervisor, then shut down.
    await Promise.resolve()
    await stopBrokerSupervisor()
    expect(await reconfigured).toBe(false)
    expect(await reconfigureBroker({ enabled: false })).toBe(false)
  })
})
