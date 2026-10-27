/**
 * /settings/api/mcp — list, add, toggle, and remove contract.
 *
 * Uses the real config module (temp COPILOT_API_HOME) and the real app
 * registry. Every case keeps the set of client entries to write empty, so
 * the shared sync short-circuits and no real client config is read or
 * written; per-client writing is covered by the configurator tests.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { AppConfig } from "~/lib/config/config"

import { keyPlaceholder } from "~/apps/claude-code/mcp"
import { getConfig, writeConfig } from "~/lib/config/config"
import {
  McpEndpointAddResponse,
  McpEndpointRemoveResponse,
  McpEndpointsListResponse,
  McpEndpointToggleResponse,
  WorkIqActionResponse,
} from "~/lib/config/settings-types"
import {
  __resetNpmPrefixForTests,
  __setNpmPrefixDepsForTests,
} from "~/lib/system/run-file"
import { mcpRoutes } from "~/routes/settings/mcp"

function buildApp() {
  const app = new Hono()
  app.route("/mcp", mcpRoutes)
  return app
}

function config(server: Record<string, unknown> = {}): AppConfig {
  return {
    mcpBroker: {
      enabled: false,
      servers: [
        {
          id: "workiq",
          label: "Work IQ",
          enabled: false,
          transport: { type: "stdio", command: "workiq", args: ["mcp"] },
          ...server,
        },
      ],
    },
  }
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

beforeEach(() => {
  writeConfig(config())
})

afterAll(() => {
  writeConfig({})
})

describe("GET /mcp", () => {
  test("lists configured endpoints with both Claude clients offered", async () => {
    const res = await buildApp().request("/mcp")
    expect(res.status).toBe(200)
    const body = McpEndpointsListResponse.parse(await res.json())
    expect(body.endpoints).toHaveLength(1)
    expect(body.endpoints[0]).toMatchObject({
      id: "workiq",
      label: "Work IQ",
      enabled: false,
      clients: [],
    })
    expect(body.endpoints[0].offered.map((client) => client.id).sort()).toEqual(
      ["claude-code", "claude-desktop"],
    )
    // Broker health rides along so the UI can tell "fixing itself" from
    // "needs the user"; no broker has started in this process.
    expect(body.broker.problem).toBeNull()
  })
})

describe("GET /mcp key repair", () => {
  // A running Claude Code can write back the copy of ~/.claude.json it read
  // before Maximal swapped the placeholder for the key, so the entry 401s.
  const ID = "keyfix-fixture-2c9d"
  const KEY = "endpoint-key-for-keyfix"
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-keyfix-"))
  const claudeJson = path.join(claudeDir, ".claude.json")
  const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR
  const served = (): AppConfig => {
    const base = config({
      id: ID,
      enabled: true,
      clients: ["claude-code"],
      apiKey: KEY,
    })
    return { ...base, mcpBroker: { ...base.mcpBroker, enabled: true } }
  }

  beforeEach(() => {
    process.env.CLAUDE_CONFIG_DIR = claudeDir
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          [ID]: {
            type: "http",
            url: `http://127.0.0.1:4141/mcp/${ID}`,
            headers: { Authorization: keyPlaceholder(KEY) },
          },
        },
      }),
    )
    writeConfig({ ...served(), apps: { claudeCode: { mcpServers: [ID] } } })
  })

  afterAll(() => {
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir
    fs.rmSync(claudeDir, { recursive: true, force: true })
  })

  const header = (): unknown => {
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
    const text = fs.readFileSync(claudeJson, "utf8")
    const document = JSON.parse(text) as {
      mcpServers: Record<string, { headers?: { Authorization?: string } }>
    }
    return document.mcpServers[ID].headers?.Authorization
  }

  test("puts the key back into an entry Maximal owns", async () => {
    const res = await buildApp().request("/mcp")
    expect(res.status).toBe(200)
    expect(header()).toBe(`Bearer ${KEY}`)
  })

  test("leaves an entry Maximal doesn't own alone", async () => {
    writeConfig(served())
    await buildApp().request("/mcp")
    expect(header()).toBe(keyPlaceholder(KEY))
  })
})

/** Point catalog detection at a temp mise dir holding a Work IQ install
 *  for this platform, with nothing on PATH. Returns the executable. */
function fakeWorkiqInstall(dir: string): string {
  const family = { darwin: "osx", win32: "win", linux: "linux" }[
    process.platform as "darwin" | "win32" | "linux"
  ]
  const packageDir = path.join(
    dir,
    "installs",
    "npm-microsoft-workiq",
    "1.0.1",
    "node_modules",
    "@microsoft",
    "workiq",
  )
  const bin = path.join(packageDir, "bin", `${family}-${process.arch}`)
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ version: "1.0.1" }),
  )
  const executable = path.join(
    bin,
    process.platform === "win32" ? "workiq.exe" : "workiq",
  )
  fs.writeFileSync(executable, "")
  fs.chmodSync(executable, 0o755)
  return executable
}

describe("POST /mcp (add a known server)", () => {
  const miseDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-route-mise-"))
  const saved = { mise: process.env.MISE_DATA_DIR, path: process.env.PATH }
  let executable = ""

  beforeEach(() => {
    process.env.MISE_DATA_DIR = miseDir
    process.env.PATH = ""
    // npm's prefix is cached per process; without this, an earlier test's
    // lookup would expose this machine's own global installs.
    __resetNpmPrefixForTests()
    __setNpmPrefixDepsForTests({
      run: () =>
        Promise.resolve({ stdout: "", stderr: "", code: 127, notFound: true }),
    })
    executable = fakeWorkiqInstall(miseDir)
    writeConfig({})
  })

  afterAll(() => {
    __resetNpmPrefixForTests()
    if (saved.mise === undefined) delete process.env.MISE_DATA_DIR
    else process.env.MISE_DATA_DIR = saved.mise
    process.env.PATH = saved.path
    fs.rmSync(miseDir, { recursive: true, force: true })
  })

  test("the list offers it, with where it was found", async () => {
    const res = await buildApp().request("/mcp")
    const body = McpEndpointsListResponse.parse(await res.json())
    expect(body.available).toHaveLength(1)
    expect(body.available[0]).toMatchObject({
      id: "workiq",
      status: "ready",
      command: executable,
    })
  })

  test("adds it off, running the executable found, and stops offering it", async () => {
    const res = await buildApp().request("/mcp", post({ catalogId: "workiq" }))
    expect(res.status).toBe(200)
    const body = McpEndpointAddResponse.parse(await res.json())
    expect(body.endpoint).toMatchObject({ id: "workiq", enabled: false })
    expect(getConfig().mcpBroker?.servers?.[0]).toMatchObject({
      id: "workiq",
      enabled: false,
      catalog: "workiq",
      transport: { command: executable, args: ["mcp"] },
    })

    const list = McpEndpointsListResponse.parse(
      await (await buildApp().request("/mcp")).json(),
    )
    expect(list.available).toEqual([])
  })

  test("409 when already added or not installed; 404 for an unknown id", async () => {
    const app = buildApp()
    expect(
      (await app.request("/mcp", post({ catalogId: "workiq" }))).status,
    ).toBe(200)
    expect(
      (await app.request("/mcp", post({ catalogId: "workiq" }))).status,
    ).toBe(409)

    writeConfig({})
    fs.rmSync(executable)
    expect(
      (await app.request("/mcp", post({ catalogId: "workiq" }))).status,
    ).toBe(409)
    expect(
      (await app.request("/mcp", post({ catalogId: "nope" }))).status,
    ).toBe(404)
    expect((await app.request("/mcp", post({}))).status).toBe(400)
    expect(getConfig().mcpBroker?.servers ?? []).toEqual([])
  })
})

describe("DELETE /mcp/:id", () => {
  test("removes the endpoint from config", async () => {
    writeConfig(config({ enabled: true, clients: [] }))
    const res = await buildApp().request("/mcp/workiq", { method: "DELETE" })
    expect(res.status).toBe(200)
    const body = McpEndpointRemoveResponse.parse(await res.json())
    expect(body.removedFrom).toEqual([])
    expect(getConfig().mcpBroker?.servers).toEqual([])
  })

  test("404 for an unknown endpoint", async () => {
    const res = await buildApp().request("/mcp/nope", { method: "DELETE" })
    expect(res.status).toBe(404)
  })
})

describe("POST /mcp/:id", () => {
  test("turning on enables the endpoint and the broker", async () => {
    const res = await buildApp().request(
      "/mcp/workiq",
      post({ enabled: true, clients: [] }),
    )
    expect(res.status).toBe(200)
    const body = McpEndpointToggleResponse.parse(await res.json())
    expect(body.endpoint.enabled).toBe(true)
    expect(body.skipped).toEqual([])
    expect(body.unavailable).toEqual([])
    expect(body.updated).toEqual([])
    // No broker runs in this test process.
    expect(body.broker).toBe("off")

    const broker = getConfig().mcpBroker
    expect(broker?.enabled).toBe(true)
    expect(broker?.servers?.[0]).toMatchObject({ enabled: true, clients: [] })
  })

  test("turning off keeps the remembered client choice", async () => {
    writeConfig(config({ enabled: true, clients: ["claude-code"] }))
    const res = await buildApp().request(
      "/mcp/workiq",
      post({ enabled: false }),
    )
    expect(res.status).toBe(200)

    const saved = getConfig().mcpBroker?.servers?.[0]
    expect(saved?.enabled).toBe(false)
    expect(saved?.clients).toEqual(["claude-code"])
  })

  test("rejects an unknown endpoint and a malformed body", async () => {
    const app = buildApp()
    expect(
      (await app.request("/mcp/nope", post({ enabled: true }))).status,
    ).toBe(404)
    expect(
      (await app.request("/mcp/workiq", post({ enabled: "yes" }))).status,
    ).toBe(400)
    expect(
      (
        await app.request(
          "/mcp/workiq",
          post({ enabled: true, clients: ["vim"] }),
        )
      ).status,
    ).toBe(400)
  })
})

describe("POST /mcp/:id adoption", () => {
  // Claude Code honors CLAUDE_CONFIG_DIR, so its user config can point at a
  // temp dir; the id is unique so no real client config can match it.
  const ID = "adopt-fixture-7f3a"
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-adopt-"))
  const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    process.env.CLAUDE_CONFIG_DIR = claudeDir
    fs.writeFileSync(
      path.join(claudeDir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          [ID]: {
            type: "stdio",
            command: "/opt/workiq/bin/workiq",
            args: ["mcp", "--verbose"],
            env: { WORKIQ_TENANT: "contoso", WORKIQ_TOKEN: "secret" },
          },
        },
      }),
    )
    writeConfig(config({ id: ID }))
  })

  afterAll(() => {
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir
    fs.rmSync(claudeDir, { recursive: true, force: true })
  })

  test("turning on copies an app's own entry, minus secret-looking env", async () => {
    const res = await buildApp().request(
      `/mcp/${ID}`,
      post({ enabled: true, clients: [] }),
    )
    expect(res.status).toBe(200)
    const body = McpEndpointToggleResponse.parse(await res.json())
    expect(body.adoptedFrom).toBe("Claude Code")
    expect(body.droppedEnvironment).toEqual(["WORKIQ_TOKEN"])

    const saved = getConfig().mcpBroker?.servers?.[0]
    expect(saved?.transport).toEqual({
      type: "stdio",
      command: "/opt/workiq/bin/workiq",
      args: ["mcp", "--verbose"],
    })
    expect(saved?.environment?.values).toEqual({ WORKIQ_TENANT: "contoso" })
    // The app's own entry is left as it was.
    const claudeJson = JSON.parse(
      // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
      fs.readFileSync(path.join(claudeDir, ".claude.json"), "utf8"),
    ) as { mcpServers: Record<string, { command: string }> }
    expect(claudeJson.mcpServers[ID].command).toBe("/opt/workiq/bin/workiq")
  })

  test("turning off does not adopt", async () => {
    writeConfig(config({ id: ID, enabled: true }))
    const res = await buildApp().request(`/mcp/${ID}`, post({ enabled: false }))
    const body = McpEndpointToggleResponse.parse(await res.json())
    expect(body.adoptedFrom).toBeUndefined()
    expect(getConfig().mcpBroker?.servers?.[0]?.transport.command).toBe(
      "workiq",
    )
  })
})

/** Wait for the Work IQ sign-in to finish one way or another. Polls the
 *  endpoint's own status, not the list: the list re-scans for installed
 *  servers and could swap a real `workiq` in for the stand-in. */
async function waitForSignIn(): Promise<string | undefined> {
  for (let i = 0; i < 100; i++) {
    const res = await buildApp().request("/mcp/workiq/workiq")
    const { signIn } = WorkIqActionResponse.parse(await res.json()).workiq
    if (signIn !== "waiting" && signIn !== "restarting") return signIn
    await Bun.sleep(50)
  }
  throw new Error("sign-in didn't settle")
}

describe("Work IQ sign-in routes", () => {
  // A stand-in `workiq`: a shell script keeping its config in a file and
  // logging every command it was asked to run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workiq-route-"))
  const state = path.join(dir, "state")
  const calls = path.join(dir, "calls")
  const slow = path.join(dir, "slow")
  const workiq = path.join(dir, "workiq")
  fs.writeFileSync(
    workiq,
    [
      "#!/bin/sh",
      `echo "$*" >> '${calls}'`,
      `touch '${state}'`,
      'case "$*" in',
      `  "config show") if [ -s '${state}' ]; then cat '${state}'; else echo "No config set."; fi ;;`,
      `  "accept-eula") echo "I-accept-EULA=true" >> '${state}' ;;`,
      `  "config set disableBrokeredAuth=true") echo "disableBrokeredAuth=true" >> '${state}' ;;`,
      `  "auth login") if [ -f '${slow}' ]; then sleep 5; fi; echo "defaultAccount=someone@example.com" >> '${state}' ;;`,
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  const ran = (): Array<string> =>
    fs.existsSync(calls) ?
      fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean)
    : []
  const changed = (): Array<string> =>
    ran().filter((command) => command !== "config show")

  const workiqConfig = (enabled = true): AppConfig => ({
    mcpBroker: {
      enabled: true,
      servers: [
        {
          id: "workiq",
          label: "Work IQ",
          enabled,
          catalog: "workiq",
          transport: { type: "stdio", command: workiq, args: ["mcp"] },
        },
        {
          id: "other",
          label: "Other",
          enabled: true,
          transport: { type: "stdio", command: workiq, args: ["mcp"] },
        },
      ],
    },
  })

  beforeEach(() => {
    for (const file of [state, calls, slow]) fs.rmSync(file, { force: true })
    writeConfig(workiqConfig())
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  test("the list says where Work IQ stands, only for a Work IQ endpoint that is on", async () => {
    const res = await buildApp().request("/mcp")
    const body = McpEndpointsListResponse.parse(await res.json())
    const byId = new Map(body.endpoints.map((e) => [e.id, e]))
    expect(byId.get("workiq")?.workiq).toBeDefined()
    expect(byId.get("other")?.workiq).toBeUndefined()

    writeConfig(workiqConfig(false))
    const off = McpEndpointsListResponse.parse(
      await (await buildApp().request("/mcp")).json(),
    )
    expect(off.endpoints.find((e) => e.id === "workiq")?.workiq).toBeUndefined()
  })

  test.skipIf(process.platform === "win32")(
    "accepting the EULA runs accept-eula and nothing else that changes Work IQ",
    async () => {
      const res = await buildApp().request("/mcp/workiq/workiq/accept-eula", {
        method: "POST",
      })
      expect(res.status).toBe(200)
      const body = WorkIqActionResponse.parse(await res.json())
      expect(body.workiq).toMatchObject({
        eulaAccepted: true,
        signedInBefore: false,
        state: "signin-needed",
      })
      expect(changed()).toEqual(["accept-eula"])
    },
  )

  test.skipIf(process.platform === "win32")(
    "signing in switches to browser sign-in only when asked, then signs in",
    async () => {
      fs.writeFileSync(state, "I-accept-EULA=true\n")
      const res = await buildApp().request(
        "/mcp/workiq/workiq/sign-in",
        post({ useBrowserSignIn: true }),
      )
      expect(res.status).toBe(200)
      expect(WorkIqActionResponse.parse(await res.json()).workiq.signIn).toBe(
        "waiting",
      )
      expect(await waitForSignIn()).toBe("idle")
      expect(changed()).toEqual([
        "config set disableBrokeredAuth=true",
        "auth login",
      ])
      expect(fs.readFileSync(state, "utf8")).toContain("defaultAccount=")

      fs.rmSync(calls)
      await buildApp().request(
        "/mcp/workiq/workiq/sign-in",
        post({ useBrowserSignIn: false }),
      )
      await waitForSignIn()
      expect(changed()).toEqual(["auth login"])
    },
  )

  test.skipIf(process.platform === "win32")(
    "a sign-in can be cancelled",
    async () => {
      fs.writeFileSync(state, "I-accept-EULA=true\n")
      fs.writeFileSync(slow, "")
      await buildApp().request(
        "/mcp/workiq/workiq/sign-in",
        post({ useBrowserSignIn: false }),
      )
      const res = await buildApp().request("/mcp/workiq/workiq/sign-in", {
        method: "DELETE",
      })
      expect(res.status).toBe(200)
      expect(await waitForSignIn()).toBe("cancelled")
      expect(fs.readFileSync(state, "utf8")).not.toContain("defaultAccount=")
    },
  )

  test("rejects endpoints that aren't Work IQ, unknown ones, and a bad body", async () => {
    const app = buildApp()
    expect(
      (await app.request("/mcp/other/workiq/accept-eula", { method: "POST" }))
        .status,
    ).toBe(400)
    expect(
      (await app.request("/mcp/nope/workiq/accept-eula", { method: "POST" }))
        .status,
    ).toBe(404)
    expect(
      (await app.request("/mcp/workiq/workiq/sign-in", post({ browser: 1 })))
        .status,
    ).toBe(400)
    // None of them changed anything.
    expect(changed()).toEqual([])
  })
})
