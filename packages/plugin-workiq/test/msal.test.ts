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

import type { TextStore } from "../src/auth/token-provider"

import {
  createMsalTokenProvider,
  storageCachePlugin,
  TOKEN_CACHE_FILE,
} from "../src/auth/msal"
import { WORKIQ_CLIENT_ID, WORKIQ_SCOPES } from "../src/config"
import { WorkIqError } from "../src/errors"
import { rejection } from "./rejection"

const TENANT = "00000000-0000-4000-8000-0000000000aa"
const ADA_OID = "00000000-0000-4000-8000-0000000000b1"
const GRACE_OID = "00000000-0000-4000-8000-0000000000b2"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

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
    aud: WORKIQ_CLIENT_ID,
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
      if (state.tokenError) {
        return Promise.resolve(
          respond<T>({ ...state.tokenError, error_codes: [65001] }, 400),
        )
      }
      state.issued++
      return Promise.resolve(
        respond<T>({
          token_type: "Bearer",
          scope: WORKIQ_SCOPES.join(" "),
          expires_in: 3600,
          ext_expires_in: 3600,
          access_token: `at-${state.issued}`,
          refresh_token: `rt-${state.issued}`,
          id_token: idToken(state.user, state.nonce),
          client_info: b64url(
            JSON.stringify({ uid: state.user.oid, utid: TENANT }),
          ),
        }),
      )
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

function provider(
  store: TextStore,
  entra: ReturnType<typeof fakeEntra>,
  web: { open: (url: string) => Promise<void>; signInTimeoutMs?: number },
) {
  return createMsalTokenProvider({
    authority: "https://login.microsoftonline.com/organizations",
    store,
    openBrowser: web.open,
    networkClient: entra.network,
    preferredPort: 0,
    signInTimeoutMs: web.signInTimeoutMs ?? 10_000,
  })
}

describe("MSAL token provider", () => {
  test("interactive auth code + PKCE via loopback, persisted cache, silent tokens", async () => {
    const store = memoryStore()
    const entra = fakeEntra()
    const web = browser(entra)
    const tokens = provider(store, entra, web)

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
    expect(authorize.searchParams.get("client_id")).toBe(WORKIQ_CLIENT_ID)
    expect(authorize.searchParams.get("scope")).toContain(WORKIQ_SCOPES[0])
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorize.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/localhost:\d+$/,
    )
    expect(authorize.searchParams.get("prompt")).toBe("select_account")

    const tokenRequest = entra.state.tokenRequests.at(0)
    expect(tokenRequest?.get("grant_type")).toBe("authorization_code")
    expect(tokenRequest?.get("code")).toBe("auth-code")
    expect(tokenRequest?.get("code_verifier")).toBeTruthy()

    expect(await tokens.getToken()).toBe("at-1")
    expect(entra.state.tokenRequests).toHaveLength(1)
    expect(store.files.has(TOKEN_CACHE_FILE)).toBe(true)

    // A new provider (next app start) reuses the persisted cache silently.
    const restarted = provider(store, entra, {
      open: () => Promise.reject(new Error("must not open a browser")),
    })
    expect(await restarted.account()).toEqual(account)
    expect(await restarted.getToken()).toBe("at-1")

    await restarted.signOut()
    expect(store.files.has(TOKEN_CACHE_FILE)).toBe(false)
    expect(await restarted.account()).toBeUndefined()
  })

  test("keeps only the most recently signed-in account", async () => {
    const store = memoryStore()
    const entra = fakeEntra()
    const tokens = provider(store, entra, browser(entra))
    await tokens.signIn(new AbortController().signal)
    entra.state.user = GRACE
    const second = await tokens.signIn(new AbortController().signal)
    expect(second.username).toBe("grace@contoso.com")
    expect(await tokens.account()).toMatchObject({
      username: "grace@contoso.com",
    })
    const persisted = JSON.parse(store.files.get(TOKEN_CACHE_FILE) ?? "") as {
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
    expect(error).toBeInstanceOf(WorkIqError)
    expect((error as WorkIqError).code).toBe("sign-in-cancelled")
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

  test("the cache plugin writes only when MSAL changed the cache", async () => {
    const store = memoryStore()
    const plugin = storageCachePlugin(store, "cache.json")
    let serialized = 0
    const tokenCache = {
      deserialize: (text: string) => void store.files.set("seen", text),
      serialize: () => {
        serialized++
        return "{}"
      },
    }
    await plugin.afterCacheAccess({
      cacheHasChanged: false,
      tokenCache,
    } as never)
    expect(serialized).toBe(0)
    await plugin.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache,
    } as never)
    expect(store.files.get("cache.json")).toBe("{}")
    await plugin.beforeCacheAccess({
      cacheHasChanged: false,
      tokenCache,
    } as never)
    expect(store.files.get("seen")).toBe("{}")
  })
})
