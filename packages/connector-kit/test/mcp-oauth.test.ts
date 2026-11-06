import { loadPlugin, waitFor } from "@stuffbucket/maximal-plugin-sdk/testing"
import { afterEach, describe, expect, test } from "bun:test"

import type { SecretStore } from "../src/auth/secret-store"
import type { TextStore } from "../src/auth/token-provider"

import { startLoopbackRedirect } from "../src/auth/loopback"
import {
  createMcpOAuthTokenProvider,
  LEGACY_OAUTH_FILE,
  OAUTH_FILE,
  type McpOAuthOptions,
} from "../src/auth/mcp-oauth"
import { SealedCache } from "../src/auth/sealed-cache"
import { defineRemoteMcpConnector } from "../src/define"
import { ConnectorError, toConnectorError } from "../src/errors"
import {
  startFakeRemoteMcp,
  type FakeRemoteMcp,
  type FakeRemoteMcpOptions,
} from "../src/testing/fake-server"
import { memorySecretStore } from "../src/testing/secret-store"
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

/** The OAuth state as the provider sealed it, opened with the key in `secrets`. */
function sealedState(store: TextStore, secrets: SecretStore): SealedCache {
  return new SealedCache({
    store,
    secrets,
    file: OAUTH_FILE,
    keyName: "mcp-oauth",
  })
}

async function stored(store: TextStore, secrets: SecretStore) {
  const text = await sealedState(store, secrets).read()
  return JSON.parse(text ?? "{}") as {
    tokens?: { access_token: string; refresh_token?: string }
    client?: { client_id: string }
    expiresAt?: number
  }
}

function provider(
  server: FakeRemoteMcp,
  overrides: Partial<McpOAuthOptions> = {},
) {
  const store = memoryStore()
  const secrets = memorySecretStore()
  const web = browser()
  const tokens = createMcpOAuthTokenProvider({
    endpoint: server.url,
    displayName: "Example",
    store,
    secrets,
    openBrowser: web.open,
    toError: (error) =>
      toConnectorError(error, { name: "Example", endpoint: server.url }),
    signInTimeoutMs: 10_000,
    ...overrides,
  })
  return { tokens, store, secrets, web }
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
    const { tokens, store, secrets, web } = provider(server, {
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
    const state = await stored(store, secrets)
    expect(state.tokens?.access_token).toBe("token-1")
    expect(state.client).toBeUndefined()
    // On disk only the sealed file, with no usable token in it; the key is
    // in the credential store.
    expect([...store.files.keys()]).toEqual([OAUTH_FILE])
    expect(store.files.get(OAUTH_FILE)).not.toContain("token-1")
    expect(secrets.entries.size).toBe(1)
    expect(tokens.credentialNotice?.()).toBeUndefined()

    await tokens.signOut()
    expect(store.files.has(OAUTH_FILE)).toBe(false)
    expect(secrets.entries.size).toBe(0)
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
    const { tokens, store, secrets } = provider(server, { clientId: "c" })
    await tokens.signIn(signal())
    const state = await stored(store, secrets)
    await sealedState(store, secrets).write(
      JSON.stringify({
        ...state,
        tokens: { ...state.tokens, refresh_token: "revoked" },
        expiresAt: 0,
      }),
    )
    const restarted = createMcpOAuthTokenProvider({
      endpoint: server.url,
      clientId: "c",
      displayName: "Example",
      store,
      secrets,
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
    const { tokens, store, secrets } = provider(server)
    await tokens.signIn(signal())
    expect(server.oauth.registrations).toHaveLength(1)
    expect(server.oauth.registrations[0]).toMatchObject({
      client_name: "Maximal",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    })
    expect(server.oauth.authorizations[0].get("client_id")).toBe("dcr-1")
    expect((await stored(store, secrets)).client?.client_id).toBe("dcr-1")
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

/** A fetch whose refresh-token requests wait for `release()`. */
function heldRefresh() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let held = 0
  const fetchFn = async (url: string | URL, init?: RequestInit) => {
    let body = typeof init?.body === "string" ? init.body : ""
    if (init?.body instanceof URLSearchParams) body = init.body.toString()
    if (body.includes("grant_type=refresh_token")) {
      held++
      await gate
    }
    return await fetch(url, init)
  }
  return { fetchFn, release, held: () => held }
}

describe("mcp-oauth state at rest", () => {
  test("an older plaintext oauth.json moves into the sealed file and is deleted", async () => {
    const server = fake({ oauth: { clientId: "c" } })
    const signedIn = provider(server, { clientId: "c" })
    await signedIn.tokens.signIn(signal())
    const plaintext = JSON.stringify(
      await stored(signedIn.store, signedIn.secrets),
    )
    expect(plaintext).toContain("token-1")

    // A data folder as an older Maximal left it.
    const store = memoryStore()
    store.files.set(LEGACY_OAUTH_FILE, plaintext)
    const secrets = memorySecretStore()
    const upgraded = createMcpOAuthTokenProvider({
      endpoint: server.url,
      clientId: "c",
      displayName: "Example",
      store,
      secrets,
      openBrowser: () => Promise.reject(new Error("no browser")),
      toError: (error) => toConnectorError(error, { name: "Example" }),
      signInTimeoutMs: 1000,
    })
    expect(await upgraded.getToken()).toBe("token-1")
    expect([...store.files.keys()]).toEqual([OAUTH_FILE])
    expect(store.files.get(OAUTH_FILE)).not.toContain("token-1")
  })

  test("without a credential store the sign-in stays in memory and nothing is written", async () => {
    const server = fake({ oauth: { clientId: "c" } })
    const secrets = memorySecretStore({
      unavailable: new Error("libsecret not available"),
    })
    const { tokens, store } = provider(server, { clientId: "c", secrets })
    await tokens.signIn(signal())
    expect(await tokens.getToken()).toBe("token-1")
    expect(store.files.size).toBe(0)
    expect(tokens.credentialNotice?.()).toMatchObject({
      fact: "Kept until Maximal restarts",
    })
  })
})

describe("mcp-oauth refresh", () => {
  test("a caller's abort leaves the shared refresh running, and the rotated tokens are saved", async () => {
    const server = fake({ oauth: { clientId: "c", expiresIn: 30 } })
    const hold = heldRefresh()
    const { tokens, store, secrets } = provider(server, {
      clientId: "c",
      fetch: hold.fetchFn,
    })
    await tokens.signIn(signal())
    const before = (await stored(store, secrets)).tokens?.refresh_token
    server.token = "token-2"
    const impatient = new AbortController()
    const first = tokens.getToken(impatient.signal)
    const second = tokens.getToken()
    while (hold.held() === 0) await Bun.sleep(1)
    impatient.abort()
    expect(await rejection(first)).toMatchObject({ name: "AbortError" })
    hold.release()
    expect(await second).toBe("token-2")
    expect(hold.held()).toBe(1)
    const rotated = (await stored(store, secrets)).tokens?.refresh_token
    expect(rotated).toBeDefined()
    expect(rotated).not.toBe(before)
    // The rotated refresh token works for the next refresh (no invalid_grant).

    server.token = "token-3"
    expect(await tokens.getToken()).toBe("token-3")
  })

  test("sign-out wins over a refresh in flight: nothing is written back", async () => {
    const server = fake({ oauth: { clientId: "c", expiresIn: 30 } })
    const hold = heldRefresh()
    const { tokens, store } = provider(server, {
      clientId: "c",
      fetch: hold.fetchFn,
    })
    await tokens.signIn(signal())
    const pending = tokens.getToken()
    while (hold.held() === 0) await Bun.sleep(1)
    await tokens.signOut()
    hold.release()
    expect(await rejection(pending)).toMatchObject({ code: "signed-out" })
    expect(store.files.has(OAUTH_FILE)).toBe(false)
    expect(await tokens.account()).toBeUndefined()
  })

  test("a 401 for a token another request already refreshed retries without refreshing again", async () => {
    const server = fake({ oauth: { clientId: "c" } })
    const issue = (token: string) => {
      server.token = token
    }
    const refreshes = () =>
      server.oauth.tokenRequests.filter(
        (form) => form.get("grant_type") === "refresh_token",
      ).length
    const { tokens } = provider(server, { clientId: "c" })
    await tokens.signIn(signal())
    issue("token-2")
    expect(await tokens.invalidate?.("token-1")).toBe(true)
    expect(await tokens.getToken()).toBe("token-2")
    expect(refreshes()).toBe(1)
    // A second request's 401 for token-1, already replaced: just retry.
    expect(await tokens.invalidate?.("token-1")).toBe(true)
    expect(await tokens.getToken()).toBe("token-2")
    expect(refreshes()).toBe(1)
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
    const secrets = memorySecretStore()
    const module = defineRemoteMcpConnector(
      {
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
      },
      { secretStore: secrets },
    )
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
    // The key is in the (scoped) credential store, not on disk.
    expect([...secrets.entries.keys()]).toEqual([
      expect.stringMatching(/^remote\/mcp-oauth\//) as unknown as string,
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

describe("loopback redirect", () => {
  test("a callback with the wrong (or no) state is refused and the sign-in keeps waiting", async () => {
    const loopback = await startLoopbackRedirect(
      { state: "expected", page: (ok) => (ok ? "ok" : "no") },
      signal(),
    )
    cleanups.push(() => loopback.close())
    let settled = false
    void loopback.result.then(() => (settled = true))
    for (const query of [
      "?code=forged&state=other",
      "?error=access_denied&state=other",
      "?code=forged",
    ]) {
      const response = await fetch(`${loopback.redirectUri}${query}`)
      expect(response.status).toBe(400)
      await response.text()
    }
    await Bun.sleep(5)
    expect(settled).toBe(false)
    const response = await fetch(
      `${loopback.redirectUri}?code=real&state=expected`,
    )
    expect(response.status).toBe(200)
    await response.text()
    expect((await loopback.result).get("code")).toBe("real")
  })
})
