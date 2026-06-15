/**
 * /settings/api/gh/* — read-only hinting + adopt-a-gh-account flow.
 *
 * Previously uncovered: `src/routes/settings/gh.ts` was at 0% function
 * coverage despite being the route the shell calls every time the user
 * clicks "Use this gh account" in the Account section. The shell-side
 * behaviors (showGhError, useGhAccount in shell/src/main.ts) depend on
 * the specific status codes + error shapes this route emits.
 *
 * `gh-cli` (the binary wrapper) is mocked via injectable `__set*ForTests`-
 * style overrides — we mock.module here for the gh-cli service and for
 * the preflight helper so the route can be exercised end-to-end without
 * spawning gh or hitting GitHub.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

// --- Mocks before importing the route ------------------------------------

interface GhCliStatus {
  installed: boolean
  version: string | null
  accounts: Array<{
    login: string
    host: string
    active: boolean
    scopes: Array<string>
  }>
}

const ghMocks = {
  detectGhCli: (): Promise<GhCliStatus> =>
    Promise.resolve({ installed: false, version: null, accounts: [] }),
  getGhAccountToken: (_login: string, _host: string): Promise<string | null> =>
    Promise.resolve(null),
}
const preflightMock = {
  preflightCopilotError: (
    _token: string,
    _login: string,
  ): Promise<string | null> => Promise.resolve(null),
}
const storeMock = {
  addAccountCalls: [] as Array<{ login: string; host: string; token: string }>,
}

const realGhCli = await import("~/services/gh-cli")
const realPreflight = await import("~/lib/copilot-preflight")
const realStore = await import("~/lib/github-token-store")

void mock.module("~/services/gh-cli", () => ({
  ...realGhCli,
  detectGhCli: () => ghMocks.detectGhCli(),
  getGhAccountToken: (login: string, host: string) =>
    ghMocks.getGhAccountToken(login, host),
}))

void mock.module("~/lib/copilot-preflight", () => ({
  ...realPreflight,
  preflightCopilotError: (token: string, login: string) =>
    preflightMock.preflightCopilotError(token, login),
}))

void mock.module("~/lib/github-token-store", () => ({
  ...realStore,
  addAccountToDefaultRegistry: (rec: {
    login: string
    host: string
    token: string
  }) => {
    storeMock.addAccountCalls.push({
      login: rec.login,
      host: rec.host,
      token: rec.token,
    })
    return Promise.resolve()
  },
}))

afterAll(() => {
  void mock.module("~/services/gh-cli", () => realGhCli)
  void mock.module("~/lib/copilot-preflight", () => realPreflight)
  void mock.module("~/lib/github-token-store", () => realStore)
})

const { createAuthMiddleware } = await import("~/lib/request-auth")
const { settingsApiRoutes } = await import("~/routes/settings/api")

function buildApp() {
  const app = new Hono()
  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => [],
      isEnforcing: () => false,
      allowUnauthenticatedPaths: ["/", "/usage-viewer"],
    }),
  )
  app.route("/settings/api", settingsApiRoutes)
  return app
}

beforeEach(() => {
  ghMocks.detectGhCli = () =>
    Promise.resolve({ installed: false, version: null, accounts: [] })
  ghMocks.getGhAccountToken = () => Promise.resolve(null)
  preflightMock.preflightCopilotError = () => Promise.resolve(null)
  storeMock.addAccountCalls = []
})

// --- GET /status ---------------------------------------------------------

describe("GET /settings/api/gh/status", () => {
  test("returns gh-not-installed payload as-is", async () => {
    const app = buildApp()
    const res = await app.request("/settings/api/gh/status")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      installed: false,
      version: null,
      accounts: [],
    })
  })

  test("returns the detected accounts list", async () => {
    ghMocks.detectGhCli = () =>
      Promise.resolve({
        installed: true,
        version: "2.50.0",
        accounts: [
          {
            login: "alice",
            host: "github.com",
            active: true,
            scopes: ["repo", "read:org"],
          },
        ],
      })
    const app = buildApp()
    const res = await app.request("/settings/api/gh/status")
    expect(res.status).toBe(200)
    const body = (await res.json()) as GhCliStatus
    expect(body.installed).toBe(true)
    expect(body.accounts).toHaveLength(1)
    expect(body.accounts[0].login).toBe("alice")
  })
})

// --- POST /use validation branches --------------------------------------

describe("POST /settings/api/gh/use — input validation", () => {
  test("rejects missing body with 400", async () => {
    const app = buildApp()
    const res = await app.request("/settings/api/gh/use", { method: "POST" })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/login.*host/i)
  })

  test("rejects empty login with 400", async () => {
    const app = buildApp()
    const res = await app.request("/settings/api/gh/use", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "", host: "github.com" }),
    })
    expect(res.status).toBe(400)
  })

  test("rejects empty host with 400", async () => {
    const app = buildApp()
    const res = await app.request("/settings/api/gh/use", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "alice", host: "" }),
    })
    expect(res.status).toBe(400)
  })
})

// --- POST /use security: requested account must be one gh actually reports

describe("POST /settings/api/gh/use — must be a known gh account", () => {
  test("returns 404 when login is not in gh's account list", async () => {
    ghMocks.detectGhCli = () =>
      Promise.resolve({
        installed: true,
        version: "2.50.0",
        accounts: [
          {
            login: "alice",
            host: "github.com",
            active: true,
            scopes: [],
          },
        ],
      })
    const app = buildApp()
    const res = await app.request("/settings/api/gh/use", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "bob", host: "github.com" }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/no account/i)
    // Invariant: a 404 must NOT persist anything to the registry.
    expect(storeMock.addAccountCalls.length).toBe(0)
  })

  test("returns 404 when host doesn't match", async () => {
    ghMocks.detectGhCli = () =>
      Promise.resolve({
        installed: true,
        version: "2.50.0",
        accounts: [
          {
            login: "alice",
            host: "github.com",
            active: true,
            scopes: [],
          },
        ],
      })
    const app = buildApp()
    const res = await app.request("/settings/api/gh/use", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "alice", host: "ghe.example.com" }),
    })
    expect(res.status).toBe(404)
    expect(storeMock.addAccountCalls.length).toBe(0)
  })
})

// --- POST /use failure modes --------------------------------------------

function configureKnownAlice(): void {
  ghMocks.detectGhCli = () =>
    Promise.resolve({
      installed: true,
      version: "2.50.0",
      accounts: [
        {
          login: "alice",
          host: "github.com",
          active: true,
          scopes: [],
        },
      ],
    })
}

describe("POST /settings/api/gh/use — failure modes", () => {
  test("returns 502 when gh reports the account but the token read fails", async () => {
    configureKnownAlice()
    ghMocks.getGhAccountToken = () => Promise.resolve(null)
    const app = buildApp()
    const res = await app.request("/settings/api/gh/use", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "alice", host: "github.com" }),
    })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/could not read.*token/i)
    // Invariant: a 502 must NOT persist anything.
    expect(storeMock.addAccountCalls.length).toBe(0)
  })

  test("returns 422 with the specific preflight message when Copilot rejects the gh token", async () => {
    configureKnownAlice()
    ghMocks.getGhAccountToken = () => Promise.resolve("gho_stale")
    preflightMock.preflightCopilotError = () =>
      Promise.resolve("Token expired or revoked for alice.")
    const app = buildApp()
    const res = await app.request("/settings/api/gh/use", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "alice", host: "github.com" }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe("Token expired or revoked for alice.")
    // Invariant: a preflight failure must NOT persist a stale token.
    expect(storeMock.addAccountCalls.length).toBe(0)
  })
})

// --- POST /use happy path -----------------------------------------------

describe("POST /settings/api/gh/use — success path", () => {
  test("returns { ok: true, login, host } and persists exactly one account", async () => {
    ghMocks.detectGhCli = () =>
      Promise.resolve({
        installed: true,
        version: "2.50.0",
        accounts: [
          {
            login: "alice",
            host: "github.com",
            active: true,
            scopes: ["repo"],
          },
        ],
      })
    ghMocks.getGhAccountToken = () => Promise.resolve("gho_real")
    preflightMock.preflightCopilotError = () => Promise.resolve(null)

    const app = buildApp()
    const res = await app.request("/settings/api/gh/use", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "alice", host: "github.com" }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      login: "alice",
      host: "github.com",
    })

    // Invariant: exactly the requested account was persisted, with the
    // token gh handed us (not the request body, which carries no token).
    expect(storeMock.addAccountCalls).toEqual([
      { login: "alice", host: "github.com", token: "gho_real" },
    ])
  })
})
