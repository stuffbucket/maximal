/**
 * App Permissions model: which target an API key stands for, how a missing
 * `access` entry falls back to the legacy `clients` list, and the pure
 * permission lookups the MCP route and client sync share.
 */

import { describe, expect, test } from "bun:test"

import { type AppConfig, getConfig, writeConfig } from "~/lib/config/config"
import {
  PLUGIN_UNIDENTIFIED_ACCESS_ID,
  pluginAccessIdForApiKey,
  pluginAppAccessId,
  pluginClientForApiKeyLabel,
  pluginConnectionAccessId,
} from "~/lib/plugins/access"
import {
  pluginAccessPermission,
  pluginClientPermission,
  pluginClients,
  pluginConnectionPermission,
  pruneConnectionAccess,
  updatePluginEntry,
} from "~/lib/plugins/settings"

describe("API key labels", () => {
  test("a label that names an app is that app, however it is written", () => {
    for (const label of ["claude-code", "Claude Code", " CLAUDE_CODE "]) {
      expect(pluginClientForApiKeyLabel(label)).toBe("claude-code")
    }
    expect(pluginClientForApiKeyLabel("Copilot CLI")).toBe("copilot-cli")
    expect(pluginClientForApiKeyLabel("Codex")).toBe("codex")
  })

  test("any other label is a connection of its own", () => {
    expect(pluginClientForApiKeyLabel("CI runner")).toBeUndefined()
    expect(pluginClientForApiKeyLabel("Claude Code work")).toBeUndefined()
    expect(pluginAccessIdForApiKey({ id: "k1", label: "CI runner" })).toBe(
      "connection:k1",
    )
    expect(pluginAccessIdForApiKey({ id: "k2", label: "Claude Desktop" })).toBe(
      "app:claude-desktop",
    )
    expect(pluginAppAccessId("codex")).toBe("app:codex")
    expect(pluginConnectionAccessId("k1")).toBe("connection:k1")
  })
})

const config = (entry: NonNullable<AppConfig["plugins"]>[string]) =>
  ({ plugins: { demo: entry } }) satisfies AppConfig

describe("permission lookups", () => {
  test("without `access`, apps follow the legacy clients list and connections stay allowed", () => {
    const legacy = config({ clients: ["claude-code"] })
    expect(pluginClientPermission(legacy, "demo", "claude-code")).toBe("allow")
    expect(pluginClientPermission(legacy, "demo", "codex")).toBe("block")
    expect(pluginConnectionPermission(legacy, "demo", "k1")).toBe("allow")
    expect(pluginClients(legacy, "demo")).toEqual(["claude-code"])
    // A connector with no entry at all reaches no app.
    expect(pluginClientPermission({}, "demo", "claude-code")).toBe("block")
    expect(pluginClients({}, "demo")).toEqual([])
  })

  test("explicit access wins over the legacy list, in both directions", () => {
    const mixed = config({
      clients: ["claude-code"],
      access: {
        "app:claude-code": "block",
        "app:codex": "ask",
        "connection:k1": "block",
        "connection:k2": "ask",
      },
    })
    expect(pluginClientPermission(mixed, "demo", "claude-code")).toBe("block")
    expect(pluginClientPermission(mixed, "demo", "codex")).toBe("ask")
    expect(pluginConnectionPermission(mixed, "demo", "k1")).toBe("block")
    expect(pluginConnectionPermission(mixed, "demo", "k2")).toBe("ask")
    // Only Block leaves the list of apps that get the connector.
    expect(pluginClients(mixed, "demo")).toEqual(["codex"])
  })

  test("a caller with no identity isn't subject to the policy", () => {
    const blocked = config({ access: { "app:codex": "block" } })
    expect(pluginAccessPermission(blocked, "demo", undefined)).toBe("allow")
  })

  test("an unidentified caller is Block whatever the policy says", () => {
    const open = config({
      clients: ["codex"],
      access: { "app:codex": "allow" },
    })
    expect(
      pluginAccessPermission(open, "demo", PLUGIN_UNIDENTIFIED_ACCESS_ID),
    ).toBe("block")
  })
})

describe("updatePluginEntry: clients and access in one change", () => {
  test("access wins for the apps it names, clients decides the rest, and clients is derived", () => {
    writeConfig({})
    updatePluginEntry("demo", {
      clients: ["claude-code", "codex"],
      access: { "app:codex": "block", "app:copilot-cli": "ask" },
    })
    const entry = getConfig().plugins?.demo
    expect(entry?.access).toEqual({
      "app:codex": "block",
      "app:copilot-cli": "ask",
    })
    // Not the caller's list verbatim: Block is out, an Ask app is in.
    expect(entry?.clients).toEqual(["claude-code", "copilot-cli"])
    expect(pluginClients(getConfig(), "demo")).toEqual(entry?.clients ?? [])
  })

  test("the same request gives the same entry from any starting point", () => {
    const change = {
      clients: ["codex" as const],
      access: { "app:claude-code": "ask" as const },
    }
    writeConfig({})
    updatePluginEntry("demo", change)
    const fresh = getConfig().plugins?.demo
    writeConfig({
      plugins: {
        demo: {
          clients: ["claude-code", "codex"],
          access: { "app:claude-code": "block", "app:codex": "block" },
        },
      },
    })
    updatePluginEntry("demo", change)
    expect(getConfig().plugins?.demo.clients).toEqual(["claude-code", "codex"])
    expect(getConfig().plugins?.demo.access).toEqual({
      "app:claude-code": "ask",
      "app:codex": "allow",
    })
    expect(fresh?.clients).toEqual(["claude-code", "codex"])
  })
})

describe("pruneConnectionAccess", () => {
  test("removes one deleted connection's entries and reports nothing to do otherwise", () => {
    const cfg: AppConfig = {
      plugins: {
        a: { access: { "connection:k1": "block", "app:codex": "ask" } },
        b: { access: { "connection:k2": "ask" } },
        c: { enabled: true },
      },
    }
    expect(pruneConnectionAccess(cfg, "k1")).toEqual({
      a: { access: { "app:codex": "ask" } },
      b: { access: { "connection:k2": "ask" } },
      c: { enabled: true },
    })
    expect(pruneConnectionAccess(cfg, "gone")).toBeUndefined()
    expect(pruneConnectionAccess({}, "k1")).toBeUndefined()
  })
})
