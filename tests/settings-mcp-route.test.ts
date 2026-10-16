/**
 * /settings/api/mcp — endpoint toggle contract.
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

import { getConfig, writeConfig } from "~/lib/config/config"
import {
  McpEndpointsListResponse,
  McpEndpointToggleResponse,
} from "~/lib/config/settings-types"
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
