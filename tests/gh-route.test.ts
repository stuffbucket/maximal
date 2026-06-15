/**
 * /settings/api/gh/* — read-only hinting + adopt-a-gh-account flow.
 *
 * Previously uncovered: `src/routes/settings/gh.ts` was at 0% function
 * coverage. The shell's "Use this gh account" affordance depends on this
 * route's specific status codes + error shapes.
 *
 * Implementation uses DI via `createGhRoutes(deps)` (NOT mock.module —
 * see docs/decisions/0011-mock-module-leakage-discipline.md and
 * docs/architecture.md § Testing gotchas). Each test constructs its own
 * routes instance with in-process stubs, so nothing leaks to sibling
 * test files that import the real ~/services/gh-cli or
 * ~/lib/copilot-preflight modules.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { GhRoutesDeps } from "~/routes/settings/gh"
import type { GhCliStatus } from "~/services/gh-cli"

import { createGhRoutes } from "~/routes/settings/gh"

interface AddAccountSpy {
  calls: Array<{ login: string; host: string; token: string }>
}

function buildDeps(overrides: Partial<GhRoutesDeps> = {}): {
  deps: Partial<GhRoutesDeps>
  addAccountSpy: AddAccountSpy
} {
  const addAccountSpy: AddAccountSpy = { calls: [] }
  const deps: Partial<GhRoutesDeps> = {
    detectGhCli: () =>
      Promise.resolve({ installed: false, version: null, accounts: [] }),
    getGhAccountToken: () => Promise.resolve(null),
    preflightCopilotError: () => Promise.resolve(null),
    addAccountToDefaultRegistry: (rec) => {
      addAccountSpy.calls.push({
        login: rec.login,
        host: rec.host,
        token: rec.token,
      })
      return Promise.resolve()
    },
    ...overrides,
  }
  return { deps, addAccountSpy }
}

function mountAt(deps: Partial<GhRoutesDeps>): Hono {
  const app = new Hono()
  app.route("/settings/api/gh", createGhRoutes(deps))
  return app
}

let addAccountSpy: AddAccountSpy
beforeEach(() => {
  addAccountSpy = { calls: [] }
})

// --- GET /status ---------------------------------------------------------

describe("GET /settings/api/gh/status", () => {
  test("returns gh-not-installed payload as-is", async () => {
    const { deps } = buildDeps()
    const app = mountAt(deps)
    const res = await app.request("/settings/api/gh/status")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      installed: false,
      version: null,
      accounts: [],
    })
  })

  test("returns the detected accounts list", async () => {
    const status: GhCliStatus = {
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
    }
    const { deps } = buildDeps({ detectGhCli: () => Promise.resolve(status) })
    const app = mountAt(deps)
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
    const { deps } = buildDeps()
    const app = mountAt(deps)
    const res = await app.request("/settings/api/gh/use", { method: "POST" })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/login.*host/i)
  })

  test("rejects empty login with 400", async () => {
    const { deps } = buildDeps()
    const app = mountAt(deps)
    const res = await app.request("/settings/api/gh/use", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "", host: "github.com" }),
    })
    expect(res.status).toBe(400)
  })

  test("rejects empty host with 400", async () => {
    const { deps } = buildDeps()
    const app = mountAt(deps)
    const res = await app.request("/settings/api/gh/use", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "alice", host: "" }),
    })
    expect(res.status).toBe(400)
  })
})

// --- POST /use security: requested account must be one gh actually reports

function aliceOnGithubCom(): GhCliStatus {
  return {
    installed: true,
    version: "2.50.0",
    accounts: [
      { login: "alice", host: "github.com", active: true, scopes: [] },
    ],
  }
}

describe("POST /settings/api/gh/use — must be a known gh account", () => {
  test("returns 404 when login is not in gh's account list", async () => {
    const built = buildDeps({
      detectGhCli: () => Promise.resolve(aliceOnGithubCom()),
    })
    addAccountSpy = built.addAccountSpy
    const app = mountAt(built.deps)
    const res = await app.request("/settings/api/gh/use", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "bob", host: "github.com" }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/no account/i)
    // Invariant: a 404 must NOT persist anything to the registry.
    expect(addAccountSpy.calls.length).toBe(0)
  })

  test("returns 404 when host doesn't match", async () => {
    const built = buildDeps({
      detectGhCli: () => Promise.resolve(aliceOnGithubCom()),
    })
    addAccountSpy = built.addAccountSpy
    const app = mountAt(built.deps)
    const res = await app.request("/settings/api/gh/use", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "alice", host: "ghe.example.com" }),
    })
    expect(res.status).toBe(404)
    expect(addAccountSpy.calls.length).toBe(0)
  })
})

// --- POST /use failure modes --------------------------------------------

function aliceKnown(): GhCliStatus {
  return {
    installed: true,
    version: "2.50.0",
    accounts: [
      { login: "alice", host: "github.com", active: true, scopes: [] },
    ],
  }
}

describe("POST /settings/api/gh/use — failure modes", () => {
  test("returns 502 when gh reports the account but the token read fails", async () => {
    const built = buildDeps({
      detectGhCli: () => Promise.resolve(aliceKnown()),
      getGhAccountToken: () => Promise.resolve(null),
    })
    addAccountSpy = built.addAccountSpy
    const app = mountAt(built.deps)
    const res = await app.request("/settings/api/gh/use", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "alice", host: "github.com" }),
    })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/could not read.*token/i)
    // Invariant: a 502 must NOT persist anything.
    expect(addAccountSpy.calls.length).toBe(0)
  })

  test("returns 422 with the specific preflight message when Copilot rejects the gh token", async () => {
    const built = buildDeps({
      detectGhCli: () => Promise.resolve(aliceKnown()),
      getGhAccountToken: () => Promise.resolve("gho_stale"),
      preflightCopilotError: () =>
        Promise.resolve("Token expired or revoked for alice."),
    })
    addAccountSpy = built.addAccountSpy
    const app = mountAt(built.deps)
    const res = await app.request("/settings/api/gh/use", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "alice", host: "github.com" }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe("Token expired or revoked for alice.")
    // Invariant: a preflight failure must NOT persist a stale token.
    expect(addAccountSpy.calls.length).toBe(0)
  })
})

// --- POST /use happy path -----------------------------------------------

describe("POST /settings/api/gh/use — success path", () => {
  test("returns { ok: true, login, host } and persists exactly one account", async () => {
    const built = buildDeps({
      detectGhCli: () => Promise.resolve(aliceKnown()),
      getGhAccountToken: () => Promise.resolve("gho_real"),
      preflightCopilotError: () => Promise.resolve(null),
    })
    addAccountSpy = built.addAccountSpy
    const app = mountAt(built.deps)
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
    // token gh handed us.
    expect(addAccountSpy.calls).toEqual([
      { login: "alice", host: "github.com", token: "gho_real" },
    ])
  })
})
