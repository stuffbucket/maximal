import { loadPlugin, waitFor } from "@stuffbucket/maximal-plugin-sdk/testing"
import { afterEach, describe, expect, test } from "bun:test"

import { defineRemoteMcpConnector } from "../src/define"
import { fakeAuth } from "../src/testing/fake-auth"
import {
  startFakeRemoteMcp,
  type FakeRemoteMcp,
  type FakeRemoteMcpOptions,
} from "../src/testing/fake-server"
import { UpstreamConnection } from "../src/upstream/connection"
import { createUpstreamFetch } from "../src/upstream/fetch"
import { EXAMPLE_MANIFEST, TERMS_URL } from "./fixtures"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fake(options: FakeRemoteMcpOptions = {}): FakeRemoteMcp {
  const server = startFakeRemoteMcp(options)
  cleanups.push(() => server.close())
  return server
}

async function connect(
  server: FakeRemoteMcp,
  versionNegotiation?: "legacy" | "auto",
): Promise<UpstreamConnection> {
  const connection = new UpstreamConnection({
    endpoint: new URL(server.url),
    fetch: createUpstreamFetch({ getToken: () => Promise.resolve("token-1") }),
    clientInfo: { name: "maximal-test", version: "0.0.0" },
    callTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    ...(versionNegotiation ? { versionNegotiation } : {}),
  })
  cleanups.push(() => connection.close())
  await connection.connect()
  return connection
}

const rpcs = (server: FakeRemoteMcp) =>
  server.requests.flatMap((request) => (request.rpc ? [request.rpc] : []))

describe("upstream protocol negotiation", () => {
  test("uses the 2026-07-28 revision (server/discover) when the server offers it", async () => {
    const server = fake({ protocol: "modern" })
    const connection = await connect(server)
    expect(connection.protocol).toEqual({
      version: "2026-07-28",
      era: "modern",
    })
    expect(rpcs(server)).toContain("server/discover")
    expect(rpcs(server)).not.toContain("initialize")

    expect((await connection.listTools()).map((tool) => tool.name)).toEqual([
      "ask",
      "fetch",
      "search_paths",
    ])
    const result = await connection.callTool(
      "search_paths",
      { query: "q" },
      { signal: new AbortController().signal },
    )
    expect(result.content).toEqual([
      { type: "text", text: 'search_paths:{"query":"q"}' },
    ])
  })

  test("falls back to the 2025 initialize handshake for a server that predates discovery", async () => {
    const server = fake()
    const connection = await connect(server)
    expect(connection.protocol).toEqual({
      version: "2025-11-25",
      era: "legacy",
    })
    expect(rpcs(server).slice(0, 2)).toEqual(["server/discover", "initialize"])
  })

  test("legacy mode skips the probe", async () => {
    const server = fake({ protocol: "modern" })
    const connection = await connect(server, "legacy")
    expect(connection.protocol?.era).toBe("legacy")
    expect(rpcs(server)).not.toContain("server/discover")
  })

  test("the connector logs the negotiated version and shows it in its status", async () => {
    const server = fake({ protocol: "modern" })
    const module = defineRemoteMcpConnector(EXAMPLE_MANIFEST, {
      endpoint: server.url,
      auth: fakeAuth({ signedIn: true }),
    })
    const plugin = await loadPlugin(
      module,
      {},
      {
        storage: {
          example: {
            "terms.json": JSON.stringify({ accepted: true, terms: TERMS_URL }),
          },
        },
      },
    )
    cleanups.push(() => plugin.dispose())
    await waitFor(() => plugin.status()?.code === "ready")
    expect(plugin.status()?.facts).toContainEqual({
      label: "Protocol",
      value: "MCP 2026-07-28",
    })
    expect(
      plugin.testbed.host.logs.some(
        (log) =>
          log.level === "info"
          && log.message.includes("connected with MCP 2026-07-28"),
      ),
    ).toBe(true)
    expect((await plugin.callTool("ask", { question: "hi" })).content).toEqual([
      { type: "text", text: 'ask:{"question":"hi"}' },
    ])
  })
})
