import { loadPlugin, waitFor } from "@stuffbucket/maximal-plugin-sdk/testing"
import { afterEach, describe, expect, test } from "bun:test"

import * as workiq from "../src/index"
import { createWorkIqPlugin, type WorkIqPluginOptions } from "../src/plugin"
import { TERMS_FILE } from "../src/state"
import { ADA, FakeTokenProvider } from "./fake-tokens"
import { RECORDED_TOOLS, startFakeWorkIq, type FakeWorkIq } from "./fake-workiq"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ACCEPTED = { workiq: { [TERMS_FILE]: '{"accepted":true}' } }

function fake(): FakeWorkIq {
  const server = startFakeWorkIq()
  cleanups.push(() => server.close())
  return server
}

async function load(
  server: FakeWorkIq,
  tokens: FakeTokenProvider,
  options: {
    storage?: Record<string, Record<string, string>>
    plugin?: WorkIqPluginOptions
  } = {},
) {
  const module = createWorkIqPlugin({
    createTokenProvider: () => tokens,
    retryDelaysMs: [1],
    sleep: async () => {},
    signInTimeoutMs: 60_000,
    ...options.plugin,
  })
  const plugin = await loadPlugin(
    module,
    { endpoint: server.url },
    options.storage ? { storage: options.storage } : {},
  )
  cleanups.push(() => plugin.dispose())
  return plugin
}

describe("workiq plugin lifecycle", () => {
  test("exports a valid plugin module whose `{}` config is valid", async () => {
    expect(workiq.name).toBe("workiq")
    expect(workiq.meta.displayName).toBe("Work IQ")
    expect(workiq.Config.parse({})).toEqual({
      endpoint: "https://workiq.svc.cloud.microsoft/mcp",
      authority: "https://login.microsoftonline.com/organizations",
    })
    expect(() => workiq.Config.parse({ endpoint: "ftp://x" })).toThrow()

    // The real module (MSAL provider) loads without network: no terms yet.
    const plugin = await loadPlugin(workiq, {})
    cleanups.push(() => plugin.dispose())
    await waitFor(() => plugin.status()?.code === "terms-needed")
    expect(plugin.actions().sort()).toEqual([
      "accept-terms",
      "retry",
      "sign-in",
      "sign-out",
    ])
    await plugin.runAction("accept-terms")
    expect(plugin.status()?.code).toBe("signin-needed")
    expect(
      JSON.parse(plugin.testbed.storage.files("workiq")[TERMS_FILE]),
    ).toMatchObject({ accepted: true })
  })

  test("terms → sign-in → ready → sign-out", async () => {
    const server = fake()
    const tokens = new FakeTokenProvider()
    const plugin = await load(server, tokens)

    await waitFor(() => plugin.status()?.code === "terms-needed")
    expect(plugin.status()).toMatchObject({
      state: "needs-setup",
      actions: [{ id: "accept-terms" }],
    })
    expect(plugin.tools()).toEqual([])

    // Signing in before accepting the terms is refused.
    await plugin.runAction("sign-in")
    expect(tokens.signInCalls).toBe(0)
    expect(plugin.status()?.code).toBe("terms-needed")

    await plugin.runAction("accept-terms")
    expect(plugin.status()).toMatchObject({
      state: "needs-setup",
      code: "signin-needed",
      actions: [{ id: "sign-in" }],
    })
    expect(plugin.tools()).toEqual([])

    await plugin.runAction("sign-in")
    expect(tokens.signInCalls).toBe(1)
    expect(plugin.status()).toEqual({
      state: "ready",
      code: "ready",
      summary: "Connected as ada@contoso.com",
      facts: [
        { label: "Account", value: "ada@contoso.com" },
        { label: "Tenant", value: String(ADA.tenantId) },
        { label: "Tools", value: "3" },
      ],
      actions: [
        {
          id: "sign-out",
          label: "Sign out",
          kind: "destructive",
          confirm: expect.any(String) as string,
        },
      ],
    })
    expect(plugin.tools().map((tool) => tool.name)).toEqual([
      "ask",
      "fetch",
      "search_paths",
    ])
    expect(plugin.tool("ask")?.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
    })

    const result = await plugin.callTool("search_paths", { query: "mail" })
    expect(result).toEqual({
      content: [{ type: "text", text: 'search_paths:{"query":"mail"}' }],
    })
    expect(
      server.requests.every(
        (request) => request.authorization === "Bearer token-1",
      ),
    ).toBe(true)

    await plugin.runAction("sign-out")
    expect(tokens.signOutCalls).toBe(1)
    expect(plugin.tools()).toEqual([])
    expect(plugin.status()?.code).toBe("signin-needed")
  })

  test("goes straight to ready when terms were accepted and a sign-in is cached", async () => {
    const server = fake()
    const plugin = await load(server, new FakeTokenProvider(ADA), {
      storage: ACCEPTED,
    })
    expect(plugin.status()?.code).toBe("working")
    await waitFor(() => plugin.status()?.code === "ready")
    expect(plugin.tools()).toHaveLength(3)
  })

  test("an expired sign-in at startup asks to sign in again", async () => {
    const server = fake()
    const tokens = new FakeTokenProvider(ADA)
    tokens.tokenError = new workiq.WorkIqError(
      "signed-out",
      "Your Work IQ sign-in has expired. Sign in again.",
    )
    const plugin = await load(server, tokens, { storage: ACCEPTED })
    await waitFor(() => plugin.status()?.code === "signin-needed")
    expect(plugin.status()?.detail).toBe(
      "Your Work IQ sign-in has expired. Sign in again.",
    )
    expect(plugin.tools()).toEqual([])
  })
})

describe("workiq plugin errors and recovery", () => {
  test("upstream consent/licence failures show an error with retry, and retry recovers", async () => {
    const server = fake()
    server.fail({
      status: 403,
      rpc: "initialize",
      body: "AADSTS65001 consent required",
    })
    const plugin = await load(server, new FakeTokenProvider(ADA), {
      storage: ACCEPTED,
    })
    await waitFor(() => plugin.status()?.state === "error")
    expect(plugin.status()).toMatchObject({
      code: "error",
      summary: expect.stringContaining(
        "admin consent to the Work IQ app (ba081686-5d24-4bc6-a0d6-d034ecffed87)",
      ) as string,
      actions: [{ id: "retry" }, { id: "sign-in" }, { id: "sign-out" }],
    })
    expect(plugin.tools()).toEqual([])

    await plugin.runAction("retry")
    expect(plugin.status()?.code).toBe("ready")
    expect(plugin.tools()).toHaveLength(3)
  })

  test("a 401 during a call returns an error result and asks to sign in again", async () => {
    const server = fake()
    const plugin = await load(server, new FakeTokenProvider(ADA), {
      storage: ACCEPTED,
    })
    await waitFor(() => plugin.status()?.code === "ready")
    server.token = "revoked"
    const result = await plugin.callTool("search_paths", {})
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Work IQ did not accept your sign-in (HTTP 401). Sign in again.",
        },
      ],
    })
    expect(plugin.status()?.code).toBe("signin-needed")
    expect(plugin.tools()).toEqual([])
  })

  test("transient call failures do not change the state", async () => {
    const server = fake()
    const plugin = await load(server, new FakeTokenProvider(ADA), {
      storage: ACCEPTED,
    })
    await waitFor(() => plugin.status()?.code === "ready")
    server.fail({ status: 503, rpc: "tools/call" }, 2)
    const result = await plugin.callTool("search_paths", {})
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Work IQ is busy (HTTP 503). Try again in a moment.",
        },
      ],
    })
    expect(plugin.status()?.code).toBe("ready")
    expect(plugin.tools()).toHaveLength(3)
  })

  test("refreshes tools when upstream announces list_changed", async () => {
    const server = fake()
    const plugin = await load(server, new FakeTokenProvider(ADA), {
      storage: ACCEPTED,
    })
    await waitFor(() => plugin.status()?.code === "ready")
    await Bun.sleep(50)
    await server.setTools([RECORDED_TOOLS[0]])
    await waitFor(() => plugin.tools().length === 1, { timeoutMs: 3000 })
    expect(plugin.tools().map((tool) => tool.name)).toEqual(["ask"])
    expect(
      plugin.status()?.facts?.find((fact) => fact.label === "Tools")?.value,
    ).toBe("1")
  })

  test("sign-in shows progress and can be cancelled with sign-out", async () => {
    const server = fake()
    const tokens = new FakeTokenProvider()
    tokens.manualSignIn = true
    const plugin = await load(server, tokens, { storage: ACCEPTED })
    await waitFor(() => plugin.status()?.code === "signin-needed")

    const signingIn = plugin.runAction("sign-in")
    await waitFor(() => tokens.signInPending)
    expect(plugin.status()).toMatchObject({
      state: "working",
      code: "working",
      summary: "Waiting for sign-in in your browser",
      actions: [{ id: "sign-out", label: "Cancel" }],
    })
    await plugin.runAction("sign-out")
    await signingIn
    expect(plugin.status()?.code).toBe("signin-needed")
    expect(plugin.tools()).toEqual([])
  })

  test("a failed sign-in reports the reason", async () => {
    const server = fake()
    const tokens = new FakeTokenProvider()
    tokens.manualSignIn = true
    const plugin = await load(server, tokens, { storage: ACCEPTED })
    await waitFor(() => plugin.status()?.code === "signin-needed")
    const signingIn = plugin.runAction("sign-in")
    await waitFor(() => tokens.signInPending)
    tokens.failSignIn(
      Object.assign(
        new Error(
          "AADSTS50020: User account from identity provider 'live.com' does not exist in tenant.",
        ),
        { errorCode: "invalid_request" },
      ),
    )
    await signingIn
    expect(plugin.status()).toMatchObject({
      state: "error",
      summary:
        "Work IQ needs a work or school account; personal Microsoft accounts are not supported.",
    })

    const retry = plugin.runAction("sign-in")
    await waitFor(() => tokens.signInPending)
    tokens.completeSignIn()
    await retry
    expect(plugin.status()?.code).toBe("ready")
  })
})

describe("workiq plugin tool relays", () => {
  test("relays progress and elicitation through the plugin tool", async () => {
    const server = fake()
    server.handlers = {
      ask: async (_args, ctx, { progressToken }) => {
        if (progressToken !== undefined) {
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progressToken, progress: 1, message: "Thinking" },
          })
        }
        // The fake issues a 2025-era push elicitation, which is what the plugin relays.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        const answer = await ctx.mcpReq.elicitInput({
          mode: "form",
          message: "Continue?",
          requestedSchema: { type: "object", properties: {} },
        })
        return { content: [{ type: "text", text: answer.action }] }
      },
    }
    const plugin = await load(server, new FakeTokenProvider(ADA), {
      storage: ACCEPTED,
    })
    await waitFor(() => plugin.status()?.code === "ready")
    const progress: Array<string> = []
    const result = await plugin.callTool(
      "ask",
      { question: "q" },
      {
        sessionId: "downstream-1",
        progress: (update) => progress.push(update.message ?? ""),
        elicit: () => Promise.resolve({ action: "accept", content: {} }),
      },
    )
    expect(result.content).toEqual([{ type: "text", text: "accept" }])
    expect(progress).toEqual(["Thinking"])
  })

  test("unloading removes tools and status and closes upstream sessions", async () => {
    const server = fake()
    const plugin = await load(server, new FakeTokenProvider(ADA), {
      storage: ACCEPTED,
    })
    await waitFor(() => plugin.status()?.code === "ready")
    await plugin.callTool("search_paths", {}, { sessionId: "s" })
    expect(server.sessionCount).toBe(2)
    await plugin.dispose()
    expect(plugin.tools()).toEqual([])
    expect(plugin.status()).toBeUndefined()
    await waitFor(() => server.sessionCount === 0)
  })
})
