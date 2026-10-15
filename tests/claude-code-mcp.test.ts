/**
 * Claude Code MCP configurator — user-scope entries written through a fake
 * `claude` CLI that edits a temp `.claude.json` the way the real one does.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { McpClientEntry } from "~/lib/mcp-broker/client-sync"

import { createClaudeCodeMcp, keyPlaceholder } from "~/apps/claude-code/mcp"

const KEY = "secret-endpoint-key"

let dir: string
let file: string
let calls: Array<Array<string>>

const entry = (id: string, apiKey?: string): McpClientEntry => ({
  id,
  label: id,
  url: `http://127.0.0.1:4141/mcp/${id}`,
  ...(apiKey === undefined ? {} : { apiKey }),
})

const readDocument = (): Record<string, unknown> =>
  // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
  JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>

const servers = (): Record<string, Record<string, unknown>> =>
  (readDocument().mcpServers ?? {}) as Record<string, Record<string, unknown>>

const writeDocument = (document: Record<string, unknown>): void => {
  fs.writeFileSync(file, JSON.stringify(document, null, 2))
}

/** Mimics `claude mcp add-json/remove --scope user`. */
const fakeClaude = (args: Array<string>): void => {
  calls.push(args)
  const document = fs.existsSync(file) ? readDocument() : {}
  const mcpServers = (document.mcpServers ?? {}) as Record<string, unknown>
  // Argument layout: mcp <verb> --scope user <id> [json]
  const id = args[4]
  const next =
    args[1] === "add-json" ?
      { ...mcpServers, [id]: JSON.parse(args[5]) as unknown }
    : Object.fromEntries(Object.entries(mcpServers).filter(([k]) => k !== id))
  writeDocument({ ...document, mcpServers: next })
}

const configurator = (runnerAvailable = true) =>
  createClaudeCodeMcp({
    configPath: () => file,
    runner: () => (runnerAvailable ? fakeClaude : undefined),
    available: () => true,
  })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-mcp-"))
  file = path.join(dir, ".claude.json")
  calls = []
  writeDocument({ numStartups: 7, projects: {} })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("Claude Code MCP reconcile", () => {
  test("adds via the CLI with only a placeholder, then stores the real key", () => {
    const result = configurator().reconcile([entry("workiq", KEY)], [])

    expect(result.added).toEqual(["workiq"])
    expect(result.owned).toEqual(["workiq"])
    expect(calls).toHaveLength(1)
    expect(calls[0].slice(0, 5)).toEqual([
      "mcp",
      "add-json",
      "--scope",
      "user",
      "workiq",
    ])
    for (const args of calls) {
      expect(args.join(" ")).not.toContain(KEY)
    }
    expect(calls[0][5]).toContain(keyPlaceholder(KEY).replace("Bearer ", ""))

    expect(servers().workiq).toEqual({
      type: "http",
      url: "http://127.0.0.1:4141/mcp/workiq",
      headers: { Authorization: `Bearer ${KEY}` },
    })
    // Unrelated Claude Code state survives the key swap.
    expect(readDocument().numStartups).toBe(7)
  })

  test("adds without headers when there is no key", () => {
    configurator().reconcile([entry("open")], [])
    expect(servers().open).toEqual({
      type: "http",
      url: "http://127.0.0.1:4141/mcp/open",
    })
  })

  test("leaves a same-name entry the user already had alone", () => {
    const theirs = { type: "stdio", command: "workiq", args: ["mcp"] }
    writeDocument({ mcpServers: { workiq: theirs } })

    const result = configurator().reconcile([entry("workiq", KEY)], [])

    expect(result.skipped).toEqual(["workiq"])
    expect(calls).toEqual([])
    expect(servers().workiq).toEqual(theirs)
  })

  test("does nothing when the owned entry already matches", () => {
    const mcp = configurator()
    mcp.reconcile([entry("workiq", KEY)], [])
    calls = []
    const before = fs.readFileSync(file, "utf8")

    const result = mcp.reconcile([entry("workiq", KEY)], ["workiq"])

    expect(result).toEqual({
      owned: ["workiq"],
      added: [],
      removed: [],
      skipped: [],
    })
    expect(calls).toEqual([])
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })

  test("repairs a placeholder left behind and rotates a key in place", () => {
    const mcp = configurator()
    mcp.reconcile([entry("workiq", KEY)], [])
    const document = readDocument()
    const list = document.mcpServers as Record<string, Record<string, unknown>>
    list.workiq.headers = { Authorization: keyPlaceholder(KEY) }
    writeDocument(document)
    calls = []

    mcp.reconcile([entry("workiq", KEY)], ["workiq"])
    expect(servers().workiq.headers).toEqual({ Authorization: `Bearer ${KEY}` })

    mcp.reconcile([entry("workiq", "rotated")], ["workiq"])
    expect(servers().workiq.headers).toEqual({
      Authorization: "Bearer rotated",
    })
    expect(calls).toEqual([])
  })

  test("removes only owned entries still pointing at Maximal", () => {
    const mcp = configurator()
    mcp.reconcile([entry("workiq"), entry("other")], [])
    const document = readDocument()
    const list = document.mcpServers as Record<string, unknown>
    list.other = { type: "http", url: "https://example.com/mcp" }
    writeDocument(document)
    calls = []

    const result = mcp.reconcile([], ["workiq", "other"])

    expect(result.removed).toEqual(["workiq"])
    expect(result.owned).toEqual([])
    expect(calls).toEqual([["mcp", "remove", "--scope", "user", "workiq"]])
    expect(Object.keys(servers())).toEqual(["other"])
  })

  test("keeps ownership when the CLI is unavailable for a removal", () => {
    configurator().reconcile([entry("workiq")], [])
    const result = configurator(false).reconcile([], ["workiq"])

    expect(result.owned).toEqual(["workiq"])
    expect(result.removed).toEqual([])
    expect(servers().workiq).toBeDefined()
  })
})

describe("Claude Code MCP shutdown and adoption", () => {
  test("offline removal edits the file and never runs the CLI", () => {
    const mcp = configurator()
    mcp.reconcile([entry("workiq", KEY)], [])
    calls = []

    const result = mcp.reconcile([], ["workiq"], { offline: true })

    expect(result.removed).toEqual(["workiq"])
    expect(result.owned).toEqual([])
    expect(calls).toEqual([])
    expect(servers().workiq).toBeUndefined()
    expect(readDocument().numStartups).toBe(7)
  })

  test("offline mode adds nothing", () => {
    const result = configurator().reconcile([entry("workiq")], [], {
      offline: true,
    })
    expect(result.owned).toEqual([])
    expect(calls).toEqual([])
  })

  test("finds the user's own stdio entry but never Maximal's", () => {
    writeDocument({
      mcpServers: {
        workiq: {
          type: "stdio",
          command: "workiq",
          args: ["mcp"],
          env: { WORKIQ_TENANT: "contoso" },
        },
        remote: { type: "http", url: "https://example.com/mcp" },
      },
    })
    const mcp = configurator()

    expect(mcp.existingStdioEntry?.("workiq", [])).toEqual({
      command: "workiq",
      args: ["mcp"],
      env: { WORKIQ_TENANT: "contoso" },
    })
    expect(mcp.existingStdioEntry?.("remote", [])).toBeUndefined()
    expect(mcp.existingStdioEntry?.("missing", [])).toBeUndefined()

    mcp.reconcile([entry("ours")], [])
    expect(mcp.existingStdioEntry?.("ours", ["ours"])).toBeUndefined()
  })
})
