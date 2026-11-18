import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { PluginClientEntry } from "~/lib/plugins/clients/sync"

import {
  applyConfigLibraryProfile,
  type GatewayProfileValues,
  gatewayProfile,
  getClaude3pDir,
  isConfigLibraryApplied,
  revertConfigLibraryProfile,
} from "~/apps/claude-desktop/config"
import {
  isMaximalDesktopManagedMcpServer,
  isMaximalDesktopManagedMcpServers,
} from "~/apps/claude-desktop/managed-mcp"
import { updateConfigLibraryManagedMcpServers } from "~/apps/claude-desktop/managed-mcp-profile"
import {
  createClaudeDesktopPluginClient,
  isLegacyMaximalDesktopEntry,
} from "~/lib/plugins/clients/claude-desktop"

const COMMAND = "/Applications/Maximal.app/Contents/MacOS/maximal"
const DESIRED: Array<PluginClientEntry> = [
  {
    id: "workiq",
    url: "http://127.0.0.1:4141/mcp/workiq",
    apiKey: "desktop-identity-key",
  },
]

function readJson(file: string): Record<string, unknown> {
  // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
}

describe("Claude Desktop plugin client", () => {
  let home: string
  let file: string
  let profileFile: string
  let values: GatewayProfileValues

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-plugin-client-"))
    file = path.join(getClaude3pDir(home), "claude_desktop_config.json")
    values = {
      ...gatewayProfile(home, "http://127.0.0.1:4141"),
      inferenceGatewayApiKey: "desktop-routing-key",
    }
    const { profileId } = applyConfigLibraryProfile(home, values)
    profileFile = path.join(
      getClaude3pDir(home),
      "configLibrary",
      `${profileId}.json`,
    )
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  function client(writable = true) {
    return createClaudeDesktopPluginClient({
      configPath: () => file,
      integrationOn: () => true,
      writable: () => writable,
      updateManagedServers: (servers) =>
        updateConfigLibraryManagedMcpServers(servers, home, values),
    })
  }

  function managedServers(): Array<Record<string, unknown>> | undefined {
    return readJson(profileFile).managedMcpServers as
      | Array<Record<string, unknown>>
      | undefined
  }

  test("writes one aggregate managed HTTP server with the app identity key", () => {
    expect(client().apply(DESIRED, [])).toEqual({
      written: ["maximal"],
      removed: [],
    })

    expect(managedServers()).toEqual([
      {
        name: "maximal",
        transport: "http",
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
        headers: { Authorization: "Bearer desktop-identity-key" },
      },
    ])
    expect(isConfigLibraryApplied(home, values)).toBe(true)
    expect(fs.statSync(profileFile).mode & 0o777).toBe(0o600)
  })

  test("is idempotent and rotates only Maximal's managed entry", () => {
    client().apply(DESIRED, [])
    const first = fs.readFileSync(profileFile, "utf8")
    expect(client().apply(DESIRED, [])).toEqual({ written: [], removed: [] })
    expect(fs.readFileSync(profileFile, "utf8")).toBe(first)

    const changed = [{ ...DESIRED[0], apiKey: "rotated-key" }]
    expect(client().apply(changed, [])).toEqual({
      written: ["maximal"],
      removed: [],
    })
    expect(managedServers()?.[0]?.headers).toEqual({
      Authorization: "Bearer rotated-key",
    })
    expect(isConfigLibraryApplied(home, values)).toBe(true)
  })

  test("keeps ownership after Desktop seals the routing key", () => {
    client().apply(DESIRED, [])
    const profile = readJson(profileFile)
    const sealed = `__sealed__:v1:${"A".repeat(196)}`
    profile.inferenceGatewayApiKey = sealed
    fs.writeFileSync(profileFile, JSON.stringify(profile))

    expect(isConfigLibraryApplied(home, values)).toBe(true)
    expect(
      client().apply([{ ...DESIRED[0], apiKey: "rotated-key" }], []),
    ).toEqual({ written: ["maximal"], removed: [] })
    expect(readJson(profileFile).inferenceGatewayApiKey).toBe(sealed)
    expect(managedServers()?.[0]?.headers).toEqual({
      Authorization: "Bearer rotated-key",
    })
  })

  test("removes its managed entry without disturbing routing", () => {
    client().apply(DESIRED, [])

    expect(client().apply([], [])).toEqual({
      written: [],
      removed: ["maximal"],
    })
    expect(managedServers()).toBeUndefined()
    expect(isConfigLibraryApplied(home, values)).toBe(true)
  })

  test("preserves the managed server across routing refresh and removes it on revert", () => {
    client().apply(DESIRED, [])
    const refreshed = {
      ...values,
      inferenceGatewayBaseUrl: "http://127.0.0.1:5252",
      inferenceGatewayApiKey: "rotated-routing-key",
    }

    expect(applyConfigLibraryProfile(home, refreshed).wrote).toBe(true)
    expect(managedServers()).toHaveLength(1)
    expect(isConfigLibraryApplied(home, refreshed)).toBe(true)

    expect(revertConfigLibraryProfile(home).reverted).toBe(true)
    expect(fs.existsSync(profileFile)).toBe(false)
  })

  test("migrates the signed stdio entry and preserves foreign local servers", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        deploymentMode: "3p",
        mcpServers: {
          foreign: { command: "foreign" },
          maximal: {
            command: COMMAND,
            args: ["mcp", "stdio", "--url", "http://127.0.0.1:4141/mcp"],
            env: { MAXIMAL_MCP_API_KEY: "old-key" },
          },
        },
      }),
    )

    expect(client().apply(DESIRED, [])).toEqual({
      written: ["maximal"],
      removed: [],
    })
    expect(readJson(file)).toEqual({
      deploymentMode: "3p",
      mcpServers: { foreign: { command: "foreign" } },
    })
    expect(managedServers()).toHaveLength(1)
  })

  test("leaves a user-edited managed MCP field untouched", () => {
    const profile = readJson(profileFile)
    profile.managedMcpServers = [
      {
        name: "company",
        transport: "http",
        url: "https://mcp.example.com",
      },
    ]
    fs.writeFileSync(profileFile, JSON.stringify(profile))
    const before = fs.readFileSync(profileFile, "utf8")

    expect(() => client().apply(DESIRED, [])).toThrow(
      "applied profile is not Maximal's",
    )
    expect(fs.readFileSync(profileFile, "utf8")).toBe(before)
  })

  test("does not write or remove when another profile owns the file", () => {
    client().apply(DESIRED, [])
    const beforeProfile = fs.readFileSync(profileFile, "utf8")
    expect(client(false).apply([], [])).toEqual({ written: [], removed: [] })
    expect(fs.readFileSync(profileFile, "utf8")).toBe(beforeProfile)
  })

  test("refuses unreadable legacy config and symbolic links", () => {
    fs.writeFileSync(file, "{")
    expect(() => client().apply(DESIRED, [])).toThrow("can't be read")

    fs.rmSync(file)
    const target = path.join(home, "target.json")
    fs.writeFileSync(target, "{}")
    fs.symlinkSync(target, file)
    expect(() => client().apply(DESIRED, [])).toThrow("symbolic link")
    expect(fs.readFileSync(target, "utf8")).toBe("{}")
  })
})

describe("Claude Desktop managed MCP ownership", () => {
  test("recognizes only Maximal's exact aggregate managed entry", () => {
    const entry = {
      name: "maximal",
      transport: "http",
      url: "http://127.0.0.1:64792/mcp",
      headers: { Authorization: "Bearer desktop-key" },
    }
    expect(isMaximalDesktopManagedMcpServer(entry)).toBe(true)
    expect(isMaximalDesktopManagedMcpServers([entry])).toBe(true)
    expect(isMaximalDesktopManagedMcpServers([])).toBe(true)
    expect(
      isMaximalDesktopManagedMcpServer({
        ...entry,
        url: "http://127.0.0.1:64792/mcp/workiq",
      }),
    ).toBe(false)
    expect(
      isMaximalDesktopManagedMcpServer({
        ...entry,
        headers: { Authorization: "desktop-key" },
      }),
    ).toBe(false)
  })

  test("recognizes the previous aggregate stdio signature only", () => {
    const entry = {
      command: COMMAND,
      args: ["mcp", "stdio", "--url", "http://127.0.0.1:64792/mcp"],
    }
    expect(isLegacyMaximalDesktopEntry("maximal", entry)).toBe(true)
    expect(isLegacyMaximalDesktopEntry("other", entry)).toBe(false)
    expect(
      isLegacyMaximalDesktopEntry("maximal", {
        ...entry,
        args: ["mcp", "stdio", "--url", "http://127.0.0.1:64792/mcp/workiq"],
      }),
    ).toBe(false)
  })
})
