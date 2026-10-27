/**
 * What Maximal's shutdown does to the MCP entries it wrote into client apps.
 *
 * Uses the real config module and app registry; the test preload sandboxes
 * the home directory, so Claude Desktop's config lands in a temp dir.
 * Claude Code's config is pointed at a temp dir with CLAUDE_CONFIG_DIR.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { claudeDesktopConfigPath } from "~/apps/claude-desktop/mcp"
import { removeMcpClientsOnShutdown } from "~/apps/mcp"
import { getConfig, writeConfig } from "~/lib/config/config"

const BROKER = "/Applications/Maximal.app/Contents/MacOS/maximal-mcp-broker"
const URL = "http://127.0.0.1:4141/mcp/workiq"

const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shutdown-"))
const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR
const claudeJson = path.join(claudeDir, ".claude.json")

const desktopEntry = {
  command: BROKER,
  args: ["stdio-adapter", "--url", URL],
}
const codeEntry = { type: "http", url: URL }

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

function serversIn(file: string): Record<string, unknown> {
  // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
  const top = JSON.parse(fs.readFileSync(file, "utf8")) as {
    mcpServers?: Record<string, unknown>
  }
  return top.mcpServers ?? {}
}

beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  writeJson(claudeDesktopConfigPath(), {
    deploymentMode: "3p",
    mcpServers: { workiq: desktopEntry },
  })
  writeJson(claudeJson, { mcpServers: { workiq: codeEntry } })
  writeConfig({
    mcpBroker: {
      enabled: true,
      servers: [
        {
          id: "workiq",
          label: "Work IQ",
          enabled: true,
          clients: ["claude-desktop", "claude-code"],
          transport: { type: "stdio", command: "workiq" },
        },
      ],
    },
    apps: {
      claudeDesktop: { mcpServers: ["workiq"] },
      claudeCode: { mcpServers: ["workiq"] },
    },
  })
})

afterAll(() => {
  writeConfig({})
  if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir
  fs.rmSync(claudeDir, { recursive: true, force: true })
  fs.rmSync(claudeDesktopConfigPath(), { force: true })
})

describe("removeMcpClientsOnShutdown", () => {
  test("leaves Claude Desktop's entry in place", () => {
    // Desktop reads its config only at launch: removing the entry while it
    // runs does nothing for it, and the next launch would come up without
    // the server even though Maximal is back by then.
    removeMcpClientsOnShutdown()

    expect(serversIn(claudeDesktopConfigPath()).workiq).toEqual(desktopEntry)
    expect(getConfig().apps?.claudeDesktop?.mcpServers).toEqual(["workiq"])
  })

  test("still takes Claude Code's entry out", () => {
    // New Claude Code sessions read the file when they start, so a session
    // started while Maximal is down must not get a dead server.
    removeMcpClientsOnShutdown()

    expect(serversIn(claudeJson).workiq).toBeUndefined()
    expect(getConfig().apps?.claudeCode?.mcpServers).toEqual([])
  })
})
