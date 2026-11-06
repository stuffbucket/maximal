import { loadPlugin, waitFor } from "@stuffbucket/maximal-plugin-sdk/testing"
import { afterEach, describe, expect, test } from "bun:test"

import type { AuthStrategy } from "../src/auth/token-provider"

import { LEGACY_TOKEN_CACHE_FILE, TOKEN_CACHE_FILE } from "../src/auth/entra"
import { resetSealedCacheScopes } from "../src/auth/sealed-cache"
import {
  defineRemoteMcpConnector,
  type RemoteMcpConnectorOptions,
} from "../src/define"
import { ConnectorError } from "../src/errors"
import { CONNECTED_NOTICE, TERMS_FILE } from "../src/state"
import { ADA, fakeAuth, FakeTokenProvider } from "../src/testing/fake-auth"
import {
  SAMPLE_TOOLS,
  startFakeRemoteMcp,
  type FakeRemoteMcp,
} from "../src/testing/fake-server"
import { memorySecretStore } from "../src/testing/secret-store"
import { EXAMPLE_MANIFEST, TERMS_URL } from "./fixtures"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  // Sign-ins kept in memory live per process; the test bed's directories repeat.
  resetSealedCacheScopes()
})

const ACCEPTED = {
  example: {
    [TERMS_FILE]: JSON.stringify({ accepted: true, terms: TERMS_URL }),
  },
}

function fake(
  options?: Parameters<typeof startFakeRemoteMcp>[0],
): FakeRemoteMcp {
  const server = startFakeRemoteMcp(options)
  cleanups.push(() => server.close())
  return server
}

/** A strategy that always hands out `tokens` (one plugin instance per test). */
function using(tokens: FakeTokenProvider): AuthStrategy {
  return {
    type: "fake",
    interactive: true,
    signInPrompt: "Sign in with your work or school account",
    create: () => tokens,
  }
}

async function load(
  server: FakeRemoteMcp,
  tokens: FakeTokenProvider | AuthStrategy,
  options: {
    storage?: Record<string, Record<string, string>>
    connector?: RemoteMcpConnectorOptions
  } = {},
) {
  const module = defineRemoteMcpConnector(EXAMPLE_MANIFEST, {
    endpoint: server.url,
    auth: tokens instanceof FakeTokenProvider ? using(tokens) : tokens,
    retryDelaysMs: [1],
    sleep: async () => {},
    signInTimeoutMs: 60_000,
    ...options.connector,
  })
  const plugin = await loadPlugin(
    module,
    {},
    options.storage ? { storage: options.storage } : {},
  )
  cleanups.push(() => plugin.dispose())
  return plugin
}

describe("connector module", () => {
  test("is a complete plugin module whose `{}` config is valid", async () => {
    const module = defineRemoteMcpConnector(EXAMPLE_MANIFEST)
    expect(module.name).toBe("example")
    expect(module.manifest.connector.auth.type).toBe("entra")
    expect(module.Config.parse({})).toEqual({
      endpoint: EXAMPLE_MANIFEST.connector.endpoint,
      authority: "https://login.microsoftonline.com/organizations",
    })
    expect(() => module.Config.parse({ endpoint: "ftp://x" })).toThrow()
    expect(module.manifest.configSchema).toMatchObject({
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          format: "uri",
          default: EXAMPLE_MANIFEST.connector.endpoint,
          "x-maximal-advanced": true,
        },
        authority: { "x-maximal-advanced": true },
      },
    })
    expect(module.manifest.configSchema?.required).toBeUndefined()

    // The real module (MSAL strategy) loads without network: terms first.
    const plugin = await loadPlugin(module, {})
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
      JSON.parse(plugin.testbed.storage.files("example")[TERMS_FILE]),
    ).toMatchObject({ accepted: true, terms: TERMS_URL })
    expect(
      Object.hasOwn(plugin.testbed.storage.files("example"), TOKEN_CACHE_FILE),
    ).toBe(false)
  })

  test("`endpoint` and `auth` options override the manifest; hooks pass through", () => {
    const strategy = fakeAuth()
    const module = defineRemoteMcpConnector(EXAMPLE_MANIFEST, {
      endpoint: "http://127.0.0.1:9/mcp",
      auth: strategy,
      defaultToolPermission: (tool) =>
        tool.annotations?.destructiveHint ? "block" : undefined,
      migrateSettings: (_from, config) => config,
    })
    expect(module.manifest.connector.endpoint).toBe("http://127.0.0.1:9/mcp")
    expect(module.Config.parse({}).endpoint).toBe("http://127.0.0.1:9/mcp")
    expect(
      module.defaultToolPermission?.({
        name: "rm",
        description: "",
        inputSchema: { type: "object" },
        annotations: { destructiveHint: true },
      }),
    ).toBe("block")
    expect(typeof module.migrateSettings).toBe("function")
    expect(
      "defaultToolPermission" in defineRemoteMcpConnector(EXAMPLE_MANIFEST),
    ).toBe(false)
  })
})

/** Standard Schema issues of `config` (what Settings shows inline). */
function issues(
  module: ReturnType<typeof defineRemoteMcpConnector>,
  config: unknown,
) {
  const result = module.Config["~standard"].validate(config)
  if (result instanceof Promise) throw new Error("async validation")
  return (result.issues ?? []).map((issue) => ({
    path: issue.path?.map((key) => (typeof key === "object" ? key.key : key)),
    message: issue.message,
  }))
}

describe("config overrides cannot redirect the upstream token", () => {
  test("an endpoint override must be https on the manifest's host or allowedHosts", () => {
    const module = defineRemoteMcpConnector(EXAMPLE_MANIFEST)
    expect(
      issues(module, { endpoint: "https://mcp.example.com/v2/mcp" }),
    ).toEqual([])
    expect(
      issues(module, { endpoint: "https://evil.example.net/mcp" }),
    ).toEqual([
      {
        path: ["endpoint"],
        message: "Endpoint must be an https:// URL on mcp.example.com.",
      },
    ])
    expect(issues(module, { endpoint: "http://mcp.example.com/mcp" })).toEqual([
      {
        path: ["endpoint"],
        message: "Endpoint must be an https:// URL on mcp.example.com.",
      },
    ])
    const regional = defineRemoteMcpConnector({
      ...EXAMPLE_MANIFEST,
      connector: {
        ...EXAMPLE_MANIFEST.connector,
        allowedHosts: ["eu.example.com"],
      },
    })
    expect(
      issues(regional, { endpoint: "https://eu.example.com/mcp" }),
    ).toEqual([])
    expect(
      issues(regional, { endpoint: "https://us.example.com/mcp" }),
    ).toEqual([
      {
        path: ["endpoint"],
        message:
          "Endpoint must be an https:// URL on mcp.example.com or eu.example.com.",
      },
    ])
  })

  test("an authority override must be https on the manifest's or Microsoft's sign-in host", () => {
    const module = defineRemoteMcpConnector(EXAMPLE_MANIFEST)
    expect(
      issues(module, { authority: "https://login.microsoft.com/contoso.com" }),
    ).toEqual([])
    expect(
      issues(module, { authority: "https://login.microsoftonline.com/common" }),
    ).toEqual([])
    for (const authority of [
      "https://login.evil.example.net/organizations",
      "http://login.microsoftonline.com/organizations",
    ])
      expect(issues(module, { authority })).toEqual([
        {
          path: ["authority"],
          message:
            "Sign-in authority must be an https:// URL on login.microsoftonline.com or login.microsoft.com.",
        },
      ])
  })

  test("a code-level endpoint (a loopback fake) is the default and stays valid; others on loopback are not", () => {
    const module = defineRemoteMcpConnector(EXAMPLE_MANIFEST, {
      endpoint: "http://127.0.0.1:9/mcp",
    })
    expect(issues(module, {})).toEqual([])
    expect(issues(module, { endpoint: "http://127.0.0.1:9/mcp" })).toEqual([])
    expect(
      issues(module, { endpoint: "http://127.0.0.1:10/mcp" }),
    ).toHaveLength(1)
  })
})

describe("terms gate", () => {
  test("terms → sign-in → ready → sign-out", async () => {
    const server = fake()
    const tokens = new FakeTokenProvider()
    const plugin = await load(server, tokens)

    await waitFor(() => plugin.status()?.code === "terms-needed")
    expect(plugin.status()).toMatchObject({
      state: "needs-setup",
      summary: "Accept the Example terms to continue",
      detail: `Review the Example terms at ${TERMS_URL} before you continue.`,
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
      summary: "Sign in with your work or school account",
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
        { label: "Protocol", value: "MCP 2025-11-25" },
      ],
      actions: [
        {
          id: "sign-out",
          label: "Sign out",
          kind: "destructive",
          confirm:
            "Sign out of Example? Its tools stay unavailable until you sign in again.",
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

  test("acceptance of different terms does not count; the wording is overridable", async () => {
    const server = fake()
    const plugin = await load(server, new FakeTokenProvider(ADA), {
      storage: {
        example: {
          [TERMS_FILE]: JSON.stringify({
            accepted: true,
            terms: "https://example.com/old-terms",
          }),
        },
      },
      connector: {
        wording: {
          termsSummary: "Accept the Example service terms",
          termsDetail: "Example answers questions from your data.",
        },
      },
    })
    await waitFor(() => plugin.status()?.code === "terms-needed")
    expect(plugin.status()).toMatchObject({
      summary: "Accept the Example service terms",
      detail: "Example answers questions from your data.",
    })
    await plugin.runAction("accept-terms")
    // A cached sign-in goes straight on to connect.
    await waitFor(() => plugin.status()?.code === "ready")
    const recorded = JSON.parse(
      plugin.testbed.storage.files("example")[TERMS_FILE],
    ) as { terms: string; acceptedAt: string }
    expect(recorded.terms).toBe(TERMS_URL)
    expect(Number.isNaN(Date.parse(recorded.acceptedAt))).toBe(false)
  })

  test("without terms in the manifest there is no terms step or action", async () => {
    const server = fake()
    const { terms: _terms, ...connector } = EXAMPLE_MANIFEST.connector
    const module = defineRemoteMcpConnector(
      { ...EXAMPLE_MANIFEST, connector },
      { endpoint: server.url, auth: using(new FakeTokenProvider()) },
    )
    const plugin = await loadPlugin(module, {})
    cleanups.push(() => plugin.dispose())
    await waitFor(() => plugin.status()?.code === "signin-needed")
    expect(plugin.actions().sort()).toEqual(["retry", "sign-in", "sign-out"])
  })

  test("auth `none` connects straight away with no sign-in actions", async () => {
    const server = fake({ token: null })
    const module = defineRemoteMcpConnector({
      ...EXAMPLE_MANIFEST,
      connector: {
        transport: "streamable-http",
        endpoint: server.url,
        auth: { type: "none" },
      },
    })
    expect(module.Config.parse({})).toEqual({ endpoint: server.url })
    const plugin = await loadPlugin(module, {})
    cleanups.push(() => plugin.dispose())
    await waitFor(() => plugin.status()?.code === "ready")
    expect(plugin.actions()).toEqual(["retry"])
    expect(plugin.status()).toMatchObject({
      summary: "Connected",
      facts: [
        { label: "Tools", value: "3" },
        { label: "Protocol", value: "MCP 2025-11-25" },
      ],
    })
    expect(plugin.status()?.actions).toBeUndefined()
    expect(server.requests.every((r) => r.authorization === null)).toBe(true)
  })
})

describe("connector lifecycle", () => {
  test("goes straight to ready when terms were accepted and a sign-in is cached", async () => {
    const server = fake()
    const plugin = await load(server, new FakeTokenProvider(ADA), {
      storage: ACCEPTED,
    })
    expect(plugin.status()?.code).toBe("working")
    await waitFor(() => plugin.status()?.code === "ready")
    expect(plugin.tools()).toHaveLength(3)
  })

  test("a sign-in kept in memory only says so, and why, when connected", async () => {
    const server = fake()
    const tokens = new FakeTokenProvider(ADA)
    tokens.notice = {
      fact: "Kept until Maximal restarts",
      detail: "No keyring.",
    }
    const plugin = await load(server, tokens, { storage: ACCEPTED })
    await waitFor(() => plugin.status()?.code === "ready")
    expect(plugin.status()?.detail).toBe("No keyring.")
    expect(plugin.status()?.facts).toContainEqual({
      label: "Sign-in",
      value: "Kept until Maximal restarts",
    })
  })

  test("the Entra strategy moves a plaintext cache into the connector's credential entries at start", async () => {
    const secrets = memorySecretStore()
    const empty = JSON.stringify({
      Account: {},
      IdToken: {},
      AccessToken: {},
      RefreshToken: {},
      AppMetadata: {},
    })
    const plugin = await loadPlugin(
      defineRemoteMcpConnector(EXAMPLE_MANIFEST, { secretStore: secrets }),
      {},
      { storage: { example: { [LEGACY_TOKEN_CACHE_FILE]: empty } } },
    )
    cleanups.push(() => plugin.dispose())
    await waitFor(
      () =>
        !Object.hasOwn(
          plugin.testbed.storage.files("example"),
          LEGACY_TOKEN_CACHE_FILE,
        ),
    )
    expect(plugin.testbed.storage.files("example")[TOKEN_CACHE_FILE]).toContain(
      "maximal-sealed/1",
    )
    const names = [...secrets.entries.keys()]
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^example\/msal-token-cache\/[0-9a-f]{32}$/)
  })

  test("signing in raises a 'connected' notice; a cached sign-in at start doesn't", async () => {
    const notices = (plugin: Awaited<ReturnType<typeof load>>) =>
      plugin.testbed.events.flatMap((event) =>
        event.notice ? [event.notice] : [],
      )
    const server = fake()
    const cached = await load(server, new FakeTokenProvider(ADA), {
      storage: ACCEPTED,
    })
    await waitFor(() => cached.status()?.code === "ready")
    expect(notices(cached)).toEqual([])

    const strategy = fakeAuth({ account: { username: "ada@contoso.com" } })
    const plugin = await load(server, strategy, { storage: ACCEPTED })
    await waitFor(() => plugin.status()?.code === "signin-needed")
    await plugin.runAction("sign-in")
    expect(plugin.status()?.code).toBe("ready")
    expect(notices(plugin)).toEqual([
      {
        code: CONNECTED_NOTICE,
        message: "Example is connected as ada@contoso.com.",
        params: { connector: "Example", account: "ada@contoso.com" },
      },
    ])
  })

  test("a credential store that never answers holds up nothing: the connector loads and answers", async () => {
    const secrets = memorySecretStore({ stalled: true })
    // A saved sign-in, so the check has to ask the store for its key.
    const saved = JSON.stringify({
      format: "maximal-sealed/1",
      alg: "A256GCM",
      key: "msal-token-cache/0123456789abcdef0123456789abcdef",
      iv: "AAAAAAAAAAAAAAAA",
      data: "AAAA",
    })
    const plugin = await loadPlugin(
      defineRemoteMcpConnector(EXAMPLE_MANIFEST, { secretStore: secrets }),
      {},
      {
        storage: {
          example: { ...ACCEPTED.example, [TOKEN_CACHE_FILE]: saved },
        },
      },
    )
    cleanups.push(() => plugin.dispose())
    // The sign-in check waits on the store in the background (and gives up
    // after its timeout); loading, status, actions and tools don't.
    expect(plugin.status()?.code).toBe("working")
    expect(plugin.actions()).toContain("sign-out")
    expect(plugin.tools()).toEqual([])
    await waitFor(() => secrets.calls.length > 0)
    expect(plugin.status()?.code).toBe("working")
  })

  test("the fake strategy signs in instantly as its account", async () => {
    const server = fake()
    const strategy = fakeAuth({
      account: { username: "bench@contoso.com" },
    })
    const plugin = await load(server, strategy, { storage: ACCEPTED })
    await waitFor(() => plugin.status()?.code === "signin-needed")
    expect(plugin.status()?.summary).toBe("Sign in as bench@contoso.com")
    await plugin.runAction("sign-in")
    expect(plugin.status()?.summary).toBe("Connected as bench@contoso.com")
    expect(strategy.providers).toHaveLength(1)
  })

  test("an expired sign-in at startup asks to sign in again", async () => {
    const server = fake()
    const tokens = new FakeTokenProvider(ADA)
    tokens.tokenError = new ConnectorError(
      "signed-out",
      "Your Example sign-in has expired. Sign in again.",
    )
    const plugin = await load(server, tokens, { storage: ACCEPTED })
    await waitFor(() => plugin.status()?.code === "signin-needed")
    expect(plugin.status()?.detail).toBe(
      "Your Example sign-in has expired. Sign in again.",
    )
    expect(plugin.tools()).toEqual([])
  })
})

describe("connector errors and recovery", () => {
  test("upstream consent failures show an error with retry, in the connector's wording", async () => {
    const server = fake()
    server.fail({
      status: 403,
      rpc: "initialize",
      body: "AADSTS65001 consent required",
    })
    const plugin = await load(server, new FakeTokenProvider(ADA), {
      storage: ACCEPTED,
      connector: {
        errors: {
          messages: { "consent-needed": "Ask IT to approve Example." },
          adminHint: "An admin can approve the Example app (id 1234).",
        },
      },
    })
    await waitFor(() => plugin.status()?.state === "error")
    expect(plugin.status()).toMatchObject({
      code: "error",
      summary: "Ask IT to approve Example.",
      detail:
        "An admin can approve the Example app (id 1234). Reason: consent-needed (HTTP 403).",
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
          text: "Example did not accept your sign-in (HTTP 401). Sign in again.",
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
    // `ask` is read-only: retried (2 attempts with `retryDelaysMs: [1]`), then busy.
    server.fail({ status: 503, rpc: "tools/call" }, 2)
    const result = await plugin.callTool("ask", { question: "q" })
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Example is rate-limiting requests (HTTP 503); tried 2 times over 1 s. Try again in about 1 s.",
        },
      ],
    })
    // `search_paths` has no annotations, so it may write: a 503 is not retried.
    server.fail({ status: 503, rpc: "tools/call" })
    const write = await plugin.callTool("search_paths", {})
    expect(write).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "The request may have been carried out: Example returned HTTP 503 for search_paths, which changes data. Check before retrying.",
        },
      ],
    })
    expect(
      server.requests.filter((r) => r.rpc === "tools/call").map((r) => r.tool),
    ).toEqual(["ask", "ask", "search_paths"])
    expect(plugin.status()?.code).toBe("ready")
    expect(plugin.tools()).toHaveLength(3)
  })

  test("manifest `limits` and `throttle` hooks configure the shared limiter", async () => {
    const server = fake()
    const module = defineRemoteMcpConnector(
      {
        ...EXAMPLE_MANIFEST,
        connector: {
          ...EXAMPLE_MANIFEST.connector,
          limits: { retry: { attempts: 3, fallbackDelaysMs: [1] } },
        },
      },
      {
        endpoint: server.url,
        auth: using(new FakeTokenProvider(ADA)),
        sleep: async () => {},
        // `search_paths` has no annotations; the hook makes it a read.
        throttle: {
          kind: (tool) => (tool === "search_paths" ? "read" : undefined),
        },
      },
    )
    const plugin = await loadPlugin(module, {}, { storage: ACCEPTED })
    cleanups.push(() => plugin.dispose())
    await waitFor(() => plugin.status()?.code === "ready")
    server.throttle({ status: 503, times: 3 })
    const result = await plugin.callTool("search_paths", {})
    expect(result.isError).toBe(true)
    expect(server.requests.filter((r) => r.rpc === "tools/call")).toHaveLength(
      3,
    )
    expect(server.throttled).toBe(3)
  })

  test("refreshes tools when upstream announces list_changed", async () => {
    const server = fake()
    const plugin = await load(server, new FakeTokenProvider(ADA), {
      storage: ACCEPTED,
    })
    await waitFor(() => plugin.status()?.code === "ready")
    await Bun.sleep(50)
    await server.setTools([SAMPLE_TOOLS[0]])
    await waitFor(() => plugin.tools().length === 1, { timeoutMs: 3000 })
    expect(plugin.tools().map((tool) => tool.name)).toEqual(["ask"])
    expect(
      plugin.status()?.facts?.find((fact) => fact.label === "Tools")?.value,
    ).toBe("1 (some may be restricted by your organization)")
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
        "Example needs a work or school account; personal Microsoft accounts are not supported.",
    })

    const retry = plugin.runAction("sign-in")
    await waitFor(() => tokens.signInPending)
    tokens.completeSignIn()
    await retry
    expect(plugin.status()?.code).toBe("ready")
  })
})

describe("connector tool relays", () => {
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
        // The fake issues a 2025-era push elicitation, which is what the connector relays.
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

  test("unloading during the upstream handshake still ends that session", async () => {
    const server = fake()
    let reached!: () => void
    const handshake = new Promise<void>((resolve) => (reached = resolve))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const plugin = await load(server, new FakeTokenProvider(ADA), {
      storage: ACCEPTED,
      connector: {
        // Hold the `initialized` notification: the upstream session exists,
        // the handshake has not finished.
        async fetch(url, init) {
          if (
            typeof init?.body === "string"
            && init.body.includes("notifications/initialized")
          ) {
            reached()
            await gate
          }
          return await fetch(url, init)
        },
      },
    })
    await handshake
    expect(server.sessionCount).toBe(1)
    const unloading = plugin.dispose()
    release()
    await unloading
    await waitFor(() => server.sessionCount === 0)
  })
})
