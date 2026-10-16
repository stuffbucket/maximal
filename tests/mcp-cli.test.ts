/**
 * `maximal mcp` — the terminal side of the endpoint toggle.
 *
 * Uses the real config module (temp COPILOT_API_HOME) and a temp
 * CLAUDE_CONFIG_DIR, so Claude Code's integration is off and nothing is
 * written to it. Every enable keeps Claude Desktop out of the client list,
 * so no real Claude Desktop config is touched. The endpoint id is unique so
 * no real client entry can be adopted. A stub server stands in for the
 * running Maximal the CLI asks to reload.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import { runCommand } from "citty"
import consola from "consola"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { McpEndpointView } from "~/apps/mcp"
import type { AppConfig } from "~/lib/config/config"

import { mcpCommand, promptClients } from "~/apps/mcp-cli"
import { getConfig, writeConfig } from "~/lib/config/config"
import { stopBrokerSupervisor } from "~/lib/mcp-broker/supervisor"

const ID = "cli-fixture-4b2e"

function config(server: Record<string, unknown> = {}): AppConfig {
  return {
    mcpBroker: {
      enabled: false,
      servers: [
        {
          id: ID,
          label: "Fixture",
          enabled: false,
          transport: { type: "stdio", command: "fixture-mcp" },
          ...server,
        },
      ],
    },
  }
}

const saved = () => getConfig().mcpBroker?.servers?.[0]

// Stand-in for a running Maximal: answers /status and records reloads.
const reloads: Array<string> = []
const running = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === "/status") return Response.json({ service: "maximal" })
    if (pathname === "/_internal/reload" && req.method === "POST") {
      reloads.push(pathname)
      return Response.json({ ok: true })
    }
    return new Response(null, { status: 404 })
  },
})

function run(...rawArgs: Array<string>) {
  return runCommand(mcpCommand, {
    rawArgs: [...rawArgs, "--port", String(running.port)],
  })
}

const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cli-"))
const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR

// Like the real CLI process: no broker supervisor runs here.
beforeAll(async () => {
  await stopBrokerSupervisor()
})

beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  reloads.length = 0
  writeConfig(config())
})

afterAll(() => {
  void running.stop(true)
  if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir
  fs.rmSync(claudeDir, { recursive: true, force: true })
  writeConfig({})
})

describe("maximal mcp <id> --enable / --disable", () => {
  test("--enable --clients saves the choice and turns the broker on", async () => {
    await run(ID, "--enable", "--clients", "claude-code")
    expect(getConfig().mcpBroker?.enabled).toBe(true)
    expect(saved()).toMatchObject({ enabled: true, clients: ["claude-code"] })
  })

  test("--disable keeps the remembered client choice", async () => {
    writeConfig(config({ enabled: true, clients: ["claude-code"] }))
    await run(ID, "--disable")
    expect(saved()).toMatchObject({ enabled: false, clients: ["claude-code"] })
  })

  describe("in an interactive terminal", () => {
    const wasTty = process.stdin.isTTY
    beforeEach(() => {
      process.stdin.isTTY = true
    })
    afterEach(() => {
      process.stdin.isTTY = wasTty
    })

    test("--unattended keeps the remembered choice without prompting", async () => {
      writeConfig(config({ clients: ["claude-code"] }))
      const prompt = spyOn(consola, "prompt")
      try {
        await run(ID, "--enable", "--unattended")
        expect(prompt).not.toHaveBeenCalled()
      } finally {
        prompt.mockRestore()
      }
      expect(saved()).toMatchObject({ enabled: true, clients: ["claude-code"] })
    })
  })

  test("asks the running Maximal to reload, since the CLI has no broker", async () => {
    await run(ID, "--enable", "--clients", "")
    expect(reloads).toEqual(["/_internal/reload"])
  })

  test("rejects an unknown client and leaves config alone", async () => {
    const error = await run(ID, "--enable", "--clients", "vim").then(
      () => undefined,
      (error_: unknown) => error_,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("Unknown client(s): vim")
    expect(saved()).toMatchObject({ enabled: false })
    expect(reloads).toEqual([])
  })

  test("an unknown endpoint fails without changing anything", async () => {
    try {
      await run("nope", "--enable")
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = 0
    }
    expect(saved()).toMatchObject({ enabled: false })
  })
})

const servers = () => getConfig().mcpBroker?.servers ?? []
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error_: unknown) => error_ as Error,
  )

describe("maximal mcp <id> --add / --remove", () => {
  const ADDED = "cli-added-9c1f"
  // `--port` goes before `--`: everything after it is the server's command.
  const add = (...rest: Array<string>) =>
    runCommand(mcpCommand, {
      rawArgs: [ADDED, "--add", "--port", String(running.port), ...rest],
    })

  test("adds a stdio server given after --, off, and asks Maximal to reload", async () => {
    await add("--label", "Added", "--", "/opt/added/server", "--stdio", "-v")
    expect(servers().find((server) => server.id === ADDED)).toEqual({
      id: ADDED,
      label: "Added",
      enabled: false,
      transport: {
        type: "stdio",
        command: "/opt/added/server",
        args: ["--stdio", "-v"],
      },
    })
    expect(reloads).toEqual(["/_internal/reload"])
  })

  test("refuses a bare command name, which Maximal's PATH may not find", async () => {
    const error = await failure(add("--", "server"))
    expect(error?.message).toContain("full path")
    expect(servers().map((server) => server.id)).toEqual([ID])
  })

  test("an id that isn't in the catalog needs a command", async () => {
    const error = await failure(add())
    expect(error?.message).toContain("isn't a known MCP server")
    expect(servers().map((server) => server.id)).toEqual([ID])
  })

  test("refuses an id that's already an endpoint", async () => {
    const error = await failure(
      runCommand(mcpCommand, {
        rawArgs: [ID, "--add", "--", "/opt/added/server"],
      }),
    )
    expect(error?.message).toContain("already exists")
  })

  test("--remove takes the endpoint out of config", async () => {
    await run(ID, "--remove")
    expect(servers()).toEqual([])
    expect(reloads).toEqual(["/_internal/reload"])
  })

  test("only one action at a time", async () => {
    const error = await failure(run(ID, "--enable", "--remove"))
    expect(error?.message).toContain("only one of")
    expect(servers().map((server) => server.id)).toEqual([ID])
  })

  describe("in an interactive terminal", () => {
    const wasTty = process.stdin.isTTY
    beforeEach(() => {
      process.stdin.isTTY = true
    })
    afterEach(() => {
      process.stdin.isTTY = wasTty
    })

    test("declining the confirm adds or removes nothing", async () => {
      const prompt = spyOn(consola, "prompt").mockResolvedValue(false)
      try {
        await add("--", "/opt/added/server")
        await run(ID, "--remove")
        expect(prompt).toHaveBeenCalledTimes(2)
      } finally {
        prompt.mockRestore()
      }
      expect(servers().map((server) => server.id)).toEqual([ID])
      expect(reloads).toEqual([])
    })

    test("--unattended doesn't ask", async () => {
      const prompt = spyOn(consola, "prompt")
      try {
        await run(ID, "--remove", "--unattended")
        expect(prompt).not.toHaveBeenCalled()
      } finally {
        prompt.mockRestore()
      }
      expect(servers()).toEqual([])
    })
  })
})

function view(
  clients: McpEndpointView["clients"],
  desktopAvailable: boolean,
): McpEndpointView {
  return {
    id: ID,
    label: "Fixture",
    enabled: false,
    clients,
    offered: [
      {
        id: "claude-code",
        name: "Claude Code",
        available: true,
        configured: false,
      },
      {
        id: "claude-desktop",
        name: "Claude Desktop",
        available: desktopAvailable,
        configured: false,
      },
    ],
  }
}

/** The multiselect options promptClients passed to consola.prompt. */
function promptOptions(prompt: { mock: { calls: Array<Array<unknown>> } }): {
  offered: Array<string>
  initial: Array<string>
} {
  const options = prompt.mock.calls[0][1] as {
    options: Array<{ value: string }>
    initial: Array<string>
  }
  return {
    offered: options.options.map((o) => o.value),
    initial: options.initial,
  }
}

describe("promptClients", () => {
  let prompt: ReturnType<typeof spyOn<typeof consola, "prompt">>
  afterEach(() => {
    prompt.mockRestore()
  })

  test("offers only available clients, pre-checked from the last choice", async () => {
    prompt = spyOn(consola, "prompt").mockResolvedValue(["claude-code"])
    await promptClients(view(["claude-code", "claude-desktop"], true))
    expect(promptOptions(prompt)).toEqual({
      offered: ["claude-code", "claude-desktop"],
      initial: ["claude-code", "claude-desktop"],
    })
  })

  test("keeps a remembered client that can't be offered right now", async () => {
    prompt = spyOn(consola, "prompt").mockResolvedValue([])
    const chosen = await promptClients(view(["claude-desktop"], false))
    expect(promptOptions(prompt)).toEqual({
      offered: ["claude-code"],
      initial: [],
    })
    expect(chosen).toEqual(["claude-desktop"])
  })

  test("cancelling keeps the last choice", async () => {
    prompt = spyOn(consola, "prompt").mockResolvedValue(null as never)
    expect(await promptClients(view(["claude-code"], true))).toBeUndefined()
  })

  test("doesn't prompt when no client integration is on", async () => {
    prompt = spyOn(consola, "prompt")
    const none = view([], false)
    none.offered[0].available = false
    expect(await promptClients(none)).toBeUndefined()
    expect(prompt).not.toHaveBeenCalled()
  })
})
