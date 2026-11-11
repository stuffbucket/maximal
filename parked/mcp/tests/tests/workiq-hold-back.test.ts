/**
 * A Work IQ endpoint that is on isn't handed to the broker until its setup
 * is done (installed, terms accepted, signed in at least once): on Windows,
 * starting `workiq mcp` before that opens Microsoft's sign-in window by
 * itself, outside the steps in Settings.
 */
import { afterEach, describe, expect, test } from "bun:test"

import type { McpServerConfig } from "~/lib/config/config"
import type { McpBrokerConfig } from "~/lib/mcp-broker/types"
import type { WorkIqRunner } from "~/lib/system/workiq-cli"

import { resolveBrokerConfiguration } from "~/lib/mcp-broker/configuration"
import {
  getBrokerSupervisorSnapshot,
  setBrokerConfigFilter,
  startBrokerSupervisor,
  stopBrokerSupervisor,
} from "~/lib/mcp-broker/supervisor"
import {
  holdBackWorkIqUntilSetUp,
  isHeldBackFromBroker,
  WorkIq,
} from "~/lib/mcp-broker/workiq"

const workiqServer: McpServerConfig = {
  id: "workiq",
  label: "Work IQ",
  enabled: true,
  catalog: "workiq",
  transport: {
    type: "stdio",
    command: "/opt/workiq/bin/workiq",
    args: ["mcp"],
  },
}

const other: McpServerConfig = {
  id: "other",
  label: "Other",
  enabled: true,
  transport: { type: "stdio", command: "/opt/other/server" },
}

const brokerConfig = (
  servers: Array<McpServerConfig> = [workiqServer, other],
): McpBrokerConfig => ({ enabled: true, servers })

/** A Work IQ whose `workiq config show` prints `config`; null: not installed. */
const workIqWith = (config: Record<string, string> | null): WorkIq => {
  const run: WorkIqRunner = () =>
    Promise.resolve(
      config === null ?
        { stdout: "", stderr: "", code: 127, outcome: "not-found" }
      : {
          stdout: Object.entries(config)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n"),
          stderr: "",
          code: 0,
          outcome: "exited",
        },
    )
  return new WorkIq({ run, env: {} })
}

const servedIds = (config: McpBrokerConfig): Array<string> =>
  resolveBrokerConfiguration(config, {}).endpoints.map(
    (endpoint) => endpoint.id,
  )

describe("holdBackWorkIqUntilSetUp", () => {
  test("holds back a Work IQ whose setup hasn't been read yet", () => {
    const held = holdBackWorkIqUntilSetUp(brokerConfig(), workIqWith({}))
    expect(servedIds(held)).toEqual(["other"])
  })

  const notDone = [
    ["isn't installed", null],
    ["needs its terms accepted", { defaultAccount: "a@b" }],
    ["was never signed in", { "I-accept-EULA": "true" }],
  ] as const
  for (const [why, config] of notDone) {
    test(`holds back a Work IQ that ${why}`, async () => {
      const workiq = workIqWith(config === null ? null : { ...config })
      expect(await workiq.checkSetup(workiqServer)).toBe(false)
      const held = holdBackWorkIqUntilSetUp(brokerConfig(), workiq)
      expect(servedIds(held)).toEqual(["other"])
      expect(isHeldBackFromBroker(workiqServer, workiq)).toBe(true)
    })
  }

  test("hands over a Work IQ whose setup is done, and changes nothing else", async () => {
    const workiq = workIqWith({
      "I-accept-EULA": "true",
      defaultAccount: "a@b",
    })
    expect(await workiq.checkSetup(workiqServer)).toBe(true)
    const config = brokerConfig()
    expect(holdBackWorkIqUntilSetUp(config, workiq)).toBe(config)
    expect(servedIds(config)).toEqual(["workiq", "other"])
    expect(isHeldBackFromBroker(workiqServer, workiq)).toBe(false)
  })

  test("leaves a Work IQ that is off alone", () => {
    const config = brokerConfig([{ ...workiqServer, enabled: false }, other])
    expect(holdBackWorkIqUntilSetUp(config, workIqWith({}))).toBe(config)
  })

  test("a status read counts as a setup check", async () => {
    const workiq = workIqWith({ "I-accept-EULA": "true" })
    expect((await workiq.status(workiqServer)).state).toBe("signin-needed")
    expect(isHeldBackFromBroker(workiqServer, workiq)).toBe(true)
  })
})

describe("the broker's config filter", () => {
  afterEach(async () => {
    await stopBrokerSupervisor()
    setBrokerConfigFilter((config) => config)
  })

  test("is applied when the broker starts", () => {
    const workiq = workIqWith({})
    setBrokerConfigFilter((config) => holdBackWorkIqUntilSetUp(config, workiq))
    // No broker executable here, so nothing spawns; the snapshot still
    // counts what the broker was given.
    startBrokerSupervisor({
      ...brokerConfig(),
      executablePath: "/nonexistent/maximal-mcp-broker",
    })
    expect(getBrokerSupervisorSnapshot().enabledEndpoints).toBe(1)
  })
})
