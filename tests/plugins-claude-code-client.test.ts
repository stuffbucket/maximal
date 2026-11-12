/**
 * Claude Code connector entries: `maximal-<id>` HTTP servers written straight
 * into a temp `.claude.json`, the user's own servers and same-name choices
 * left alone, legacy names removed, and the user's own setup of a
 * connector (`standalone`) found by name.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { PluginClientEntry } from "~/lib/plugins/clients/sync"

import {
  createClaudeCodePluginClient,
  entryName,
  isMaximalEntry,
} from "~/lib/plugins/clients/claude-code"

const KEY = "secret-endpoint-key"
const USER_SERVER = { type: "http", url: "https://mcp.example.test/github" }

let dir: string
let file: string
let settings: string

const entry = (
  id: string,
  apiKey?: string,
  port = 4141,
): PluginClientEntry => ({
  id,
  url: `http://127.0.0.1:${port}/mcp/${id}`,
  ...(apiKey === undefined ? {} : { apiKey }),
})

const ours = (id: string, apiKey?: string, port = 4141) => ({
  type: "http",
  url: `http://127.0.0.1:${port}/mcp/${id}`,
  ...(apiKey === undefined ?
    {}
  : { headers: { Authorization: `Bearer ${apiKey}` } }),
})

const readDocument = (): Record<string, unknown> =>
  // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
  JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>

const servers = (): Record<string, unknown> =>
  (readDocument().mcpServers ?? {}) as Record<string, unknown>

const writeDocument = (document: Record<string, unknown>): void => {
  fs.writeFileSync(file, JSON.stringify(document, null, 2))
}

const client = () =>
  createClaudeCodePluginClient({
    configPath: () => file,
    settingsPath: () => settings,
    integrationOn: () => true,
  })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-mcp-"))
  file = path.join(dir, ".claude.json")
  settings = path.join(dir, "settings.json")
  writeDocument({ numStartups: 7, mcpServers: { github: USER_SERVER } })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("apply", () => {
  test("adds maximal-<id> with the real key, keeping everything else", () => {
    const result = client().apply([entry("workiq", KEY)], [])

    expect(result).toEqual({ written: ["maximal-workiq"], removed: [] })
    expect(readDocument().numStartups).toBe(7)
    expect(servers()).toEqual({
      github: USER_SERVER,
      "maximal-workiq": ours("workiq", KEY),
    })
  })

  test("writes nothing when the entry already matches", () => {
    client().apply([entry("workiq", KEY)], [])
    const before = fs.readFileSync(file, "utf8")

    expect(client().apply([entry("workiq", KEY)], [])).toEqual({
      written: [],
      removed: [],
    })
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })

  test("rewrites the entry for a new port, a new key, or no key", () => {
    client().apply([entry("workiq", KEY)], [])

    client().apply([entry("workiq", KEY, 4142)], [])
    expect(servers()["maximal-workiq"]).toEqual(ours("workiq", KEY, 4142))

    client().apply([entry("workiq", "rotated", 4142)], [])
    expect(servers()["maximal-workiq"]).toEqual(ours("workiq", "rotated", 4142))

    client().apply([entry("workiq", undefined, 4142)], [])
    expect(servers()["maximal-workiq"]).toEqual(ours("workiq", undefined, 4142))
  })

  test("removes Maximal's entries that are no longer wanted, on any port", () => {
    writeDocument({
      mcpServers: {
        github: USER_SERVER,
        "maximal-workiq": ours("workiq", KEY, 4999),
        "maximal-gone": ours("gone"),
      },
    })

    const result = client().apply([], [])

    expect(result.removed.sort()).toEqual(["maximal-gone", "maximal-workiq"])
    expect(servers()).toEqual({ github: USER_SERVER })
  })

  test("never touches entries that aren't Maximal's", () => {
    const theirs = {
      github: USER_SERVER,
      // The user's own name for Maximal's endpoint.
      mine: ours("workiq"),
      // `maximal-<id>` taken for something else.
      "maximal-workiq": { type: "http", url: "https://elsewhere.test/mcp" },
      // Right name, wrong path.
      "maximal-other": ours("workiq"),
    }
    writeDocument({ mcpServers: theirs })

    expect(client().apply([entry("workiq", KEY)], [])).toEqual({
      written: [],
      removed: [],
    })
    expect(servers()).toEqual(theirs)
  })

  test("removes legacy names that still point at Maximal", () => {
    writeDocument({
      mcpServers: {
        github: USER_SERVER,
        workiq: ours("workiq", KEY, 4141),
        // Recorded once, since replaced by the user's own.
        other: { command: "other-server" },
      },
    })

    const result = client().apply([entry("workiq", KEY)], ["workiq", "other"])

    expect(result).toEqual({ written: ["maximal-workiq"], removed: ["workiq"] })
    expect(servers()).toEqual({
      github: USER_SERVER,
      other: { command: "other-server" },
      "maximal-workiq": ours("workiq", KEY),
    })
  })

  test("creates the config only to add something", () => {
    fs.rmSync(file)
    client().apply([], [])
    expect(fs.existsSync(file)).toBe(false)

    client().apply([entry("workiq", KEY)], [])
    expect(servers()).toEqual({ "maximal-workiq": ours("workiq", KEY) })
  })

  test("refuses to replace a config it can't read", () => {
    fs.writeFileSync(file, '{ "mcpServers": ')
    expect(() => client().apply([entry("workiq", KEY)], [])).toThrow()
    expect(fs.readFileSync(file, "utf8")).toBe('{ "mcpServers": ')
  })
})

describe("standalone", () => {
  test("a user server named after the connector, any case", () => {
    writeDocument({
      mcpServers: {
        WorkIQ: {
          command: "npx",
          args: ["-y", "@microsoft/workiq@latest", "mcp"],
        },
      },
    })
    expect(client().standalone("workiq")).toEqual({
      name: "WorkIQ",
      source: "server",
    })
  })

  test("an enabled Claude Code plugin named after the connector", () => {
    fs.writeFileSync(
      settings,
      JSON.stringify({
        enabledPlugins: { "workiq@work-iq": true, "other@work-iq": true },
      }),
    )
    expect(client().standalone("workiq")).toEqual({
      name: "workiq@work-iq",
      source: "plugin",
    })
  })

  test("not Maximal's own entries, a disabled plugin, or other names", () => {
    writeDocument({
      mcpServers: {
        // An older Maximal's entry, removed on the next pass.
        workiq: ours("workiq"),
        "maximal-workiq": ours("workiq"),
        "workiq-preview": { command: "workiq", args: ["mcp"] },
      },
    })
    fs.writeFileSync(
      settings,
      JSON.stringify({ enabledPlugins: { "workiq@work-iq": false } }),
    )
    expect(client().standalone("workiq")).toBeUndefined()
  })
})

test("names and recognises Maximal's entries", () => {
  expect(entryName("workiq")).toBe("maximal-workiq")
  expect(isMaximalEntry("maximal-workiq", ours("workiq", KEY, 5000))).toBe(true)
  expect(isMaximalEntry("workiq", ours("workiq"))).toBe(false)
  expect(
    isMaximalEntry("maximal-workiq", {
      type: "http",
      url: "http://localhost:4141/mcp/workiq",
    }),
  ).toBe(false)
})
