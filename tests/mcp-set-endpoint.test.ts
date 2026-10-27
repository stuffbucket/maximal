/**
 * Turning an endpoint on waits for the broker before pointing client apps
 * at it, and boot does the same without holding anything else up.
 *
 * Uses the real config module (temp COPILOT_API_HOME); the broker and the
 * client sync are injected, so no broker process or client file is touched.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"

import type { AppConfig } from "~/lib/config/config"
import type { McpReconcileResult } from "~/lib/mcp-broker/client-sync"
import type { BrokerReadiness } from "~/lib/mcp-broker/supervisor"

import {
  setMcpEndpoint,
  syncAllMcpClients,
  syncMcpClientsWhenBrokerReady,
} from "~/apps/mcp"
import { writeConfig } from "~/lib/config/config"

function config(enabled: boolean): AppConfig {
  return {
    mcpBroker: {
      enabled,
      servers: [
        {
          id: "workiq",
          label: "Work IQ",
          enabled,
          clients: [],
          transport: { type: "stdio", command: "workiq" },
        },
      ],
    },
  }
}

/** A broker whose readiness the test settles by hand. */
function controlledBroker() {
  const events: Array<string> = []
  let settle: ((readiness: BrokerReadiness) => void) | undefined
  const timeouts: Array<number> = []
  return {
    events,
    timeouts,
    settle: (readiness: BrokerReadiness) => settle?.(readiness),
    reconfigure: () => {
      events.push("reconfigure")
      return Promise.resolve(true)
    },
    waitForBroker: (timeoutMs: number) => {
      events.push("wait")
      timeouts.push(timeoutMs)
      return new Promise<BrokerReadiness>((resolve) => {
        settle = (readiness) => {
          events.push(`broker ${readiness}`)
          resolve(readiness)
        }
      })
    },
    syncClients: () => {
      events.push("sync")
      return syncAllMcpClients()
    },
    sync: () => {
      events.push("sync")
    },
  }
}

beforeEach(() => {
  writeConfig(config(false))
})

afterAll(() => {
  writeConfig({})
})

describe("setMcpEndpoint", () => {
  test("turning on points apps at the endpoint only once the broker serves", async () => {
    const broker = controlledBroker()
    const pending = setMcpEndpoint(
      "workiq",
      { enabled: true, clients: [] },
      broker,
    )
    await Bun.sleep(10)
    expect(broker.events).toEqual(["reconfigure", "wait"])

    broker.settle("ready")
    const result = await pending
    expect(broker.events).toEqual([
      "reconfigure",
      "wait",
      "broker ready",
      "sync",
    ])
    expect(result?.broker).toBe("ready")
    // Bounded: Work IQ's own 30s startup timeout, plus margin.
    expect(broker.timeouts[0]).toBeGreaterThanOrEqual(30_000)
    expect(broker.timeouts[0]).toBeLessThanOrEqual(60_000)
  })

  test("says when the broker is still starting or failed, and still records the apps", async () => {
    for (const readiness of ["starting", "failed"] as const) {
      writeConfig(config(false))
      const broker = controlledBroker()
      const pending = setMcpEndpoint(
        "workiq",
        { enabled: true, clients: [] },
        broker,
      )
      await Bun.sleep(10)
      broker.settle(readiness)
      const result = await pending
      expect(result?.broker).toBe(readiness)
      expect(broker.events.at(-1)).toBe("sync")
    }
  })

  test("turning off doesn't wait for the broker", async () => {
    writeConfig(config(true))
    const broker = controlledBroker()
    const result = await setMcpEndpoint("workiq", { enabled: false }, broker)
    expect(broker.events).toEqual(["reconfigure", "sync"])
    expect(result?.endpoint.enabled).toBe(false)
  })
})

const outcome = (changes: Partial<McpReconcileResult>): McpReconcileResult => ({
  owned: [],
  added: [],
  removed: [],
  skipped: [],
  unavailable: [],
  ...changes,
})

describe("setMcpEndpoint per-app outcome", () => {
  test("names the apps it changed and the ones that can't run the server", async () => {
    const result = await setMcpEndpoint(
      "workiq",
      { enabled: true, clients: ["claude-code", "claude-desktop"] },
      {
        reconfigure: () => Promise.resolve(true),
        waitForBroker: () => Promise.resolve("ready"),
        syncClients: () =>
          Promise.resolve([
            {
              client: "claude-code",
              name: "Claude Code",
              result: outcome({ owned: ["workiq"], added: ["workiq"] }),
            },
            {
              client: "claude-desktop",
              name: "Claude Desktop",
              result: outcome({
                unavailable: [{ id: "workiq", reason: "adapter-missing" }],
              }),
            },
          ]),
      },
    )

    expect(result?.updated).toEqual([
      { client: "claude-code", name: "Claude Code" },
    ])
    expect(result?.unavailable).toEqual([
      {
        client: "claude-desktop",
        name: "Claude Desktop",
        reason: "adapter-missing",
      },
    ])
    expect(result?.skipped).toEqual([])
  })

  test("a removal counts as a change", async () => {
    writeConfig(config(true))
    const result = await setMcpEndpoint(
      "workiq",
      { enabled: false },
      {
        reconfigure: () => Promise.resolve(true),
        syncClients: () =>
          Promise.resolve([
            {
              client: "claude-desktop",
              name: "Claude Desktop",
              result: outcome({ removed: ["workiq"] }),
            },
          ]),
      },
    )
    expect(result?.updated).toEqual([
      { client: "claude-desktop", name: "Claude Desktop" },
    ])
  })
})

describe("syncMcpClientsWhenBrokerReady (boot)", () => {
  test("syncs only after the broker settles, and never throws", async () => {
    writeConfig(config(true))
    const broker = controlledBroker()
    const done = syncMcpClientsWhenBrokerReady(broker)
    await Bun.sleep(10)
    expect(broker.events).toEqual(["wait"])

    broker.settle("starting")
    await done
    expect(broker.events).toEqual(["wait", "broker starting", "sync"])
  })

  test("does nothing when the broker was never configured", async () => {
    writeConfig({})
    const broker = controlledBroker()
    await syncMcpClientsWhenBrokerReady(broker)
    expect(broker.events).toEqual([])
  })
})
