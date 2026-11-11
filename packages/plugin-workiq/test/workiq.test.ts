import { toolGroup } from "@stuffbucket/maximal-plugin-sdk"
import { loadPlugin, waitFor } from "@stuffbucket/maximal-plugin-sdk/testing"
import { afterEach, describe, expect, test } from "bun:test"

import * as workiq from "../src/index"
import {
  BENCH_ACCOUNT,
  fakeAuth,
  startFakeWorkIq,
  SYNTHETIC_TOOL_NAMES,
  WORKIQ_RESULTS,
  WORKIQ_TOOLS,
  type FakeRemoteMcp,
} from "../src/testing"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const APP_ID = "ba081686-5d24-4bc6-a0d6-d034ecffed87"
const ACCEPTED = {
  workiq: {
    "terms.json": JSON.stringify({
      accepted: true,
      terms: "https://github.com/microsoft/work-iq",
    }),
  },
}

function fake(): FakeRemoteMcp {
  const server = startFakeWorkIq()
  cleanups.push(() => server.close())
  return server
}

/** Input names of a fixture tool, in schema order. */
const inputs = (name: string) =>
  Object.keys(
    WORKIQ_TOOLS.find((tool) => tool.name === name)?.inputSchema.properties
      ?? {},
  )

function groups(tools: ReadonlyArray<Parameters<typeof toolGroup>[0]>) {
  const counts = { "read-only": 0, "write-delete": 0, other: 0 }
  for (const tool of tools) counts[toolGroup(tool)]++
  return counts
}

describe("Work IQ manifest", () => {
  test("is a connector with the Work IQ sign-in, endpoint and terms", () => {
    expect(workiq.name).toBe("workiq")
    expect(workiq.manifest).toMatchObject({
      id: "workiq",
      kind: "connector",
      displayName: "Work IQ",
      settingsVersion: 1,
      connector: {
        transport: "streamable-http",
        endpoint: "https://workiq.svc.cloud.microsoft/mcp",
        auth: {
          type: "entra",
          clientId: APP_ID,
          authority: "https://login.microsoftonline.com/organizations",
          scopes: ["fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask"],
          redirectUri: "http://localhost:12798",
        },
        terms: { url: "https://github.com/microsoft/work-iq" },
      },
    })
    expect(workiq.manifest.configSchema).toMatchObject({
      type: "object",
      properties: {
        endpoint: { format: "uri", "x-maximal-advanced": true },
        authority: { format: "uri", "x-maximal-advanced": true },
      },
    })
    expect(workiq.Config.parse({})).toEqual({
      endpoint: "https://workiq.svc.cloud.microsoft/mcp",
      authority: "https://login.microsoftonline.com/organizations",
    })
    expect(() => workiq.Config.parse({ endpoint: "ftp://x" })).toThrow()
    // Settings cannot send the WorkIQAgent.Ask token anywhere else.
    expect(() =>
      workiq.Config.parse({ endpoint: "https://attacker.example/mcp" }),
    ).toThrow()
    expect(() =>
      workiq.Config.parse({
        endpoint: "http://workiq.svc.cloud.microsoft/mcp",
      }),
    ).toThrow()
    expect(() =>
      workiq.Config.parse({ authority: "https://attacker.example/common" }),
    ).toThrow()
  })

  test("the real module loads offline and asks for the Microsoft terms first", async () => {
    const plugin = await loadPlugin(workiq, {})
    cleanups.push(() => plugin.dispose())
    await waitFor(() => plugin.status()?.code === "terms-needed")
    expect(plugin.status()).toMatchObject({
      summary: "Accept the Microsoft Work IQ terms to continue",
      detail: expect.stringContaining(
        "https://github.com/microsoft/work-iq",
      ) as string,
    })
    await plugin.runAction("accept-terms")
    expect(plugin.status()).toMatchObject({
      code: "signin-needed",
      summary: "Sign in with your work or school account",
    })
  })
})

describe("Work IQ bench fixture", () => {
  test("has 14 tools grouped Read-only 6 / Write-delete 5 / Other 3", () => {
    expect(WORKIQ_TOOLS.map((tool) => tool.name)).toEqual([
      "retrieve",
      "fetch_blob",
      "get_schema",
      "call_function",
      "fetch",
      "search_paths",
      "accept_eula",
      "delete_entity",
      "upload_blob",
      "create_entity",
      "update_entity",
      "ask",
      "list_agents",
      "get_debug_link",
    ])
    expect(groups(WORKIQ_TOOLS)).toEqual({
      "read-only": 6,
      "write-delete": 5,
      other: 3,
    })
    expect([...SYNTHETIC_TOOL_NAMES].sort()).toEqual([
      "search_paths",
      "upload_blob",
    ])
    for (const tool of WORKIQ_TOOLS) {
      expect(tool.inputSchema.type).toBe("object")
      expect(tool.description?.length).toBeGreaterThan(20)
      expect(Object.hasOwn(WORKIQ_RESULTS, tool.name)).toBe(true)
    }
  })

  test("transcribes the captured input lists", () => {
    expect(inputs("call_function")).toEqual([
      "functionUrl",
      "agentId",
      "jsonBody",
    ])
    expect(inputs("ask")).toEqual([
      "question",
      "fileUrls",
      "conversationId",
      "agentId",
    ])
    expect(inputs("fetch")).toEqual(["entityUrls", "agentId"])
    expect(inputs("accept_eula")).toEqual(["eulaUrl"])
    expect(inputs("list_agents")).toEqual([])
    expect(inputs("retrieve")).toHaveLength(5)
  })

  test("serves the fixture end to end through the Work IQ connector", async () => {
    const server = fake()
    const plugin = await loadPlugin(
      workiq.createWorkIqPlugin({
        endpoint: server.url,
        auth: fakeAuth({ account: BENCH_ACCOUNT }),
      }),
      {},
      { storage: ACCEPTED },
    )
    cleanups.push(() => plugin.dispose())
    await waitFor(() => plugin.status()?.code === "signin-needed")
    await plugin.runAction("sign-in")
    expect(plugin.status()).toMatchObject({
      code: "ready",
      summary: "Connected as bench@contoso.com",
    })
    expect(plugin.tools()).toHaveLength(14)
    expect(groups(plugin.tools())).toEqual({
      "read-only": 6,
      "write-delete": 5,
      other: 3,
    })
    const answer = await plugin.callTool("ask", { question: "What's new?" })
    expect(answer.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        "canned answer from the fake Work IQ",
      ) as string,
    })
    const fetched = await plugin.callTool("fetch", { entityUrls: ["/me"] })
    expect(fetched.structuredContent).toMatchObject({
      results: [{ statusCode: 200, data: { path: "/me" } }],
    })
  })
})

describe("Work IQ wording", () => {
  test("names the Work IQ app in consent errors and keeps policy denials per call", async () => {
    const server = fake()
    server.fail({
      status: 403,
      rpc: "initialize",
      body: "AADSTS65001 consent required",
    })
    const plugin = await loadPlugin(
      workiq.createWorkIqPlugin({
        endpoint: server.url,
        auth: fakeAuth({ signedIn: true }),
        retryDelaysMs: [1],
      }),
      {},
      { storage: ACCEPTED },
    )
    cleanups.push(() => plugin.dispose())
    await waitFor(() => plugin.status()?.state === "error")
    expect(plugin.status()?.summary).toBe(
      `Your organization has not approved Work IQ. A Microsoft Entra admin must grant tenant-wide admin consent to the Work IQ app (${APP_ID}).`,
    )
    expect(plugin.status()?.detail).toContain(
      `A Microsoft Entra admin can check the Work IQ app (${APP_ID})`,
    )

    await plugin.runAction("retry")
    expect(plugin.status()?.code).toBe("ready")
    server.fail({ status: 403, rpc: "tools/call", body: "Forbidden" })
    expect(await plugin.callTool("fetch", { entityUrls: ["/me"] })).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Your organization's Work IQ policy doesn't allow this request.",
        },
      ],
    })
    expect(plugin.status()?.code).toBe("ready")

    server.fail({ status: 403, rpc: "tools/list", body: "Forbidden" })
    await plugin.runAction("retry")
    expect(plugin.status()?.summary).toBe(
      "Your organization hasn't enabled Work IQ for this account. You stay signed in; choose Try again once your Microsoft 365 admin has enabled it.",
    )
  })
})
