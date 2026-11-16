import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { PluginClientEntry } from "~/lib/plugins/clients/sync"

import {
  createClaudeDesktopPluginClient,
  isMaximalDesktopEntry,
  resolveAdapterCommand,
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
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-plugin-client-"))
    file = path.join(dir, "claude_desktop_config.json")
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function client(writable = true) {
    return createClaudeDesktopPluginClient({
      configPath: () => file,
      integrationOn: () => true,
      writable: () => writable,
      resolveCommand: () => COMMAND,
    })
  }

  test("writes one aggregate server with the app identity key", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        deploymentMode: "3p",
        preferences: { keep: true },
        mcpServers: { foreign: { command: "foreign" } },
      }),
    )

    expect(client().apply(DESIRED, [])).toEqual({
      written: ["maximal"],
      removed: [],
    })

    expect(readJson(file)).toEqual({
      deploymentMode: "3p",
      preferences: { keep: true },
      mcpServers: {
        foreign: { command: "foreign" },
        maximal: {
          command: COMMAND,
          args: [
            "mcp",
            "stdio",
            "--url",
            expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
          ],
          env: { MAXIMAL_MCP_API_KEY: "desktop-identity-key" },
        },
      },
    })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  test("is idempotent and rewrites only owned transport fields", () => {
    client().apply(DESIRED, [])
    const first = fs.readFileSync(file, "utf8")
    expect(client().apply(DESIRED, [])).toEqual({ written: [], removed: [] })
    expect(fs.readFileSync(file, "utf8")).toBe(first)

    const document = readJson(file)
    const servers = document.mcpServers as Record<
      string,
      Record<string, unknown>
    >
    servers.maximal.note = "keep"
    servers.maximal.env = {
      ...(servers.maximal.env as Record<string, unknown>),
      KEEP: "yes",
    }
    fs.writeFileSync(file, JSON.stringify(document))

    const changed = [{ ...DESIRED[0], apiKey: "rotated-key" }]
    expect(client().apply(changed, [])).toEqual({
      written: ["maximal"],
      removed: [],
    })
    const entry = (
      readJson(file).mcpServers as Record<string, Record<string, unknown>>
    ).maximal
    expect(entry.note).toBe("keep")
    expect(entry.env).toEqual({
      KEEP: "yes",
      MAXIMAL_MCP_API_KEY: "rotated-key",
    })
  })

  test("removes only its signed entry and preserves foreign configuration", () => {
    client().apply(DESIRED, [])
    const document = readJson(file)
    document.keep = 1
    ;(document.mcpServers as Record<string, unknown>).foreign = {
      command: "foreign",
    }
    fs.writeFileSync(file, JSON.stringify(document))

    expect(client().apply([], [])).toEqual({
      written: [],
      removed: ["maximal"],
    })
    expect(readJson(file)).toEqual({
      keep: 1,
      mcpServers: { foreign: { command: "foreign" } },
    })
  })

  test("leaves a user's server named maximal untouched", () => {
    const document = {
      mcpServers: {
        maximal: { command: "node", args: ["server.js"] },
      },
    }
    fs.writeFileSync(file, JSON.stringify(document))

    expect(client().apply(DESIRED, [])).toEqual({ written: [], removed: [] })
    expect(readJson(file)).toEqual(document)
  })

  test("does not write or remove when another profile owns the file", () => {
    client().apply(DESIRED, [])
    const before = fs.readFileSync(file, "utf8")
    expect(client(false).apply([], [])).toEqual({ written: [], removed: [] })
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })

  test("refuses unreadable files and symbolic links", () => {
    fs.writeFileSync(file, "{")
    expect(() => client().apply(DESIRED, [])).toThrow("can't be read")

    fs.rmSync(file)
    const target = path.join(dir, "target.json")
    fs.writeFileSync(target, "{}")
    fs.symlinkSync(target, file)
    expect(() => client().apply(DESIRED, [])).toThrow("symbolic link")
    expect(fs.readFileSync(target, "utf8")).toBe("{}")
  })
})

describe("Claude Desktop adapter ownership", () => {
  test("recognizes only the aggregate maximal command", () => {
    const entry = {
      command: COMMAND,
      args: ["mcp", "stdio", "--url", "http://127.0.0.1:64792/mcp"],
    }
    expect(isMaximalDesktopEntry("maximal", entry)).toBe(true)
    expect(isMaximalDesktopEntry("other", entry)).toBe(false)
    expect(
      isMaximalDesktopEntry("maximal", {
        ...entry,
        args: ["mcp", "stdio", "--url", "http://127.0.0.1:64792/mcp/workiq"],
      }),
    ).toBe(false)
  })

  test("accepts installed packaged commands and rejects Bun or transient paths", () => {
    expect(resolveAdapterCommand(COMMAND, () => true)).toBe(COMMAND)
    expect(
      resolveAdapterCommand("/usr/local/bin/bun", () => true),
    ).toBeUndefined()
    expect(
      resolveAdapterCommand(
        "/private/var/folders/x/AppTranslocation/Maximal.app/Contents/MacOS/maximal",
        () => true,
      ),
    ).toBeUndefined()
    expect(
      resolveAdapterCommand("/Volumes/Maximal/maximal", () => true),
    ).toBeUndefined()
    expect(
      resolveAdapterCommand("/usr/bin/maximal", () => false),
    ).toBeUndefined()
  })
})
