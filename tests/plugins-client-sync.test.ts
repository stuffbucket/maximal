/**
 * Plugin client sync: which plugin endpoints a client should have, the
 * ownership record (`apps.claudeCode.mcpServers`), shutdown release, and
 * the one-shot cleanup of the parked broker's Claude Desktop entries.
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
  type PluginReconcileResult,
  releasePluginClientOffline,
  syncPluginClient,
} from "~/lib/plugins/clients/sync"

import {
  definePlugin,
  startTestGateway,
  type TestGateway,
} from "./helpers/plugins"

interface FakeClient extends PluginClientConfigurator {
  calls: Array<{ desired: Array<PluginClientEntry>; owned: Array<string> }>
  released: Array<Array<string>>
}

function fakeClient(available = true): FakeClient {
  const calls: FakeClient["calls"] = []
  const released: FakeClient["released"] = []
  return {
    clientId: "claude-code",
    apiKeyLabel: "claude-code",
    calls,
    released,
    available: () => Promise.resolve(available),
    unavailableReason: () => "off",
    reconcile(desired, owned): Promise<PluginReconcileResult> {
      calls.push({ desired, owned })
      const ids = desired.map((entry) => entry.id)
      return Promise.resolve({
        owned: ids,
        added: ids.filter((id) => !owned.includes(id)),
        removed: owned.filter((id) => !ids.includes(id)),
        skipped: [],
      })
    },
    releaseOffline(owned) {
      released.push(owned)
      return { owned: [], added: [], removed: owned, skipped: [] }
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

describe("syncPluginClient", () => {
  beforeEach(async () => {
    plugins = await startTestGateway([
      definePlugin("alpha", noop),
      definePlugin("beta", noop),
      definePlugin("delta", noop, { kind: "extension" }),
    ])
  })

  test("wants each known connector that is on and chose the client", async () => {
    writeConfig({
      plugins: {
        alpha: { enabled: true, clients: ["claude-code"] },
        beta: { enabled: false, clients: ["claude-code"] },
        gamma: { enabled: true, clients: ["claude-code"] },
        // Not a connector: no MCP endpoint to register.
        delta: { enabled: true, clients: ["claude-code"] },
      },
      auth: {
        apiKeyEntries: [
          {
            id: "k1",
            label: "claude-code",
            key: "claude-code-key-1",
            enabled: true,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    })
    const client = fakeClient()

    const result = await syncPluginClient(client)

    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].owned).toEqual([])
    expect(client.calls[0].desired).toHaveLength(1)
    const [wanted] = client.calls[0].desired
    expect(wanted.id).toBe("alpha")
    expect(wanted.apiKey).toBe("claude-code-key-1")
    expect(wanted.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/alpha$/)
    expect(result.added).toEqual(["alpha"])
    expect(getConfig().apps?.claudeCode?.mcpServers).toEqual(["alpha"])
  })

  test("takes owned entries out when the integration is off", async () => {
    writeConfig({
      plugins: { alpha: { enabled: true, clients: ["claude-code"] } },
      apps: { claudeCode: { mcpServers: ["alpha"] } },
    })
    const client = fakeClient(false)

    await syncPluginClient(client)

    expect(client.calls).toEqual([{ desired: [], owned: ["alpha"] }])
    expect(getConfig().apps?.claudeCode?.mcpServers).toEqual([])
  })

  test("does not touch the client when nothing is wanted or owned", async () => {
    writeConfig({ plugins: { alpha: { enabled: true } } })
    const client = fakeClient()
    await syncPluginClient(client)
    expect(client.calls).toEqual([])
  })
})

describe("outside the serving process", () => {
  test("sync is a no-op without a running gateway", async () => {
    writeConfig({
      plugins: { alpha: { enabled: true, clients: ["claude-code"] } },
      apps: { claudeCode: { mcpServers: ["alpha"] } },
    })
    const client = fakeClient()
    await syncPluginClient(client)
    expect(client.calls).toEqual([])
    expect(getConfig().apps?.claudeCode?.mcpServers).toEqual(["alpha"])
  })

  test("offline release removes owned entries and clears the record", () => {
    writeConfig({
      apps: { claudeCode: { enabled: true, mcpServers: ["alpha"] } },
    })
    const client = fakeClient()

    const result = releasePluginClientOffline(client)

    expect(result.removed).toEqual(["alpha"])
    expect(client.released).toEqual([["alpha"]])
    expect(getConfig().apps?.claudeCode).toEqual({
      enabled: true,
      mcpServers: [],
    })
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
})
