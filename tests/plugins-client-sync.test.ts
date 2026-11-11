/**
 * Plugin client sync: which connector endpoints a client should have (on,
 * chosen for the client, integration on, not already set up by the user),
 * the one-time removal of entry names older versions recorded
 * (`apps.claudeCode.mcpServers`), uninstall, and the one-shot cleanup of the
 * parked broker's Claude Desktop entries.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { getConfig, writeConfig } from "~/lib/config/config"
import { removeLegacyClaudeDesktopEntries } from "~/lib/plugins/clients/claude-desktop-cleanup"
import {
  type PluginClientConfigurator,
  type PluginClientEntry,
  removePluginClientEntries,
  type StandaloneInstall,
  syncPluginClient,
} from "~/lib/plugins/clients/sync"

import {
  definePlugin,
  startTestGateway,
  type TestGateway,
} from "./helpers/plugins"

interface FakeClient extends PluginClientConfigurator {
  calls: Array<{ desired: Array<PluginClientEntry>; legacy: Array<string> }>
}

function fakeClient(
  options: {
    available?: boolean
    standalone?: Record<string, StandaloneInstall>
    fail?: boolean
  } = {},
): FakeClient {
  const calls: FakeClient["calls"] = []
  return {
    clientId: "claude-code",
    apiKeyLabel: "claude-code",
    calls,
    available: () => options.available ?? true,
    unavailableReason: () => "off",
    standalone: (id) => options.standalone?.[id],
    apply(desired, legacy) {
      calls.push({ desired: [...desired], legacy: [...legacy] })
      if (options.fail) throw new Error("unreadable")
      return {
        written: desired.map((entry) => `maximal-${entry.id}`),
        removed: [],
      }
    },
  }
}

const noop = () => undefined
let plugins: TestGateway | undefined

afterEach(async () => {
  const current = plugins
  plugins = undefined
  await current?.dispose()
  writeConfig({})
})

const KEY_ENTRY = {
  id: "k1",
  label: "claude-code",
  key: "claude-code-key-1",
  enabled: true,
  created_at: "2026-01-01T00:00:00Z",
}

describe("syncPluginClient", () => {
  beforeEach(async () => {
    plugins = await startTestGateway([
      definePlugin("alpha", noop),
      definePlugin("beta", noop),
      definePlugin("epsilon", noop),
      definePlugin("delta", noop, { kind: "extension" }),
    ])
  })

  test("wants each known connector that is on, chose the client, and isn't the user's own", () => {
    writeConfig({
      plugins: {
        alpha: { enabled: true, clients: ["claude-code"] },
        beta: { enabled: false, clients: ["claude-code"] },
        gamma: { enabled: true, clients: ["claude-code"] },
        // Not a connector: no MCP endpoint to register.
        delta: { enabled: true, clients: ["claude-code"] },
        // The user runs their own epsilon in the client.
        epsilon: { enabled: true, clients: ["claude-code"] },
      },
      auth: { apiKeyEntries: [KEY_ENTRY] },
    })
    const client = fakeClient({
      standalone: { epsilon: { name: "epsilon", source: "server" } },
    })

    expect(syncPluginClient(client)).toBe(true)

    expect(client.calls).toHaveLength(1)
    const [{ desired, legacy }] = client.calls
    expect(legacy).toEqual([])
    expect(desired).toHaveLength(1)
    expect(desired[0].id).toBe("alpha")
    expect(desired[0].apiKey).toBe("claude-code-key-1")
    expect(desired[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/alpha$/)
  })

  test("wants nothing when the integration is off", () => {
    writeConfig({
      plugins: { alpha: { enabled: true, clients: ["claude-code"] } },
    })
    const client = fakeClient({ available: false })

    expect(syncPluginClient(client)).toBe(false)

    expect(client.calls).toEqual([{ desired: [], legacy: [] }])
  })

  test("passes the legacy names once, then clears them", () => {
    writeConfig({
      apps: { claudeCode: { enabled: true, mcpServers: ["alpha"] } },
    })
    const client = fakeClient()

    syncPluginClient(client)
    syncPluginClient(client)

    expect(client.calls.map((call) => call.legacy)).toEqual([["alpha"], []])
    expect(getConfig().apps?.claudeCode).toEqual({ enabled: true })
  })

  test("keeps the legacy names when the client's config can't be written", () => {
    writeConfig({ apps: { claudeCode: { mcpServers: ["alpha"] } } })
    expect(() => syncPluginClient(fakeClient({ fail: true }))).toThrow()
    expect(getConfig().apps?.claudeCode?.mcpServers).toEqual(["alpha"])
  })
})

describe("outside the serving process", () => {
  test("sync is a no-op without a running gateway", () => {
    writeConfig({
      plugins: { alpha: { enabled: true, clients: ["claude-code"] } },
      apps: { claudeCode: { mcpServers: ["alpha"] } },
    })
    const client = fakeClient()
    expect(syncPluginClient(client)).toBe(false)
    expect(client.calls).toEqual([])
    expect(getConfig().apps?.claudeCode?.mcpServers).toEqual(["alpha"])
  })

  test("uninstall removes every entry and the legacy record", () => {
    writeConfig({
      apps: { claudeCode: { enabled: true, mcpServers: ["alpha"] } },
    })
    const client = fakeClient()

    removePluginClientEntries(client)

    expect(client.calls).toEqual([{ desired: [], legacy: ["alpha"] }])
    expect(getConfig().apps?.claudeCode).toEqual({ enabled: true })
  })
})

describe("removeLegacyClaudeDesktopEntries", () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-cleanup-"))
    file = path.join(dir, "claude_desktop_config.json")
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("removes owned broker-adapter entries only, then clears the record", () => {
    const mine = { command: "node", args: ["server.js"] }
    const theirs = { command: "/opt/other/server" }
    fs.writeFileSync(
      file,
      JSON.stringify({
        preferences: { keep: true },
        mcpServers: {
          workiq: {
            command: String.raw`C:\Program Files\Maximal\maximal-mcp-broker.exe`,
            args: [
              "stdio-adapter",
              "--url",
              "http://127.0.0.1:4141/mcp/workiq",
            ],
            env: { MAXIMAL_MCP_API_KEY: "k" },
          },
          mine,
          theirs,
        },
      }),
    )
    writeConfig({
      apps: {
        claudeDesktop: { enabled: true, mcpServers: ["workiq", "mine"] },
      },
    })

    expect(removeLegacyClaudeDesktopEntries(file)).toEqual(["workiq"])

    const document: unknown =
      // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
      JSON.parse(fs.readFileSync(file, "utf8"))
    expect(document).toEqual({
      preferences: { keep: true },
      mcpServers: { mine, theirs },
    })
    expect(getConfig().apps?.claudeDesktop).toEqual({ enabled: true })
  })

  test("does nothing without an ownership record", () => {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }))
    const before = fs.readFileSync(file, "utf8")
    expect(removeLegacyClaudeDesktopEntries(file)).toEqual([])
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })

  test("clears the record even when Desktop's config is gone", () => {
    writeConfig({ apps: { claudeDesktop: { mcpServers: ["workiq"] } } })
    expect(removeLegacyClaudeDesktopEntries(file)).toEqual([])
    expect(getConfig().apps?.claudeDesktop).toEqual({})
  })

  test("keeps the record while Desktop's config exists but can't be read", () => {
    // Partial / locked / unreadable files all come back as "no document".
    for (const unreadable of ['{ "mcpServers": { "workiq": ', ""]) {
      fs.writeFileSync(file, unreadable)
      writeConfig({ apps: { claudeDesktop: { mcpServers: ["workiq"] } } })
      expect(removeLegacyClaudeDesktopEntries(file)).toEqual([])
      expect(getConfig().apps?.claudeDesktop).toEqual({
        mcpServers: ["workiq"],
      })
      expect(fs.readFileSync(file, "utf8")).toBe(unreadable)
    }
    // A directory in the file's place (EISDIR) is unreadable too.
    fs.rmSync(file)
    fs.mkdirSync(file)
    expect(removeLegacyClaudeDesktopEntries(file)).toEqual([])
    expect(getConfig().apps?.claudeDesktop).toEqual({ mcpServers: ["workiq"] })
  })

  test("clears the record once a readable config has nothing of ours left", () => {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }))
    writeConfig({ apps: { claudeDesktop: { mcpServers: ["workiq"] } } })
    expect(removeLegacyClaudeDesktopEntries(file)).toEqual([])
    expect(getConfig().apps?.claudeDesktop).toEqual({})
  })
})
