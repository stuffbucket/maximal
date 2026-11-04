/**
 * `config.json` → `plugins`: schema, per-plugin updates, and the one-time
 * migration of Work IQ from the parked MCP broker config.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { type AppConfig, getConfig, writeConfig } from "~/lib/config/config"
import { validateAppConfig } from "~/lib/config/config-schema"
import {
  migrateLegacyWorkIq,
  migratePluginSettings,
  updatePluginEntry,
} from "~/lib/plugins/settings"

afterEach(() => {
  writeConfig({})
})

/** `brokerSwitch: {}` leaves the broker's own `enabled` out. */
function broker(
  server: Record<string, unknown>,
  brokerSwitch: { enabled?: boolean } = { enabled: true },
): AppConfig {
  return {
    mcpBroker: {
      ...brokerSwitch,
      servers: [
        { id: "other", catalog: "other", transport: { type: "stdio" } },
        { id: "workiq", label: "Work IQ", catalog: "workiq", ...server },
      ],
    },
  }
}

describe("plugins config schema", () => {
  test("accepts entries with plugin config, clients, and unknown keys", () => {
    const config = validateAppConfig({
      plugins: {
        workiq: {
          enabled: true,
          config: { endpoint: "https://example.test/mcp" },
          clients: ["claude-code"],
          note: "kept",
        },
      },
      mcpBroker: { anything: ["goes"] },
    })
    const entry: unknown = config.plugins?.workiq
    expect(entry).toEqual({
      enabled: true,
      config: { endpoint: "https://example.test/mcp" },
      clients: ["claude-code"],
      note: "kept",
    })
  })

  test("rejects an unknown client", () => {
    expect(() =>
      validateAppConfig({
        plugins: { workiq: { clients: ["claude-desktop"] } },
      }),
    ).toThrow()
  })
})

describe("updatePluginEntry", () => {
  test("changes only what is given and de-duplicates clients", () => {
    writeConfig({ plugins: { workiq: { enabled: false, config: { a: 1 } } } })
    updatePluginEntry("workiq", { clients: ["claude-code", "claude-code"] })
    updatePluginEntry("workiq", { enabled: true })
    expect(getConfig().plugins?.workiq).toEqual({
      enabled: true,
      config: { a: 1 },
      clients: ["claude-code"],
    })
  })
})

describe("migrateLegacyWorkIq", () => {
  test("carries over on/off and the Claude Code choice", () => {
    const migrated = migrateLegacyWorkIq(
      broker({ enabled: true, clients: ["claude-code", "claude-desktop"] }),
    )
    expect(migrated?.plugins).toEqual({
      workiq: { enabled: true, clients: ["claude-code"] },
    })
    // The parked block itself is left as it was.
    expect(migrated?.mcpBroker).toBeDefined()
  })

  test("an endpoint without its own switch was on when the broker was", () => {
    expect(migrateLegacyWorkIq(broker({}))?.plugins?.workiq).toEqual({
      enabled: true,
    })
  })

  test("off when either the broker or the endpoint was off", () => {
    expect(
      migrateLegacyWorkIq(broker({ enabled: true }, { enabled: false }))
        ?.plugins?.workiq,
    ).toEqual({ enabled: false })
    expect(
      migrateLegacyWorkIq(broker({ enabled: true }, {}))?.plugins?.workiq,
    ).toEqual({ enabled: false })
    expect(
      migrateLegacyWorkIq(broker({ enabled: false, clients: ["claude-code"] }))
        ?.plugins?.workiq,
    ).toEqual({ enabled: false, clients: ["claude-code"] })
  })

  test("nothing to do without a Work IQ endpoint or with plugins.workiq set", () => {
    expect(migrateLegacyWorkIq({})).toBeUndefined()
    expect(migrateLegacyWorkIq({ mcpBroker: "garbage" })).toBeUndefined()
    expect(
      migrateLegacyWorkIq({ mcpBroker: { servers: [null, 3] } }),
    ).toBeUndefined()
    expect(
      migrateLegacyWorkIq({
        ...broker({}),
        plugins: { workiq: { enabled: false } },
      }),
    ).toBeUndefined()
  })

  test("runs once against config.json", () => {
    writeConfig(broker({ clients: ["claude-code"] }))
    migratePluginSettings()
    expect(getConfig().plugins?.workiq).toEqual({
      enabled: true,
      clients: ["claude-code"],
    })
    updatePluginEntry("workiq", { enabled: false })
    migratePluginSettings()
    expect(getConfig().plugins?.workiq.enabled).toBe(false)
  })
})
