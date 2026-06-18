/**
 * Contract / invariant tests for the auth controller's wire format.
 *
 * These complement the per-scenario tests in auth-controller.test.ts.
 * Where those assert "in scenario X, the field has value Y", these
 * assert system-wide properties that must hold across ALL paths:
 *
 *   1. Every getAuthStatus() output round-trips through AuthStatus.safeParse.
 *      The wire-format zod schema is the contract; if the projection
 *      from the internal union produces a value the schema rejects,
 *      the schema and the projection have drifted.
 *
 *   2. The persisted account registry never contains a row with
 *      login === "unknown" or login === "". A "we have a token but
 *      don't know who it belongs to" state is an error, not an
 *      account. This is the property that would have caught the
 *      ADR-0006 carve-out immediately.
 *
 *   3. After signOut(), all in-memory token state is cleared and
 *      getAuthStatus() reports a state that doesn't carry account_login.
 *
 * These run after auth-controller.test.ts in the same file ordering so
 * they share the mock harness; if a future refactor moves them apart,
 * recreate the harness here.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { AccountRecord } from "~/lib/github-token-store"

import { AuthStatus } from "~/lib/settings-types"

// --- Shared harness (mirrors auth-controller.test.ts) ---------------------
// Kept inline rather than extracted so the leakage profile is obvious in
// one file — see docs/architecture.md § Testing gotchas on mock.module.

const harness = {
  pollAccessTokenImpl: (): Promise<string> => Promise.resolve("ghu_default"),
  getGitHubUserImpl: (): Promise<{ login: string }> =>
    Promise.resolve({ login: "octocat" }),
  addAccountCalls: [] as Array<AccountRecord>,
}

const realGetDeviceCodeModule =
  await import("~/services/github/get-device-code")
const realGetUserModule = await import("~/services/github/get-user")
const realTokenModule = await import("~/lib/token")

void mock.module("~/services/github/get-device-code", () => ({
  getDeviceCode: () =>
    Promise.resolve({
      device_code: "device-xyz",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    }),
}))

void mock.module("~/services/github/get-user", () => ({
  getGitHubUser: () => harness.getGitHubUserImpl(),
}))

void mock.module("~/lib/token", () => ({
  ...realTokenModule,
  setupCopilotToken: () => Promise.resolve(),
}))

afterAll(() => {
  void mock.module(
    "~/services/github/get-device-code",
    () => realGetDeviceCodeModule,
  )
  void mock.module("~/services/github/get-user", () => realGetUserModule)
  void mock.module("~/lib/token", () => realTokenModule)
})

const {
  getAuthStatus,
  signOut,
  startDeviceFlow,
  markSignedIn,
  markAuthDegraded,
  __resetAuthControllerForTests,
  __setAuthControllerDepsForTests,
} = await import("~/lib/auth-controller")
const { CopilotAuthFatalError } = await import("~/lib/error")
const { state } = await import("~/lib/state")

async function flushMicrotasks(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  __resetAuthControllerForTests()
  __setAuthControllerDepsForTests({
    pollAccessToken: () => harness.pollAccessTokenImpl(),
    addAccount: (rec: AccountRecord) => {
      harness.addAccountCalls.push(rec)
      return Promise.resolve()
    },
    deactivateActiveAccount: () => Promise.resolve(),
    markActiveNeedsReauth: () => Promise.resolve(),
  })
  state.githubToken = undefined
  state.copilotToken = undefined
  state.userName = undefined
  state.lastUpstreamRejection = undefined
  harness.addAccountCalls = []
  harness.pollAccessTokenImpl = () => Promise.resolve("ghu_default")
  harness.getGitHubUserImpl = () => Promise.resolve({ login: "octocat" })
})

afterEach(() => {
  __resetAuthControllerForTests()
  state.githubToken = undefined
  state.copilotToken = undefined
  state.userName = undefined
  state.lastUpstreamRejection = undefined
})

// --- Invariant 1: wire-format schema round-trip --------------------------

describe("AuthStatus wire-format invariant", () => {
  test("every observable controller state parses as a valid AuthStatus", async () => {
    // Drive each reachable internal state in turn; after each, project to
    // the wire and assert the schema accepts it. If the controller adds a
    // new internal variant later, that branch's wire output is forced
    // through the same gate the next time someone touches this test.
    const states: Array<{ label: string; drive: () => Promise<void> }> = [
      {
        label: "signed-out (initial)",
        drive: () => Promise.resolve(),
      },
      {
        label: "device-issued",
        drive: async () => {
          // Park pollAccessToken so we observe device-issued before polling.
          harness.pollAccessTokenImpl = () => new Promise<string>(() => {})
          await startDeviceFlow()
        },
      },
      {
        label: "authenticated (real login resolved)",
        drive: async () => {
          harness.pollAccessTokenImpl = () => Promise.resolve("ghu_alice")
          harness.getGitHubUserImpl = () => Promise.resolve({ login: "alice" })
          await startDeviceFlow()
          await flushMicrotasks()
        },
      },
      {
        label: "error (poll rejected)",
        drive: async () => {
          harness.pollAccessTokenImpl = () =>
            Promise.reject(new Error("access_denied"))
          await startDeviceFlow()
          await flushMicrotasks()
        },
      },
      {
        label: "error (getGitHubUser failed — unverifiable sign-in)",
        drive: async () => {
          harness.pollAccessTokenImpl = () => Promise.resolve("ghu_no_user")
          harness.getGitHubUserImpl = () =>
            Promise.reject(new Error("403 user"))
          await startDeviceFlow()
          await flushMicrotasks()
        },
      },
      {
        label: "error (Copilot fatal)",
        drive: async () => {
          await markAuthDegraded(
            new CopilotAuthFatalError(
              "revoked",
              403,
              "https://github.com/settings/copilot",
            ),
          )
        },
      },
      {
        label: "authenticated via markSignedIn (cold boot path)",
        drive: () => {
          markSignedIn("bob")
          return Promise.resolve()
        },
      },
    ]

    for (const { label, drive } of states) {
      __resetAuthControllerForTests()
      state.githubToken = undefined
      state.copilotToken = undefined
      state.userName = undefined
      state.lastUpstreamRejection = undefined
      harness.addAccountCalls = []
      await drive()
      const status = getAuthStatus()
      const parsed = AuthStatus.safeParse(status)
      if (!parsed.success) {
        throw new Error(
          `[${label}] getAuthStatus produced an invalid AuthStatus: `
            + `${JSON.stringify(status)} — ${parsed.error.message}`,
        )
      }
      expect(parsed.success).toBe(true)
    }
  })
})

// --- Invariant 2: persisted registry has no "unknown" identities ---------

describe("Account registry invariant (no unverified identities)", () => {
  test("getGitHubUser failure during device flow never persists an account", async () => {
    harness.pollAccessTokenImpl = () => Promise.resolve("ghu_no_user_lookup")
    harness.getGitHubUserImpl = () => Promise.reject(new Error("403 user"))

    await startDeviceFlow()
    await flushMicrotasks()

    // The would-have-been-buggy ADR-0006 carve-out persisted with
    // login="unknown" here. The correct behavior is zero persistence.
    expect(harness.addAccountCalls.length).toBe(0)
  })

  test("no persistence path produces a row with login='unknown' or empty", async () => {
    // Exercise every code path that calls addAccount; assert the postcondition
    // on the recorded payloads. If a new sign-in path is added later, add it
    // to this list so the invariant covers it.
    const drives: Array<() => Promise<void>> = [
      async () => {
        // Happy path device flow.
        harness.pollAccessTokenImpl = () => Promise.resolve("ghu_alice")
        harness.getGitHubUserImpl = () => Promise.resolve({ login: "alice" })
        await startDeviceFlow()
        await flushMicrotasks()
      },
      async () => {
        // Device flow with a getGitHubUser failure — must not persist.
        harness.pollAccessTokenImpl = () => Promise.resolve("ghu_nouser")
        harness.getGitHubUserImpl = () => Promise.reject(new Error("network"))
        await startDeviceFlow()
        await flushMicrotasks()
      },
    ]

    for (const drive of drives) {
      __resetAuthControllerForTests()
      state.githubToken = undefined
      state.userName = undefined
      harness.addAccountCalls = []
      await drive()

      for (const row of harness.addAccountCalls) {
        expect(row.login).not.toBe("unknown")
        expect(row.login).not.toBe("")
        expect(row.login.length).toBeGreaterThan(0)
      }
    }
  })
})

// --- Invariant 3: signOut clears everything ------------------------------

describe("signOut clears all in-memory token state (invariant)", () => {
  test("after signOut, the relevant state.* fields are all undefined and getAuthStatus carries no identity", async () => {
    harness.pollAccessTokenImpl = () => Promise.resolve("ghu_alice")
    harness.getGitHubUserImpl = () => Promise.resolve({ login: "alice" })
    await startDeviceFlow()
    await flushMicrotasks()

    // Seed an upstream rejection so we can prove signOut clears it too.
    state.lastUpstreamRejection = {
      message: "quota",
      remediationUrl: null,
      status: 402,
      at: new Date().toISOString(),
    }

    await signOut()

    expect(state.githubToken).toBeUndefined()
    expect(state.copilotToken).toBeUndefined()
    expect(state.userName).toBeUndefined()
    expect(state.lastUpstreamRejection).toBeUndefined()

    const status = getAuthStatus()
    // Whatever state we land in, it must not carry an account_login field.
    // (The authenticated variant is the only one that does, and we've
    // signed out — getting there would be a bug.)
    expect(status).not.toHaveProperty("account_login")
    expect(status.state).not.toBe("authenticated")
  })
})
