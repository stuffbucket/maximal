/**
 * Route tests for /settings/api/accounts/* (list / switch / remove).
 *
 * The registry storage boundary (`readDefaultRegistry`/`writeDefaultRegistry`)
 * and the Copilot pre-flight (`preflightCopilotError`) are mocked to in-memory
 * values so the routes are exercised without touching disk or the network.
 * Following api-keys-route.test.ts: spread the real modules so process-wide
 * `mock.module` doesn't strip helpers a sibling test file imports.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { AccountRegistry } from "~/lib/auth/github-token-store"

import { HTTPError } from "~/lib/errors/error"

const actualStore = await import("~/lib/auth/github-token-store")

let fakeRegistry: AccountRegistry
// Drives the switch route's pre-flight: getCopilotUsage either resolves (token
// usable) or throws an HTTPError (mirrors the real Copilot rejection). We mock
// this leaf — NOT the whole gh module — so the REAL preflightCopilotError runs
// and gh-preflight.test.ts's coverage of it isn't clobbered.
let usageImpl: (token: string) => Promise<unknown>

await mock.module("~/lib/auth/github-token-store", () => ({
  ...actualStore,
  readDefaultRegistry: () => Promise.resolve(fakeRegistry),
  writeDefaultRegistry: (reg: AccountRegistry) => {
    fakeRegistry = reg
    return Promise.resolve()
  },
}))

const actualUsage = await import("~/services/github/get-copilot-usage")

await mock.module("~/services/github/get-copilot-usage", () => ({
  ...actualUsage,
  getCopilotUsage: (token: string) => usageImpl(token),
}))

const { accountsRoutes } = await import("~/routes/settings/accounts")
const { addAndActivate, emptyRegistry, makeAccountRecord } = actualStore

afterAll(async () => {
  await mock.module("~/lib/auth/github-token-store", () => actualStore)
  await mock.module("~/services/github/get-copilot-usage", () => actualUsage)
})

/** An HTTPError carrying the given status, for driving the pre-flight. */
function httpError(status: number): HTTPError {
  return new HTTPError("upstream", new Response(null, { status }))
}

function makeApp(): Hono {
  const app = new Hono()
  app.route("/accounts", accountsRoutes)
  return app
}

const postJson = (path: string, body: unknown) =>
  makeApp().request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

function seedTwoAccounts(): void {
  // alice (gh-cli), then bob (device-code, active)
  let reg = addAndActivate(
    emptyRegistry(),
    makeAccountRecord({
      login: "alice",
      host: "github.com",
      token: "ghu_alice",
      addedVia: "gh-cli",
    }),
  )
  reg = addAndActivate(
    reg,
    makeAccountRecord({
      login: "bob",
      host: "github.com",
      token: "ghu_bob",
      addedVia: "device-code",
    }),
  )
  fakeRegistry = reg
}

beforeEach(() => {
  fakeRegistry = emptyRegistry()
  // Default: the token is usable (pre-flight passes).
  usageImpl = () => Promise.resolve({})
})

describe("GET /accounts", () => {
  test("lists accounts with active flag and never returns tokens", async () => {
    seedTwoAccounts()
    const res = await makeApp().request("/accounts")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      accounts: Array<Record<string, unknown>>
      active_key: string | null
    }
    expect(body.active_key).toBe("bob@github.com")
    expect(body.accounts).toHaveLength(2)
    const bob = body.accounts.find((a) => a.login === "bob")
    expect(bob).toMatchObject({
      key: "bob@github.com",
      host: "github.com",
      added_via: "device-code",
      active: true,
    })
    expect(body.accounts.find((a) => a.login === "alice")?.active).toBe(false)
    // No token leaks into the response.
    for (const a of body.accounts) {
      expect(a.token).toBeUndefined()
    }
  })

  test("empty registry → empty list, null active", async () => {
    const res = await makeApp().request("/accounts")
    const body = (await res.json()) as {
      accounts: Array<unknown>
      active_key: null
    }
    expect(body.accounts).toEqual([])
    expect(body.active_key).toBeNull()
  })
})

describe("POST /accounts/switch", () => {
  test("400 on a missing/blank key", async () => {
    expect((await postJson("/accounts/switch", {})).status).toBe(400)
    expect((await postJson("/accounts/switch", { key: "" })).status).toBe(400)
  })

  test("404 on an unknown key", async () => {
    seedTwoAccounts()
    const res = await postJson("/accounts/switch", { key: "ghost@github.com" })
    expect(res.status).toBe(404)
  })

  test("422 when the pre-flight rejects the target token", async () => {
    seedTwoAccounts()
    usageImpl = () => Promise.reject(httpError(403)) // no Copilot subscription
    const res = await postJson("/accounts/switch", { key: "alice@github.com" })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain("Copilot")
    // Active pointer unchanged on failure.
    expect(fakeRegistry.activeKey).toBe("bob@github.com")
  })

  test("200 sets the active account when pre-flight passes", async () => {
    seedTwoAccounts()
    usageImpl = () => Promise.resolve({}) // token usable
    const res = await postJson("/accounts/switch", { key: "alice@github.com" })
    expect(res.status).toBe(200)
    expect(fakeRegistry.activeKey).toBe("alice@github.com")
  })
})

describe("POST /accounts/remove", () => {
  test("400 on a missing key", async () => {
    expect((await postJson("/accounts/remove", {})).status).toBe(400)
  })

  test("404 on an unknown key", async () => {
    seedTwoAccounts()
    const res = await postJson("/accounts/remove", { key: "ghost@github.com" })
    expect(res.status).toBe(404)
  })

  test("removes a non-active account, keeps the active pointer", async () => {
    seedTwoAccounts()
    const res = await postJson("/accounts/remove", { key: "alice@github.com" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { was_active: boolean }
    expect(body.was_active).toBe(false)
    expect("alice@github.com" in fakeRegistry.accounts).toBe(false)
    expect(fakeRegistry.activeKey).toBe("bob@github.com")
  })

  test("removing the active account clears activeKey", async () => {
    seedTwoAccounts()
    const res = await postJson("/accounts/remove", { key: "bob@github.com" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { was_active: boolean }
    expect(body.was_active).toBe(true)
    expect(fakeRegistry.activeKey).toBeNull()
  })
})
