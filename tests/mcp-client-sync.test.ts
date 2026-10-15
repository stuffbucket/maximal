/**
 * Shared MCP client sync — desired-set rules and the persisted record of
 * what Maximal wrote into each client. Uses the real config module (temp
 * COPILOT_API_HOME from the test preload) and a fake configurator.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"

import type { AppConfig } from "~/lib/config/config"

import { getConfig, writeConfig } from "~/lib/config/config"
import {
  desiredEntriesFor,
  type McpClientConfigurator,
  type McpClientEntry,
  syncMcpClient,
} from "~/lib/mcp-broker/client-sync"

interface FakeCall {
  desired: Array<string>
  owned: Array<string>
}

function fakeConfigurator(available = true) {
  const calls: Array<FakeCall> = []
  const configurator: McpClientConfigurator = {
    clientId: "claude-desktop",
    apiKeyLabel: "claude-desktop",
    available: () => available,
    reconcile(desired: Array<McpClientEntry>, owned: Array<string>) {
      calls.push({ desired: desired.map((entry) => entry.id), owned })
      return {
        owned: desired.map((entry) => entry.id),
        added: desired
          .map((entry) => entry.id)
          .filter((id) => !owned.includes(id)),
        removed: owned.filter((id) => !desired.some((e) => e.id === id)),
        skipped: [],
      }
    },
  }
  return { calls, configurator }
}

const server = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: id.toUpperCase(),
  transport: { type: "stdio" as const, command: id },
  ...extra,
})

function brokerConfig(
  servers: Array<ReturnType<typeof server>>,
  extra: Partial<AppConfig> = {},
): AppConfig {
  return { mcpBroker: { enabled: true, servers }, ...extra }
}

beforeEach(() => {
  writeConfig({})
})

afterAll(() => {
  writeConfig({})
})

describe("desiredEntriesFor", () => {
  const client = {
    clientId: "claude-desktop",
    apiKeyLabel: "claude-desktop",
  } as const

  test("includes only enabled endpoints that chose this client", () => {
    const config = brokerConfig([
      server("chosen", { clients: ["claude-desktop"] }),
      server("other-client", { clients: ["claude-code"] }),
      server("unchosen"),
      server("off", { enabled: false, clients: ["claude-desktop"] }),
    ])
    expect(desiredEntriesFor(client, config).map((e) => e.id)).toEqual([
      "chosen",
    ])
  })

  test("is empty while the broker is off", () => {
    const config = brokerConfig([server("a", { clients: ["claude-desktop"] })])
    config.mcpBroker = { ...config.mcpBroker, enabled: false }
    expect(desiredEntriesFor(client, config)).toEqual([])
  })

  test("uses the endpoint key, else the client's Maximal key", () => {
    const config = brokerConfig(
      [
        server("keyed", { clients: ["claude-desktop"], apiKey: "endpoint" }),
        server("open", { clients: ["claude-desktop"] }),
      ],
      { auth: { apiKeys: ["general"] } },
    )
    const [keyed, open] = desiredEntriesFor(client, config)
    expect(keyed).toEqual({
      id: "keyed",
      label: "KEYED",
      url: "http://127.0.0.1:4141/mcp/keyed",
      apiKey: "endpoint",
    })
    expect(open.apiKey).toBe("general")
  })
})

describe("syncMcpClient", () => {
  test("persists what the client now owns", () => {
    writeConfig(brokerConfig([server("a", { clients: ["claude-desktop"] })]))
    const { calls, configurator } = fakeConfigurator()

    const result = syncMcpClient(configurator)

    expect(result.added).toEqual(["a"])
    expect(calls).toEqual([{ desired: ["a"], owned: [] }])
    expect(getConfig().apps?.claudeDesktop?.mcpServers).toEqual(["a"])
  })

  test("reverts everything when the integration is inactive", () => {
    writeConfig(
      brokerConfig([server("a", { clients: ["claude-desktop"] })], {
        apps: { claudeDesktop: { enabled: true, mcpServers: ["a"] } },
      }),
    )
    const { calls, configurator } = fakeConfigurator()

    const result = syncMcpClient(configurator, { active: false })

    expect(result.removed).toEqual(["a"])
    expect(calls).toEqual([{ desired: [], owned: ["a"] }])
    expect(getConfig().apps?.claudeDesktop).toEqual({
      enabled: true,
      mcpServers: [],
    })
  })

  test("never touches the client when nothing is desired or owned", () => {
    writeConfig(brokerConfig([server("a")]))
    const { calls, configurator } = fakeConfigurator()

    syncMcpClient(configurator)

    expect(calls).toEqual([])
  })

  test("keeps the user's client choice when the endpoint is off", () => {
    writeConfig(
      brokerConfig(
        [server("a", { enabled: false, clients: ["claude-desktop"] })],
        { apps: { claudeDesktop: { mcpServers: ["a"] } } },
      ),
    )
    const { configurator } = fakeConfigurator()

    syncMcpClient(configurator)

    expect(getConfig().mcpBroker?.servers?.[0]?.clients).toEqual([
      "claude-desktop",
    ])
    expect(getConfig().apps?.claudeDesktop?.mcpServers).toEqual([])
  })
})
