import { loadPlugin, waitFor } from "@stuffbucket/maximal-plugin-sdk/testing"
import { afterEach, describe, expect, test } from "bun:test"

import type { TextStore } from "../src/auth/token-provider"

import {
  createMcpOAuthTokenProvider,
  OAUTH_FILE,
  type McpOAuthOptions,
} from "../src/auth/mcp-oauth"
import { defineRemoteMcpConnector } from "../src/define"
import { ConnectorError, toConnectorError } from "../src/errors"
import {
  startFakeRemoteMcp,
  type FakeRemoteMcp,
  type FakeRemoteMcpOptions,
} from "../src/testing/fake-server"
import { rejection } from "./rejection"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fake(options: FakeRemoteMcpOptions): FakeRemoteMcp {
  const server = startFakeRemoteMcp(options)
  cleanups.push(() => server.close())
  return server
}

function memoryStore(): TextStore & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    readText: (name) => Promise.resolve(files.get(name)),
    writeText: (name, text) => {
      files.set(name, text)
      return Promise.resolve()
    },
    delete: (name) => {
      files.delete(name)
      return Promise.resolve()
    },
  }
}

/** A "browser": follows the authorize redirect back to the loopback listener. */
function browser() {
  const opened: Array<string> = []
  return {
    opened,
    open: (url: string): Promise<void> => {
      opened.push(url)
      void fetch(url)
        .then((response) => response.text())
        .catch(() => {})
      return Promise.resolve()
    },
  }
}

function provider(
  server: FakeRemoteMcp,
  overrides: Partial<McpOAuthOptions> = {},
) {
  const store = memoryStore()
  const web = browser()
  const tokens = createMcpOAuthTokenProvider({
    endpoint: server.url,
    displayName: "Example",
    store,
    openBrowser: web.open,
    toError: (error) =>
      toConnectorError(error, { name: "Example", endpoint: server.url }),
    signInTimeoutMs: 10_000,
    ...overrides,
  })
  return { tokens, store, web }
}

const signal = () => new AbortController().signal

describe("mcp-oauth sign-in", () => {
  test("discovers the AS via RFC 9728, signs in with PKCE + resource, and stores tokens only in its own storage", async () => {
    const server = fake({
      oauth: {
        clientId: "maximal-test",
        scopes: ["mcp.read"],
        idTokenClaims: { preferred_username: "ada@contoso.com", name: "Ada" },
      },
    })
    const { tokens, store, web } = provider(server, {
      clientId: "maximal-test",
      scopes: ["mcp.read", "mcp.write"],
    })
    expect(await tokens.account()).toBeUndefined()
    expect(await rejection(tokens.getToken())).toMatchObject({
      code: "signed-out",
    })

    const account = await tokens.signIn(signal())
    expect(account).toEqual({
      username: "ada@contoso.com",
      name: "Ada",
      issuer: server.origin,
    })

    const authorize = server.oauth.authorizations[0]
    expect(new URL(web.opened[0]).origin).toBe(server.origin)
    expect(authorize.get("client_id")).toBe("maximal-test")
    expect(authorize.get("response_type")).toBe("code")
    expect(authorize.get("code_challenge_method")).toBe("S256")
    expect(authorize.get("resource")).toBe(server.url)
    expect(authorize.get("scope")).toBe("mcp.read mcp.write")
    expect(authorize.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    )
    expect(authorize.get("state")).toBeTruthy()

    const exchange = server.oauth.tokenRequests[0]
    expect(exchange.get("grant_type")).toBe("authorization_code")
    expect(exchange.get("code_verifier")).toBeTruthy()
    expect(exchange.get("resource")).toBe(server.url)
    expect(server.oauth.registrations).toEqual([])

    expect(await tokens.getToken()).toBe("token-1")
    expect(await tokens.account()).toEqual(account)
    const stored = JSON.parse(store.files.get(OAUTH_FILE) ?? "") as {
      tokens: { access_token: string; refresh_token: string }
      client?: unknown
    }
    expect(stored.tokens.access_token).toBe("token-1")
    expect(stored.client).toBeUndefined()

    await tokens.signOut()
    expect(store.files.has(OAUTH_FILE)).toBe(false)
    expect(await tokens.account()).toBeUndefined()
  })

  test("refreshes an expiring token with the resource indicator", async () => {
    const server = fake({ oauth: { clientId: "c", expiresIn: 30 } })
    const { tokens } = provider(server, { clientId: "c" })
    await tokens.signIn(signal())
    server.token = "token-2"
    // 30 s is inside the refresh margin, so the next lookup refreshes.
    expect(await tokens.getToken()).toBe("token-2")
    const refresh = server.oauth.tokenRequests.at(-1)
    expect(refresh?.get("grant_type")).toBe("refresh_token")
    expect(refresh?.get("resource")).toBe(server.url)
    expect(refresh?.get("client_id")).toBe("c")
  })

  test("a rejected refresh token means signing in again", async () => {
    const server = fake({ oauth: { clientId: "c" } })
    const { tokens, store } = provider(server, { clientId: "c" })
    await tokens.signIn(signal())
    const stored = JSON.parse(store.files.get(OAUTH_FILE) ?? "") as Record<
      string,
      unknown
    > & { tokens: Record<string, unknown> }
    store.files.set(
      OAUTH_FILE,
      JSON.stringify({
        ...stored,
        tokens: { ...stored.tokens, refresh_token: "revoked" },
        expiresAt: 0,
      }),
    )
    const restarted = createMcpOAuthTokenProvider({
      endpoint: server.url,
      clientId: "c",
      displayName: "Example",
      store,
      openBrowser: () => Promise.reject(new Error("no browser")),
      toError: (error) => toConnectorError(error, { name: "Example" }),
      signInTimeoutMs: 1000,
    })
    expect(await rejection(restarted.getToken())).toMatchObject({
      code: "signed-out",
      message: "Your Example sign-in has expired. Sign in again.",
    })
    expect(await restarted.account()).toBeUndefined()
  })

  test("registers dynamically when there is no client id and the AS allows it", async () => {
    const server = fake({ oauth: { registration: true } })
    const { tokens, store } = provider(server)
    await tokens.signIn(signal())
    expect(server.oauth.registrations).toHaveLength(1)
    expect(server.oauth.registrations[0]).toMatchObject({
      client_name: "Maximal",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    })
    expect(server.oauth.authorizations[0].get("client_id")).toBe("dcr-1")
    const stored = JSON.parse(store.files.get(OAUTH_FILE) ?? "") as {
      client: { client_id: string }
    }
    expect(stored.client.client_id).toBe("dcr-1")
    expect(await tokens.getToken()).toBe("token-1")
  })

  test("fails clearly without a client id when the AS offers no registration", async () => {
    const server = fake({ oauth: {} })
    const { tokens } = provider(server)
    const error = await rejection(tokens.signIn(signal()))
    expect(error).toBeInstanceOf(ConnectorError)
    expect((error as ConnectorError).message).toContain(
      "does not support dynamic client registration",
    )
  })

  test("a denied consent is a cancelled sign-in; abort releases the listener", async () => {
    const server = fake({ oauth: { clientId: "c", denyWith: "access_denied" } })
    const denied = provider(server, { clientId: "c" })
    expect(await rejection(denied.tokens.signIn(signal()))).toMatchObject({
      code: "sign-in-cancelled",
    })

    const ignored = provider(server, {
      clientId: "c",
      openBrowser: () => Promise.resolve(),
    })
    const controller = new AbortController()
    const pending = ignored.tokens.signIn(controller.signal)
    await Bun.sleep(50)
    controller.abort()
    expect(await rejection(pending)).toMatchObject({
      code: "sign-in-cancelled",
    })
  })
})

describe("mcp-oauth connector", () => {
  test("signs in through the host browser and retries a 401 once with a refreshed token", async () => {
    const server = fake({
      oauth: {
        clientId: "maximal-test",
        idTokenClaims: { email: "grace@contoso.com" },
      },
    })
    const module = defineRemoteMcpConnector({
      id: "remote",
      kind: "connector",
      displayName: "Remote",
      description: "A remote MCP server with MCP OAuth.",
      settingsVersion: 1,
      connector: {
        transport: "streamable-http",
        endpoint: server.url,
        auth: { type: "mcp-oauth", clientId: "maximal-test" },
      },
    })
    expect(module.Config.parse({})).toEqual({ endpoint: server.url })
    const web = browser()
    const plugin = await loadPlugin(module, {}, { openExternal: web.open })
    cleanups.push(() => plugin.dispose())
    await waitFor(() => plugin.status()?.code === "signin-needed")
    expect(plugin.status()?.summary).toBe("Sign in to Remote")

    await plugin.runAction("sign-in")
    expect(plugin.status()).toMatchObject({
      code: "ready",
      summary: "Connected as grace@contoso.com",
    })
    expect(plugin.testbed.host.opened).toHaveLength(1)
    expect(Object.keys(plugin.testbed.storage.files("remote"))).toEqual([
      OAUTH_FILE,
    ])

    // The server rotates its accepted token; the connector refreshes once and retries.
    server.token = "token-2"
    const result = await plugin.callTool("search_paths", { query: "x" })
    expect(result.isError).toBeUndefined()
    expect(server.oauth.tokenRequests.at(-1)?.get("grant_type")).toBe(
      "refresh_token",
    )
    expect(plugin.status()?.code).toBe("ready")
  })
})
