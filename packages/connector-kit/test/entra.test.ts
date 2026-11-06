import type {
  INetworkModule,
  NetworkRequestOptions,
  NetworkResponse,
} from "@azure/msal-node"

/**
 * The real MSAL provider, fully offline: MSAL's own loopback listener and
 * PKCE flow run for real; the "browser" posts the auth code back, and an
 * injected network client plays the Entra token endpoint.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"

import type { SecretStore } from "../src/auth/secret-store"
import type { TextStore } from "../src/auth/token-provider"

import {
  createMsalTokenProvider,
  entraAuth,
  LEGACY_TOKEN_CACHE_FILE,
  sealedCachePlugin,
  TOKEN_CACHE_FILE,
} from "../src/auth/entra"
import { SealedCache } from "../src/auth/sealed-cache"
import {
  ConnectorError,
  toConnectorError,
  type ConnectorErrorCode,
} from "../src/errors"
import { memorySecretStore } from "../src/testing/secret-store"
import { createUpstreamFetch } from "../src/upstream/fetch"
import { rejection } from "./rejection"

/** A made-up public client and API scope (Entra is never contacted). */
const CLIENT_ID = "00000000-0000-4000-8000-00000000c11e"
const SCOPES = ["api://00000000-0000-4000-8000-0000000000a1/Example.Read"]
const AUTHORITY = "https://login.microsoftonline.com/organizations"

const TENANT = "00000000-0000-4000-8000-0000000000aa"
const ADA_OID = "00000000-0000-4000-8000-0000000000b1"
const GRACE_OID = "00000000-0000-4000-8000-0000000000b2"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A loopback port that is free right now. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return typeof address === "object" && address ? address.port : 0
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

const b64url = (value: string) => Buffer.from(value).toString("base64url")

interface User {
  oid: string
  username: string
  name: string
}

const ADA: User = {
  oid: ADA_OID,
  username: "ada@contoso.com",
  name: "Ada Lovelace",
}
const GRACE: User = {
  oid: GRACE_OID,
  username: "grace@contoso.com",
  name: "Grace Hopper",
}

function idToken(user: User, nonce: string | undefined): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    aud: CLIENT_ID,
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    tid: TENANT,
    oid: user.oid,
    sub: `sub-${user.oid}`,
    preferred_username: user.username,
    name: user.name,
    ver: "2.0",
    iat: now,
    nbf: now,
    exp: now + 3600,
    ...(nonce ? { nonce } : {}),
  }
  return `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.sig`
}

const respond = <T>(body: unknown, status = 200): NetworkResponse<T> => ({
  headers: {},
  body: body as T,
  status,
})

/** Entra stand-in: metadata documents and a token endpoint. */
function fakeEntra() {
  const state = {
    user: ADA,
    nonce: undefined as string | undefined,
    tokenRequests: [] as Array<URLSearchParams>,
    tokenError: undefined as
      | { error: string; error_description: string }
      | undefined,
    issued: 0,
    /** When set, token responses wait for it (after the request is recorded). */
    hold: undefined as Promise<void> | undefined,
  }
  const network: INetworkModule = {
    sendGetRequestAsync<T>(url: string): Promise<NetworkResponse<T>> {
      if (url.includes("discovery/instance")) {
        return Promise.resolve(
          respond<T>({
            tenant_discovery_endpoint:
              "https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration",
            "api-version": "1.1",
            metadata: [
              {
                preferred_network: "login.microsoftonline.com",
                preferred_cache: "login.windows.net",
                aliases: [
                  "login.microsoftonline.com",
                  "login.windows.net",
                  "login.microsoft.com",
                  "sts.windows.net",
                ],
              },
            ],
          }),
        )
      }
      if (url.includes("openid-configuration")) {
        return Promise.resolve(
          respond<T>({
            token_endpoint:
              "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
            authorization_endpoint:
              "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
            end_session_endpoint:
              "https://login.microsoftonline.com/organizations/oauth2/v2.0/logout",
            issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
            jwks_uri:
              "https://login.microsoftonline.com/organizations/discovery/v2.0/keys",
            response_modes_supported: ["query", "fragment", "form_post"],
          }),
        )
      }
      return Promise.reject(new Error(`unexpected GET ${url}`))
    },
    sendPostRequestAsync<T>(
      url: string,
      options?: NetworkRequestOptions,
    ): Promise<NetworkResponse<T>> {
      if (!url.includes("/oauth2/v2.0/token"))
        return Promise.reject(new Error(`unexpected POST ${url}`))
      const form = new URLSearchParams(options?.body ?? "")
      state.tokenRequests.push(form)
      const answer = (): NetworkResponse<T> => {
        if (state.tokenError)
          return respond<T>({ ...state.tokenError, error_codes: [65001] }, 400)
        state.issued++
        return respond<T>({
          token_type: "Bearer",
          scope: SCOPES.join(" "),
          expires_in: 3600,
          ext_expires_in: 3600,
          access_token: `at-${state.issued}`,
          refresh_token: `rt-${state.issued}`,
          id_token: idToken(state.user, state.nonce),
          client_info: b64url(
            JSON.stringify({ uid: state.user.oid, utid: TENANT }),
          ),
        })
      }
      return state.hold ? state.hold.then(answer) : Promise.resolve(answer())
    },
  }
  return { state, network }
}

/** A "browser" that completes the authorize redirect by posting to MSAL's loopback listener. */
function browser(
  entra: ReturnType<typeof fakeEntra>,
  mode: "approve" | "deny" | "ignore" = "approve",
) {
  const opened: Array<string> = []
  return {
    opened,
    open: (url: string): Promise<void> => {
      opened.push(url)
      const params = new URL(url).searchParams
      entra.state.nonce = params.get("nonce") ?? undefined
      if (mode === "ignore") return Promise.resolve()
      const redirect = new URL(params.get("redirect_uri") ?? "")
      redirect.hostname = "127.0.0.1"
      const body =
        mode === "approve" ?
          new URLSearchParams({
            code: "auth-code",
            state: params.get("state") ?? "",
            client_info: b64url(
              JSON.stringify({ uid: entra.state.user.oid, utid: TENANT }),
            ),
          })
        : new URLSearchParams({
            error: "access_denied",
            error_description: "AADSTS65004: User declined to consent.",
            state: params.get("state") ?? "",
          })
      // Like a browser: deliver the form post without blocking `openBrowser`.
      void fetch(redirect, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      })
        .then((r) => r.text())
        .catch(() => {})
      return Promise.resolve()
    },
  }
}

/** The cache as MSAL serialized it, decrypted with the key in `secrets`. */
async function unsealed(
  store: TextStore,
  secrets: SecretStore,
): Promise<string | undefined> {
  return await new SealedCache({
    store,
    secrets,
    file: TOKEN_CACHE_FILE,
    keyName: "msal-token-cache",
  }).read()
}

function provider(
  store: TextStore,
  entra: ReturnType<typeof fakeEntra>,
  web: {
    open: (url: string) => Promise<void>
    signInTimeoutMs?: number
    /** The OS credential store (default a fresh in-memory one). */
    secrets?: SecretStore
  },
) {
  return createMsalTokenProvider({
    clientId: CLIENT_ID,
    authority: AUTHORITY,
    scopes: SCOPES,
    displayName: "Example",
    toError: (error) => toConnectorError(error, { name: "Example" }),
    store,
    secrets: web.secrets ?? memorySecretStore(),
    openBrowser: web.open,
    networkClient: entra.network,
    preferredPort: 0,
    signInTimeoutMs: web.signInTimeoutMs ?? 10_000,
  })
}

describe("MSAL token provider", () => {
  test("interactive auth code + PKCE via loopback, persisted cache, silent tokens", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore()
    const entra = fakeEntra()
    const web = browser(entra)
    const tokens = provider(store, entra, { ...web, secrets })

    expect(await tokens.account()).toBeUndefined()
    expect(await rejection(tokens.getToken())).toMatchObject({
      code: "signed-out",
    })

    const account = await tokens.signIn(new AbortController().signal)
    expect(account).toEqual({
      username: "ada@contoso.com",
      name: "Ada Lovelace",
      tenantId: TENANT,
    })

    const authorize = new URL(web.opened[0])
    expect(authorize.origin + authorize.pathname).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    )
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID)
    expect(authorize.searchParams.get("scope")).toContain(SCOPES[0])
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorize.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/localhost:\d+$/,
    )
    // Like agent-kit's login: no prompt on the first sign-in.
    expect(authorize.searchParams.get("prompt")).toBeNull()

    const tokenRequest = entra.state.tokenRequests.at(0)
    expect(tokenRequest?.get("grant_type")).toBe("authorization_code")
    expect(tokenRequest?.get("code")).toBe("auth-code")
    expect(tokenRequest?.get("code_verifier")).toBeTruthy()

    expect(await tokens.getToken()).toBe("at-1")
    expect(entra.state.tokenRequests).toHaveLength(1)
    // On disk only ciphertext; the key is the one entry in the credential store.
    const sealed = store.files.get(TOKEN_CACHE_FILE) ?? ""
    expect(sealed).toContain('"format":"maximal-sealed/1"')
    for (const secret of ["at-1", "rt-1", "ada@contoso.com", ADA_OID])
      expect(sealed).not.toContain(secret)
    expect(store.files.has(LEGACY_TOKEN_CACHE_FILE)).toBe(false)
    const names = [...secrets.entries.keys()]
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^msal-token-cache\/[0-9a-f]{32}$/)
    expect(await unsealed(store, secrets)).toContain("rt-1")
    expect(tokens.credentialNotice?.()).toBeUndefined()

    // A new provider (next app start) reuses the persisted cache silently.
    const restarted = provider(store, entra, {
      open: () => Promise.reject(new Error("must not open a browser")),
      secrets,
    })
    expect(await restarted.account()).toEqual(account)
    expect(await restarted.getToken()).toBe("at-1")

    await restarted.signOut()
    expect(store.files.has(TOKEN_CACHE_FILE)).toBe(false)
    expect(secrets.entries.size).toBe(0)
    expect(await restarted.account()).toBeUndefined()
  })

  test("keeps only the most recently signed-in account", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore()
    const entra = fakeEntra()
    const web = browser(entra)
    const tokens = provider(store, entra, { ...web, secrets })
    await tokens.signIn(new AbortController().signal)
    entra.state.user = GRACE
    const second = await tokens.signIn(new AbortController().signal)
    // Signing in again offers the account picker.
    expect(new URL(web.opened[1]).searchParams.get("prompt")).toBe(
      "select_account",
    )
    expect(second.username).toBe("grace@contoso.com")
    expect(await tokens.account()).toMatchObject({
      username: "grace@contoso.com",
    })
    const persisted = JSON.parse((await unsealed(store, secrets)) ?? "") as {
      Account: Record<string, unknown>
    }
    expect(Object.keys(persisted.Account)).toHaveLength(1)
  })

  test("aborting a pending sign-in releases the loopback listener", async () => {
    const entra = fakeEntra()
    const web = browser(entra, "ignore")
    const tokens = provider(memoryStore(), entra, web)
    const controller = new AbortController()
    const pending = tokens.signIn(controller.signal)
    while (web.opened.length === 0) await Bun.sleep(5)
    controller.abort()
    const error = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConnectorError)
    expect((error as ConnectorError).code).toBe("sign-in-cancelled")
    const redirect = new URL(
      new URL(web.opened[0]).searchParams.get("redirect_uri") ?? "",
    )
    redirect.hostname = "127.0.0.1"
    await Bun.sleep(20)
    expect(
      await rejection(fetch(redirect, { signal: AbortSignal.timeout(1000) })),
    ).toBeInstanceOf(Error)
  })

  test("times out an abandoned sign-in", async () => {
    const entra = fakeEntra()
    const tokens = provider(memoryStore(), entra, {
      ...browser(entra, "ignore"),
      signInTimeoutMs: 100,
    })
    expect(
      await rejection(tokens.signIn(new AbortController().signal)),
    ).toMatchObject({ code: "sign-in-timeout" })
  })
})

describe("MSAL token provider: sealed cache", () => {
  test("the cache plugin writes only when MSAL changed the cache", async () => {
    let saved: string | undefined
    const plugin = sealedCachePlugin({
      read: () => Promise.resolve(saved),
      write: (text) => {
        saved = text
        return Promise.resolve()
      },
    })
    let serialized = 0
    let seen: string | undefined
    const tokenCache = {
      deserialize: (text: string) => void (seen = text),
      serialize: () => {
        serialized++
        return "{}"
      },
    }
    await plugin.beforeCacheAccess({
      cacheHasChanged: false,
      tokenCache,
    } as never)
    expect(seen).toBeUndefined()
    await plugin.afterCacheAccess({
      cacheHasChanged: false,
      tokenCache,
    } as never)
    expect(serialized).toBe(0)
    await plugin.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache,
    } as never)
    expect(saved).toBe("{}")
    await plugin.beforeCacheAccess({
      cacheHasChanged: false,
      tokenCache,
    } as never)
    expect(seen).toBe("{}")
  })

  test("moves a plaintext cache from an older version into the credential store", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore()
    const entra = fakeEntra()
    const tokens = provider(store, entra, { ...browser(entra), secrets })
    await tokens.signIn(new AbortController().signal)
    // What an older version left behind: the same cache, in plain text.
    store.files.set(
      LEGACY_TOKEN_CACHE_FILE,
      (await unsealed(store, secrets)) ?? "",
    )
    store.files.delete(TOKEN_CACHE_FILE)
    secrets.entries.clear()

    const upgraded = provider(store, entra, {
      open: () => Promise.reject(new Error("must not open a browser")),
      secrets,
    })
    expect(await upgraded.account()).toMatchObject({
      username: "ada@contoso.com",
    })
    expect(store.files.has(LEGACY_TOKEN_CACHE_FILE)).toBe(false)
    expect(store.files.get(TOKEN_CACHE_FILE)).not.toContain("rt-1")
    expect(secrets.entries.size).toBe(1)
    expect(await upgraded.getToken()).toBe("at-1")
    expect(entra.state.tokenRequests).toHaveLength(1)

    await upgraded.signOut()
    expect([...store.files.keys()]).toEqual([])
    expect(secrets.entries.size).toBe(0)
  })

  test("without a credential store the sign-in stays in memory, never on disk", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore({
      unavailable: new Error("Cannot autolaunch D-Bus without X11 $DISPLAY"),
    })
    const entra = fakeEntra()
    const tokens = provider(store, entra, { ...browser(entra), secrets })
    await tokens.signIn(new AbortController().signal)
    expect(await tokens.getToken()).toBe("at-1")
    expect(await tokens.account()).toMatchObject({
      username: "ada@contoso.com",
    })
    expect([...store.files.keys()]).toEqual([])
    expect(tokens.credentialNotice?.()).toMatchObject({
      fact: "Kept until Maximal restarts",
    })

    // After a restart the user signs in again.
    const restarted = provider(store, entra, { ...browser(entra), secrets })
    expect(await restarted.account()).toBeUndefined()
  })
})

describe("MSAL token provider: failures and refresh", () => {
  test("maps a declined consent and a missing admin consent", async () => {
    const entra = fakeEntra()
    const denied = provider(memoryStore(), entra, browser(entra, "deny"))
    expect(
      await rejection(denied.signIn(new AbortController().signal)),
    ).toMatchObject({ code: "sign-in-cancelled" })

    entra.state.tokenError = {
      error: "invalid_grant",
      error_description:
        "AADSTS65001: The user or administrator has not consented to use the application.",
    }
    const noConsent = provider(memoryStore(), entra, browser(entra))
    expect(
      await rejection(noConsent.signIn(new AbortController().signal)),
    ).toMatchObject({ code: "consent-needed" })
  })

  test("maps every Entra sign-in block to a clear code", async () => {
    const cases: Array<[string, ConnectorErrorCode]> = [
      ["AADSTS90094: Admin approval is required.", "consent-needed"],
      [
        "AADSTS50105: The signed in user is not assigned to a role for the application.",
        "not-assigned",
      ],
      [
        "AADSTS53003: Access has been blocked by Conditional Access policies.",
        "conditional-access",
      ],
      ["AADSTS7000112: Application is disabled.", "app-disabled"],
      [
        "AADSTS700016: Application with identifier was not found in the directory.",
        "app-disabled",
      ],
    ]
    for (const [description, code] of cases) {
      const entra = fakeEntra()
      entra.state.tokenError = {
        error: "invalid_grant",
        error_description: description,
      }
      const tokens = provider(memoryStore(), entra, browser(entra))
      const error = await rejection(tokens.signIn(new AbortController().signal))
      expect({ description, code: (error as ConnectorError).code }).toEqual({
        description,
        code,
      })
      expect((error as ConnectorError).accountLevel).toBe(true)
    }
  })

  test("a rejected access token is refreshed once with forceRefresh", async () => {
    const entra = fakeEntra()
    const tokens = provider(memoryStore(), entra, browser(entra))
    await tokens.signIn(new AbortController().signal)
    expect(await tokens.getToken()).toBe("at-1")
    expect(await tokens.invalidate?.()).toBe(true)
    expect(await tokens.getToken()).toBe("at-2")
    expect(entra.state.tokenRequests.at(-1)?.get("grant_type")).toBe(
      "refresh_token",
    )
    // Nothing cached to drop the second time round.
    expect(await tokens.getToken()).toBe("at-2")
  })

  test("concurrent 401s for one token share a single refresh and both retry", async () => {
    const entra = fakeEntra()
    const tokens = provider(memoryStore(), entra, browser(entra))
    await tokens.signIn(new AbortController().signal)
    // Both requests carry at-1 and are refused together.
    let arrived = 0
    let bothArrived!: () => void
    const together = new Promise<void>((resolve) => (bothArrived = resolve))
    const sent: Array<string | null> = []
    const upstreamFetch = createUpstreamFetch({
      getToken: (s) => tokens.getToken(s),
      onUnauthorized: (rejected) =>
        tokens.invalidate?.(rejected) ?? Promise.resolve(false),
      origin: "https://mcp.example.com",
      baseFetch: async (_url, init) => {
        const authorization = new Headers(init?.headers).get("authorization")
        sent.push(authorization)
        if (authorization !== "Bearer at-1") return new Response("ok")
        if (++arrived === 2) bothArrived()
        await together
        return new Response("expired", { status: 401 })
      },
    })
    const responses = await Promise.all([
      upstreamFetch("https://mcp.example.com/mcp", { method: "POST" }),
      upstreamFetch("https://mcp.example.com/mcp", { method: "POST" }),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(sent.toSorted()).toEqual([
      "Bearer at-1",
      "Bearer at-1",
      "Bearer at-2",
      "Bearer at-2",
    ])
    const refreshes = entra.state.tokenRequests.filter(
      (form) => form.get("grant_type") === "refresh_token",
    )
    expect(refreshes).toHaveLength(1)
  })

  test("a token lookup that straddles sign-out neither refills the cache nor resurrects the account", async () => {
    const entra = fakeEntra()
    const store = memoryStore()
    const secrets = memorySecretStore()
    const tokens = provider(store, entra, { ...browser(entra), secrets })
    await tokens.signIn(new AbortController().signal)
    expect(await tokens.getToken()).toBe("at-1")
    await tokens.invalidate?.("at-1")
    let release!: () => void
    entra.state.hold = new Promise<void>((resolve) => (release = resolve))
    const requests = entra.state.tokenRequests.length
    const pending = tokens.getToken()
    while (entra.state.tokenRequests.length === requests) await Bun.sleep(1)
    await tokens.signOut()
    entra.state.hold = undefined
    release()
    expect(await rejection(pending)).toMatchObject({ code: "signed-out" })
    expect(await rejection(tokens.getToken())).toMatchObject({
      code: "signed-out",
    })
    expect(await tokens.account()).toBeUndefined()
    expect(store.files.has(TOKEN_CACHE_FILE)).toBe(false)
    expect(secrets.entries.size).toBe(0)
  })

  test("uses the registered redirect port and never falls back to another", async () => {
    const port = await freePort()
    const entra = fakeEntra()
    const strategy = entraAuth(
      {
        type: "entra",
        clientId: CLIENT_ID,
        authority: AUTHORITY,
        scopes: SCOPES,
        redirectUri: `http://localhost:${port}`,
      },
      { networkClient: entra.network },
    )
    const web = browser(entra)
    const env = {
      displayName: "Example",
      endpoint: "https://mcp.example.com/mcp",
      config: {},
      store: memoryStore(),
      secrets: memorySecretStore(),
      openBrowser: web.open,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      signInTimeoutMs: 10_000,
      toError: (error: unknown) => toConnectorError(error, { name: "Example" }),
    }
    const tokens = strategy.create(env)
    await tokens.signIn(new AbortController().signal)
    expect(new URL(web.opened[0]).searchParams.get("redirect_uri")).toBe(
      `http://localhost:${port}`,
    )

    // Another program holds the port: fail clearly, without opening a browser.
    const blocker = createServer()
    await new Promise<void>((resolve) =>
      blocker.listen(port, "127.0.0.1", resolve),
    )
    cleanups.push(
      () => new Promise<void>((resolve) => blocker.close(() => resolve())),
    )
    const busy = strategy.create({ ...env, store: memoryStore() })
    const error = await rejection(busy.signIn(new AbortController().signal))
    expect(error).toMatchObject({ code: "port-in-use" })
    expect((error as Error).message).toContain(`port ${port}`)
    expect(web.opened).toHaveLength(1)
  })
})
