/**
 * Claude Desktop MCP configurator — ownership-scoped reconcile of the
 * Claude-3p `claude_desktop_config.json` under a temp home.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { McpClientEntry } from "~/lib/mcp-broker/client-sync"

import {
  claudeDesktopConfigPath,
  createClaudeDesktopMcp,
  isOwnedMcpEntry,
} from "~/apps/claude-desktop/mcp"

const BROKER = "/Applications/Maximal.app/Contents/MacOS/maximal-mcp-broker"

let home: string

const entry = (id: string, apiKey?: string): McpClientEntry => ({
  id,
  label: id,
  url: `http://127.0.0.1:4141/mcp/${id}`,
  ...(apiKey === undefined ? {} : { apiKey }),
})

/** `null` simulates a missing broker binary. */
const configurator = (brokerPath: string | null = BROKER) =>
  createClaudeDesktopMcp({
    home,
    resolveBrokerPath: () => brokerPath ?? undefined,
    available: () => Promise.resolve(true),
  })

const readServers = (): Record<string, unknown> | undefined => {
  const file = claudeDesktopConfigPath(home)
  if (!fs.existsSync(file)) return undefined
  // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
  const top = JSON.parse(fs.readFileSync(file, "utf8")) as {
    mcpServers?: Record<string, unknown>
  }
  return top.mcpServers
}

const seed = (top: Record<string, unknown>): void => {
  const file = claudeDesktopConfigPath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(top))
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-desktop-mcp-"))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe("Claude Desktop MCP reconcile", () => {
  test("adds Maximal's generated entry with the key in env", async () => {
    const result = await configurator().reconcile([entry("workiq", "k1")], [])

    expect(result).toEqual({
      owned: ["workiq"],
      added: ["workiq"],
      removed: [],
      skipped: [],
    })
    expect(readServers()).toEqual({
      workiq: {
        command: BROKER,
        args: ["stdio-adapter", "--url", "http://127.0.0.1:4141/mcp/workiq"],
        env: { MAXIMAL_MCP_API_KEY: "k1" },
      },
    })
  })

  test("leaves a same-name entry the user already had alone", async () => {
    const foreign = { command: "npx", args: ["-y", "workiq"] }
    seed({ deploymentMode: "3p", mcpServers: { workiq: foreign } })

    const result = await configurator().reconcile([entry("workiq")], [])

    expect(result.skipped).toEqual(["workiq"])
    expect(result.owned).toEqual([])
    expect(readServers()).toEqual({ workiq: foreign })
  })

  test("rewrites an owned entry when its key changes", async () => {
    const mcp = configurator()
    await mcp.reconcile([entry("workiq", "old")], [])
    const result = await mcp.reconcile([entry("workiq", "new")], ["workiq"])

    expect(result.owned).toEqual(["workiq"])
    expect(result.added).toEqual([])
    expect(
      (readServers()?.workiq as { env: Record<string, string> }).env,
    ).toEqual({ MAXIMAL_MCP_API_KEY: "new" })
  })

  test("reverts only owned entries that still carry Maximal's signature", async () => {
    const foreign = { command: "uvx", args: ["mcp-server-fetch"] }
    seed({ mcpServers: { fetch: foreign } })
    const mcp = configurator()
    await mcp.reconcile([entry("workiq"), entry("other")], [])

    // The user repointed "other" themselves; Maximal must not remove it.
    const servers = readServers() ?? {}
    seed({ mcpServers: { ...servers, other: { command: "mine", args: [] } } })

    const result = await mcp.reconcile([], ["workiq", "other"])

    expect(result.removed).toEqual(["workiq"])
    expect(result.owned).toEqual([])
    expect(readServers()).toEqual({
      fetch: foreign,
      other: { command: "mine", args: [] },
    })
  })

  test("drops mcpServers entirely when the last owned entry goes", async () => {
    const mcp = configurator()
    await mcp.reconcile([entry("workiq")], [])
    await mcp.reconcile([], ["workiq"])
    expect(readServers()).toBeUndefined()
  })

  test("without the broker binary, keeps owned entries and adds nothing", async () => {
    await configurator().reconcile([entry("a")], [])
    const result = await configurator(null).reconcile(
      [entry("a"), entry("b")],
      ["a"],
    )

    expect(result.owned).toEqual(["a"])
    expect(result.skipped).toEqual(["b"])
    expect(Object.keys(readServers() ?? {})).toEqual(["a"])
  })
})

const onPort = (port: number): McpClientEntry => ({
  ...entry("workiq"),
  url: `http://127.0.0.1:${port}/mcp/workiq`,
})

const adapter = (port: number) => ({
  command: BROKER,
  args: ["stdio-adapter", "--url", `http://127.0.0.1:${port}/mcp/workiq`],
})

describe("Claude Desktop MCP across port changes", () => {
  test("moves an owned entry to the port Maximal listens on now", async () => {
    seed({ mcpServers: { workiq: adapter(4141) } })
    const result = await configurator().reconcile([onPort(4199)], ["workiq"])
    expect(result).toEqual({
      owned: ["workiq"],
      added: [],
      removed: [],
      skipped: [],
    })
    expect(readServers()).toEqual({ workiq: adapter(4199) })
  })

  test("reverts an owned entry written on another port", async () => {
    seed({ mcpServers: { workiq: adapter(4199) } })
    const result = await configurator().reconcile([], ["workiq"])
    expect(result.removed).toEqual(["workiq"])
    expect(readServers()).toBeUndefined()
  })
})

describe("isOwnedMcpEntry", () => {
  test("requires the broker adapter pointed at this endpoint's URL", () => {
    const workiq = entry("workiq")
    const args = ["stdio-adapter", "--url", workiq.url]
    expect(isOwnedMcpEntry({ command: BROKER, args }, workiq)).toBe(true)
    expect(
      isOwnedMcpEntry(
        { command: String.raw`C:\Maximal\maximal-mcp-broker.exe`, args },
        workiq,
      ),
    ).toBe(true)
    expect(isOwnedMcpEntry({ command: BROKER, args }, entry("different"))).toBe(
      false,
    )
    expect(isOwnedMcpEntry({ command: "/usr/bin/other", args }, workiq)).toBe(
      false,
    )
    expect(isOwnedMcpEntry(null, workiq)).toBe(false)
  })
})

/** The regular Claude Desktop config, a sibling of the Claude-3p dir. */
const regularConfig = (): string =>
  path.join(
    path.dirname(path.dirname(claudeDesktopConfigPath(home))),
    "Claude",
    "claude_desktop_config.json",
  )

describe("Claude Desktop existing entries", () => {
  test("finds the user's own entry in the regular Claude config", () => {
    fs.mkdirSync(path.dirname(regularConfig()), { recursive: true })
    fs.writeFileSync(
      regularConfig(),
      JSON.stringify({
        mcpServers: {
          workiq: { command: "npx", args: ["-y", "@microsoft/workiq", "mcp"] },
        },
      }),
    )

    expect(configurator().existingStdioEntry?.("workiq", [])).toEqual({
      command: "npx",
      args: ["-y", "@microsoft/workiq", "mcp"],
      env: {},
    })
  })

  test("never offers Maximal's own adapter entry", async () => {
    await configurator().reconcile([entry("workiq")], [])
    expect(configurator().existingStdioEntry?.("workiq", [])).toBeUndefined()
  })
})
