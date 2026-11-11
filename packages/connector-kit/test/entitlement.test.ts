import { loadPlugin, waitFor } from "@stuffbucket/maximal-plugin-sdk/testing"
import { afterEach, describe, expect, test } from "bun:test"

import type { AuthStrategy } from "../src/auth/token-provider"

import { defineRemoteMcpConnector } from "../src/define"
import { ConnectorError } from "../src/errors"
import { ADA, FakeTokenProvider } from "../src/testing/fake-auth"
import {
  SAMPLE_TOOLS,
  startFakeRemoteMcp,
  type FakeRemoteMcp,
} from "../src/testing/fake-server"
import { EXAMPLE_MANIFEST, TERMS_URL } from "./fixtures"

/**
 * Admin entitlement is partial and can change: sign-in may be blocked, a
 * signed-in account may not be entitled, specific requests may be refused,
 * and all of it can change later.
 */

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ACCEPTED = {
  example: {
    "terms.json": JSON.stringify({ accepted: true, terms: TERMS_URL }),
  },
}
const HINT =
  "An admin can check the Example app (00000000-0000-4000-8000-00000000c11e)."

function fake(): FakeRemoteMcp {
  const server = startFakeRemoteMcp()
  cleanups.push(() => server.close())
  return server
}

function using(tokens: FakeTokenProvider): AuthStrategy {
  return { type: "fake", interactive: true, create: () => tokens }
}

async function load(server: FakeRemoteMcp, tokens: FakeTokenProvider) {
  const module = defineRemoteMcpConnector(EXAMPLE_MANIFEST, {
    endpoint: server.url,
    auth: using(tokens),
    errors: {
      adminHint: HINT,
      messages: {
        "policy-denied":
          "Your organization's Example policy doesn't allow this request.",
      },
    },
    retryDelaysMs: [1],
    sleep: async () => {},
  })
  const plugin = await loadPlugin(module, {}, { storage: ACCEPTED })
  cleanups.push(() => plugin.dispose())
  return plugin
}

describe("sign-in blocked by the tenant", () => {
  const blocked: Array<[string, string, string]> = [
    [
      "AADSTS65001: The user or administrator has not consented to use the application.",
      "consent-needed",
      "Your organization has not approved Example.",
    ],
    [
      "AADSTS90094: Admin approval is required.",
      "consent-needed",
      "Your organization has not approved Example.",
    ],
    [
      "AADSTS50105: The signed in user is not assigned to a role for the application.",
      "not-assigned",
      "Your account is not assigned to Example",
    ],
    [
      "AADSTS53003: Access has been blocked by Conditional Access policies.",
      "conditional-access",
      "Conditional Access policy blocked sign-in to Example",
    ],
    [
      "AADSTS7000112: Application is disabled.",
      "app-disabled",
      "Example is disabled or not available in your organization.",
    ],
    [
      "AADSTS700016: Application was not found in the directory.",
      "app-disabled",
      "Example is disabled or not available in your organization.",
    ],
  ]
  for (const [aadError, code, summary] of blocked) {
    test(`${code}: ${aadError.slice(0, 13)}`, async () => {
      const server = fake()
      const tokens = new FakeTokenProvider()
      tokens.manualSignIn = true
      const plugin = await load(server, tokens)
      await waitFor(() => plugin.status()?.code === "signin-needed")
      const signingIn = plugin.runAction("sign-in")
      await waitFor(() => tokens.signInPending)
      tokens.failSignIn(
        Object.assign(new Error(aadError), {
          name: "ServerError",
          errorCode: "invalid_grant",
          errorMessage: aadError,
        }),
      )
      await signingIn
      const status = plugin.status()
      expect(status?.state).toBe("error")
      expect(status?.summary).toContain(summary)
      expect(status?.detail).toBe(`${HINT} Reason: ${code}.`)
      expect(status?.detail).not.toContain("at ")
      expect(status?.actions?.map((action) => action.id)).toEqual([
        "retry",
        "sign-in",
      ])
      expect(plugin.tools()).toEqual([])
    })
  }

  test("a cancelled or timed-out sign-in just asks to sign in again", async () => {
    const server = fake()
    const tokens = new FakeTokenProvider()
    tokens.manualSignIn = true
    const plugin = await load(server, tokens)
    await waitFor(() => plugin.status()?.code === "signin-needed")
    for (const failure of [
      new Error("access_denied: AADSTS65004: User declined to consent."),
      new ConnectorError(
        "sign-in-timeout",
        "Sign-in timed out after 5 minute(s). Try again.",
      ),
    ]) {
      const signingIn = plugin.runAction("sign-in")
      await waitFor(() => tokens.signInPending)
      tokens.failSignIn(failure)
      await signingIn
      expect(plugin.status()).toMatchObject({
        state: "needs-setup",
        code: "signin-needed",
        actions: [{ id: "sign-in" }],
      })
    }
  })
})

describe("signed in but not entitled", () => {
  test("401 after a refreshed token: error, sign-in kept, retry recovers once enabled", async () => {
    const server = fake()
    const tokens = new FakeTokenProvider(ADA)
    tokens.refreshable = true
    tokens.token = "refused"
    const plugin = await load(server, tokens)
    await waitFor(() => plugin.status()?.state === "error")
    expect(tokens.invalidateCalls).toBeGreaterThan(0)
    expect(plugin.status()).toMatchObject({
      code: "error",
      summary:
        "Your organization hasn't enabled Example for this account. You stay signed in; choose Try again once your administrator has enabled it.",
      detail: `${HINT} Reason: not-entitled (HTTP 401).`,
      facts: [
        { label: "Account", value: "ada@contoso.com" },
        { label: "Tenant", value: String(ADA.tenantId) },
      ],
      actions: [{ id: "retry" }, { id: "sign-in" }, { id: "sign-out" }],
    })
    expect(tokens.signOutCalls).toBe(0)
    expect(tokens.signedIn).toEqual(ADA)

    // The admin enables the account; the user tries again.
    server.token = "refused"
    await plugin.runAction("retry")
    expect(plugin.status()?.code).toBe("ready")
    expect(plugin.tools()).toHaveLength(3)
  })

  test("a 401 the identity provider cannot refresh still means signing in again", async () => {
    const server = fake()
    const tokens = new FakeTokenProvider(ADA)
    tokens.token = "stale"
    const plugin = await load(server, tokens)
    await waitFor(() => plugin.status()?.code === "signin-needed")
    expect(plugin.status()?.detail).toBe(
      "Example did not accept your sign-in (HTTP 401). Sign in again.",
    )
  })

  test("403 on initialize or tools/list: not enabled (or not licensed), sign-in kept", async () => {
    const server = fake()
    server.fail({ status: 403, rpc: "initialize", body: "Forbidden" })
    const tokens = new FakeTokenProvider(ADA)
    const plugin = await load(server, tokens)
    await waitFor(() => plugin.status()?.state === "error")
    expect(plugin.status()).toMatchObject({
      summary: expect.stringContaining(
        "Your organization hasn't enabled Example for this account.",
      ) as string,
      detail: `${HINT} Reason: not-entitled (HTTP 403).`,
      actions: [{ id: "retry" }, { id: "sign-in" }, { id: "sign-out" }],
    })

    server.fail({
      status: 403,
      rpc: "tools/list",
      body: '{"error":{"message":"User does not have a valid license."}}',
    })
    await plugin.runAction("retry")
    expect(plugin.status()).toMatchObject({
      state: "error",
      detail: `${HINT} Reason: license-needed (HTTP 403).`,
    })
    expect(tokens.signOutCalls).toBe(0)

    await plugin.runAction("retry")
    expect(plugin.status()?.code).toBe("ready")
  })
})

describe("partially entitled", () => {
  test("mirrors whatever subset tools/list returns, and notes a shrunken list", async () => {
    const server = fake()
    server.tools = [SAMPLE_TOOLS[2]]
    const plugin = await load(server, new FakeTokenProvider(ADA))
    await waitFor(() => plugin.status()?.code === "ready")
    expect(plugin.tools().map((tool) => tool.name)).toEqual(["search_paths"])
    expect(plugin.status()?.facts).toContainEqual({
      label: "Tools",
      value: "1",
    })

    server.tools = SAMPLE_TOOLS
    await plugin.runAction("retry")
    expect(plugin.tools()).toHaveLength(3)
    server.tools = SAMPLE_TOOLS.slice(0, 2)
    await plugin.runAction("retry")
    expect(plugin.tools()).toHaveLength(2)
    expect(plugin.status()?.facts).toContainEqual({
      label: "Tools",
      value: "2 (some may be restricted by your organization)",
    })
  })

  test("a 403 on one call is that call's error; the connector stays ready", async () => {
    const server = fake()
    const plugin = await load(server, new FakeTokenProvider(ADA))
    await waitFor(() => plugin.status()?.code === "ready")
    server.fail({
      status: 403,
      rpc: "tools/call",
      body: '{"error":{"code":"Forbidden","message":"Access denied by policy"}}',
    })
    const denied = await plugin.callTool("fetch", { entityUrls: ["/me/x"] })
    expect(denied).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Your organization's Example policy doesn't allow this request.",
        },
      ],
    })
    expect(plugin.status()?.code).toBe("ready")
    expect(plugin.tools()).toHaveLength(3)

    // An upstream `isError` result (path-level denial) passes through untouched.
    server.results = {
      fetch: {
        isError: true,
        content: [{ type: "text", text: "Access denied for GET path" }],
      },
    }
    expect(await plugin.callTool("fetch", { entityUrls: ["/x"] })).toEqual({
      isError: true,
      content: [{ type: "text", text: "Access denied for GET path" }],
    })
    expect(plugin.status()?.code).toBe("ready")
  })
})

describe("entitlement changes over time", () => {
  test("a call refused after a token refresh re-checks the tool list", async () => {
    const server = fake()
    const tokens = new FakeTokenProvider(ADA)
    tokens.refreshable = true
    const plugin = await load(server, tokens)
    await waitFor(() => plugin.status()?.code === "ready")

    // The admin turns the service off for this account.
    server.token = "nobody"
    const result = await plugin.callTool("search_paths", {})
    expect(result.isError).toBe(true)
    await waitFor(() => plugin.status()?.state === "error")
    expect(plugin.status()?.detail).toContain("not-entitled (HTTP 401)")
    expect(plugin.tools()).toEqual([])

    // …and back on.
    server.token = "token-1"
    await plugin.runAction("retry")
    expect(plugin.status()?.code).toBe("ready")
    expect(plugin.tools()).toHaveLength(3)
  })
})
