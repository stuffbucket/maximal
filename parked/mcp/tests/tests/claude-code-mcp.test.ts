/**
 * Claude Code MCP configurator — user-scope entries written through a fake
 * `claude` CLI that edits a temp `.claude.json` the way the real one does.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { McpClientEntry } from "~/lib/mcp-broker/client-sync"

import {
  type ClaudeCliRunner,
  createClaudeCodeMcp,
  keyPlaceholder,
} from "~/apps/claude-code/mcp"

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
const fakeClaude = (args: Array<string>): Promise<void> => {
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
  return Promise.resolve()
}

const configurator = (runnerAvailable = true) =>
  createClaudeCodeMcp({
    configPath: () => file,
    runner: () => Promise.resolve(runnerAvailable ? fakeClaude : undefined),
    available: () => Promise.resolve(true),
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
  test("adds via the CLI with only a placeholder, then stores the real key", async () => {
    const result = await configurator().reconcile([entry("workiq", KEY)], [])

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

  test("adds without headers when there is no key", async () => {
    await configurator().reconcile([entry("open")], [])
    expect(servers().open).toEqual({
      type: "http",
      url: "http://127.0.0.1:4141/mcp/open",
    })
  })

  test("leaves a same-name entry the user already had alone", async () => {
    const theirs = { type: "stdio", command: "workiq", args: ["mcp"] }
    writeDocument({ mcpServers: { workiq: theirs } })

    const result = await configurator().reconcile([entry("workiq", KEY)], [])

    expect(result.skipped).toEqual(["workiq"])
    expect(calls).toEqual([])
    expect(servers().workiq).toEqual(theirs)
  })

  test("does nothing when the owned entry already matches", async () => {
    const mcp = configurator()
    await mcp.reconcile([entry("workiq", KEY)], [])
    calls = []
    const before = fs.readFileSync(file, "utf8")

    const result = await mcp.reconcile([entry("workiq", KEY)], ["workiq"])

    expect(result).toEqual({
      owned: ["workiq"],
      added: [],
      removed: [],
      skipped: [],
      unavailable: [],
    })
    expect(calls).toEqual([])
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })

  test("repairs a placeholder left behind and rotates a key in place", async () => {
    const mcp = configurator()
    await mcp.reconcile([entry("workiq", KEY)], [])
    const document = readDocument()
    const list = document.mcpServers as Record<string, Record<string, unknown>>
    list.workiq.headers = { Authorization: keyPlaceholder(KEY) }
    writeDocument(document)
    calls = []

    await mcp.reconcile([entry("workiq", KEY)], ["workiq"])
    expect(servers().workiq.headers).toEqual({ Authorization: `Bearer ${KEY}` })

    await mcp.reconcile([entry("workiq", "rotated")], ["workiq"])
    expect(servers().workiq.headers).toEqual({
      Authorization: "Bearer rotated",
    })
    expect(calls).toEqual([])
  })

  test("removes only owned entries still pointing at Maximal", async () => {
    const mcp = configurator()
    await mcp.reconcile([entry("workiq"), entry("other")], [])
    const document = readDocument()
    const list = document.mcpServers as Record<string, unknown>
    list.other = { type: "http", url: "https://example.com/mcp" }
    writeDocument(document)
    calls = []

    const result = await mcp.reconcile([], ["workiq", "other"])

    expect(result.removed).toEqual(["workiq"])
    expect(result.owned).toEqual([])
    expect(calls).toEqual([["mcp", "remove", "--scope", "user", "workiq"]])
    expect(Object.keys(servers())).toEqual(["other"])
  })

  test("keeps ownership when the CLI is unavailable for a removal", async () => {
    await configurator().reconcile([entry("workiq")], [])
    const result = await configurator(false).reconcile([], ["workiq"])

    expect(result.owned).toEqual(["workiq"])
    expect(result.removed).toEqual([])
    expect(servers().workiq).toBeDefined()
  })
})

/** `claude mcp add-json` can write the file and then time out. */
const writesThenTimesOut: ClaudeCliRunner = async (args) => {
  await fakeClaude(args)
  throw new Error("claude ETIMEDOUT")
}

const failsOutright: ClaudeCliRunner = () =>
  Promise.reject(new Error("claude exited 1"))

describe("Claude Code MCP when the CLI fails", () => {
  test("an add that wrote the entry and then failed is still Maximal's", async () => {
    const mcp = createClaudeCodeMcp({
      configPath: () => file,
      runner: () => Promise.resolve(writesThenTimesOut),
      available: () => Promise.resolve(true),
    })

    const result = await mcp.reconcile([entry("workiq", KEY)], [])

    expect(result).toEqual({
      owned: ["workiq"],
      added: ["workiq"],
      removed: [],
      skipped: [],
      unavailable: [],
    })
    // The placeholder was swapped for the real key, so the entry works.
    expect(servers().workiq.headers).toEqual({ Authorization: `Bearer ${KEY}` })
  })

  test("an add that wrote nothing is reported as failed and not owned", async () => {
    const mcp = createClaudeCodeMcp({
      configPath: () => file,
      runner: () => Promise.resolve(failsOutright),
      available: () => Promise.resolve(true),
    })

    const result = await mcp.reconcile([entry("workiq", KEY)], [])

    expect(result.owned).toEqual([])
    expect(result.added).toEqual([])
    expect(result.skipped).toEqual([])
    expect(servers().workiq).toBeUndefined()
  })
})

describe("Claude Code MCP key repair", () => {
  test("puts the real key back when Claude Code restored the placeholder", async () => {
    const mcp = configurator()
    await mcp.reconcile([entry("workiq", KEY)], [])
    // A running Claude Code writes back the copy it read before the swap.
    const document = readDocument()
    const list = document.mcpServers as Record<string, Record<string, unknown>>
    list.workiq.headers = { Authorization: keyPlaceholder(KEY) }
    writeDocument(document)
    calls = []

    mcp.repairKeys?.([entry("workiq", KEY)], ["workiq"])

    expect(servers().workiq.headers).toEqual({ Authorization: `Bearer ${KEY}` })
    expect(calls).toEqual([])
    expect(readDocument().numStartups).toBe(7)
  })

  test("never touches an entry Maximal doesn't own, or the file when nothing's wrong", () => {
    const theirs = {
      type: "http",
      url: "http://127.0.0.1:4141/mcp/workiq",
      headers: { Authorization: "Bearer theirs" },
    }
    writeDocument({ mcpServers: { workiq: theirs } })
    const mcp = configurator()

    mcp.repairKeys?.([entry("workiq", KEY)], [])
    expect(servers().workiq).toEqual(theirs)

    writeDocument({
      mcpServers: {
        workiq: { ...theirs, headers: { Authorization: `Bearer ${KEY}` } },
      },
    })
    const before = fs.statSync(file).mtimeMs
    const text = fs.readFileSync(file, "utf8")
    mcp.repairKeys?.([entry("workiq", KEY)], ["workiq"])
    expect(fs.readFileSync(file, "utf8")).toBe(text)
    expect(fs.statSync(file).mtimeMs).toBe(before)
  })
})

describe("Claude Code MCP shutdown and adoption", () => {
  test("offline removal edits the file and never runs the CLI", async () => {
    const mcp = configurator()
    await mcp.reconcile([entry("workiq", KEY)], [])
    calls = []

    const result = mcp.releaseOffline(["workiq"])

    expect(result.removed).toEqual(["workiq"])
    expect(result.owned).toEqual([])
    expect(calls).toEqual([])
    expect(servers().workiq).toBeUndefined()
    expect(readDocument().numStartups).toBe(7)
  })

  test("offline removal leaves a same-name entry that isn't Maximal's", () => {
    writeDocument({ mcpServers: { workiq: { command: "workiq", args: [] } } })

    const result = configurator().releaseOffline(["workiq"])

    expect(result.removed).toEqual([])
    expect(calls).toEqual([])
    expect(servers().workiq).toEqual({ command: "workiq", args: [] })
  })

  test("finds the user's own stdio entry but never Maximal's", async () => {
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

    await mcp.reconcile([entry("ours")], [])
    expect(mcp.existingStdioEntry?.("ours", ["ours"])).toBeUndefined()
  })
})

const onPort = (port: number): McpClientEntry => ({
  ...entry("workiq", KEY),
  url: `http://127.0.0.1:${port}/mcp/workiq`,
})

describe("Claude Code MCP across port changes", () => {
  test("re-adds an owned entry on the port Maximal listens on now", async () => {
    await configurator().reconcile([onPort(4141)], [])
    calls = []

    const result = await configurator().reconcile([onPort(4199)], ["workiq"])

    expect(result.owned).toEqual(["workiq"])
    expect(result.skipped).toEqual([])
    expect(calls.map((args) => args[1])).toEqual(["remove", "add-json"])
    for (const args of calls) {
      expect(args.join(" ")).not.toContain(KEY)
    }
    expect(servers().workiq).toEqual({
      type: "http",
      url: "http://127.0.0.1:4199/mcp/workiq",
      headers: { Authorization: `Bearer ${KEY}` },
    })
  })

  test("leaves an owned entry alone when nothing changed", async () => {
    await configurator().reconcile([onPort(4199)], [])
    calls = []
    await configurator().reconcile([onPort(4199)], ["workiq"])
    expect(calls).toEqual([])
  })
})
