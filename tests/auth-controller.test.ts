/**
 * Direct unit tests against src/lib/auth-controller.ts to cover the
 * polling state machine and cleanup paths that the higher-level
 * settings-api route tests can't reach. All upstream device-flow calls,
 * GitHub user lookups, and on-disk token writes are mocked.
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

import type { AccountRecord } from "~/lib/auth/github-token-store"

import { stopCopilotOnlineRetry } from "~/lib/auth/copilot-online-retry"

import {
  deferred,
  flushMicrotasks,
  spyConsola,
} from "./helpers/auth-flow-utils"
import {
  assertAuthenticated,
  assertError,
  assertPending,
} from "./helpers/auth-status"

// --- Mock harness ----------------------------------------------------------

// Mutable hooks the tests reassign before each scenario.
const harness = {
  getDeviceCodeImpl: () =>
    Promise.resolve({
      device_code: "device-xyz",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    }),
  pollAccessTokenImpl: (): Promise<string> => new Promise<string>(() => {}),
  pollAccessTokenCalls: 0,
  getGitHubUserImpl: (): Promise<{ login: string }> =>
    Promise.resolve({ login: "octocat" }),
  addAccountImpl: (_: AccountRecord): Promise<void> => Promise.resolve(),
  unlinkImpl: (_p: string): Promise<void> => Promise.resolve(),
  unlinkCalls: [] as Array<string>,
  addAccountCalls: [] as Array<AccountRecord>,
  setupCopilotTokenImpl: (): Promise<void> => Promise.resolve(),
  setupCopilotTokenCalls: 0,
  cacheModelsImpl: (): Promise<void> => Promise.resolve(),
  cacheModelsCalls: 0,
  deactivateCalls: 0,
  markNeedsReauthCalls: [] as Array<{
    status: number | null
    message: string
    at: string
  }>,
}

// Capture real modules BEFORE mocking so `afterAll` can restore them.
// Bun's `mock.module` is process-wide and persists across test files;
// without the restore, a different test file that imports these modules
// later in the same `bun test` process gets our stubs. Some modules
// (poll-access-token, github-token-store) have their own dedicated test
// files — those go through __setAuthControllerDepsForTests instead of
// mock.module so the registry stays clean.
const realGetDeviceCodeModule =
  await import("~/services/github/get-device-code")
const realGetUserModule = await import("~/services/github/get-user")
const realTokenModule = await import("~/lib/auth/token")
const realUtilsModule = await import("~/lib/platform/utils")
const realFsPromisesModule = await import("node:fs/promises")

await mock.module("~/services/github/get-device-code", () => ({
  getDeviceCode: () => harness.getDeviceCodeImpl(),
}))

await mock.module("~/services/github/get-user", () => ({
  getGitHubUser: (_token?: string) => harness.getGitHubUserImpl(),
}))

await mock.module("~/lib/auth/token", () => ({
  // Spread the real module so the ~9 exports this test doesn't override
  // (setupGitHubToken, logUser, GITHUB_TOKEN_PATH, getRefreshDeadlineMs, …)
  // stay intact for sibling files while the mock is active — not only after
  // the afterAll restore. See ADR-0011 (forwarding faithfulness).
  ...realTokenModule,
  setupCopilotToken: () => {
    harness.setupCopilotTokenCalls++
    return harness.setupCopilotTokenImpl()
  },
  // markAuthDegraded calls this to halt the refresh loop; no-op in unit tests.
  stopCopilotRefreshLoop: () => {},
}))

// Spread the real namespace so the many OTHER utils exports (getUUID,
// parseUserIdMetadata, sleep, …) survive; only count/stub cacheModels so
// the sign-in success path doesn't make a real Copilot /models fetch.
await mock.module("~/lib/platform/utils", () => ({
  ...realUtilsModule,
  cacheModels: () => {
    harness.cacheModelsCalls++
    return harness.cacheModelsImpl()
  },
}))

// Spread the real namespace so `readFile` / `writeFile` / etc. survive
// the override — `tests/github-token-store.test.ts` reads/writes via
// the same module and gets undefined functions otherwise.
await mock.module("node:fs/promises", () => ({
  ...realFsPromisesModule,
  default: {
    ...(realFsPromisesModule as { default: object }).default,
    unlink: (p: string) => {
      harness.unlinkCalls.push(p)
      return harness.unlinkImpl(p)
    },
  },
  unlink: (p: string) => {
    harness.unlinkCalls.push(p)
    return harness.unlinkImpl(p)
  },
}))

afterAll(async () => {
  await mock.module(
    "~/services/github/get-device-code",
    () => realGetDeviceCodeModule,
  )
  await mock.module("~/services/github/get-user", () => realGetUserModule)
  await mock.module("~/lib/auth/token", () => realTokenModule)
  await mock.module("~/lib/platform/utils", () => realUtilsModule)
  await mock.module("node:fs/promises", () => realFsPromisesModule)
})

const {
  startDeviceFlow,
  getAuthStatus,
  signOut,
  markSignedIn,
  markAuthDegraded,
  rearmCopilotAuth,
  __resetAuthControllerForTests,
  __setAuthControllerDepsForTests,
} = await import("~/lib/auth/auth-controller")
const { CopilotAuthFatalError, forwardError } =
  await import("~/lib/errors/error")
const { state } = await import("~/lib/runtime-state/state")

beforeEach(() => {
  __resetAuthControllerForTests()
  __setAuthControllerDepsForTests({
    pollAccessToken: (_dc: unknown) => {
      harness.pollAccessTokenCalls++
      return harness.pollAccessTokenImpl().then((accessToken) => ({
        accessToken,
        refreshToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
      }))
    },
    addAccount: (rec: AccountRecord) => {
      harness.addAccountCalls.push(rec)
      return harness.addAccountImpl(rec)
    },
    // No-ops so signOut / markAuthDegraded don't touch the real on-disk
    // registry in unit tests (and resolve within the flushed microtask window).
    deactivateActiveAccount: () => {
      harness.deactivateCalls++
      return Promise.resolve()
    },
    markActiveNeedsReauth: (err) => {
      harness.markNeedsReauthCalls.push(err)
      return Promise.resolve()
    },
  })
  state.githubToken = undefined
  state.copilotToken = undefined
  state.userName = undefined
  // getAuthStatus() folds in state.lastUpstreamRejection; a sibling test file
  // that set it (and didn't clear) would otherwise leak into the exact-shape
  // status assertions here. Reset it so these tests are order-independent.
  state.lastUpstreamRejection = undefined
  harness.getDeviceCodeImpl = () =>
    Promise.resolve({
      device_code: "device-xyz",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    })
  harness.pollAccessTokenImpl = () => new Promise<string>(() => {})
  harness.getGitHubUserImpl = () => Promise.resolve({ login: "octocat" })
  harness.addAccountImpl = () => Promise.resolve()
  harness.unlinkImpl = () => Promise.resolve()
  harness.unlinkCalls = []
  harness.addAccountCalls = []
  harness.deactivateCalls = 0
  harness.markNeedsReauthCalls = []
  harness.pollAccessTokenCalls = 0
  harness.setupCopilotTokenImpl = () => Promise.resolve()
  harness.setupCopilotTokenCalls = 0
  harness.cacheModelsImpl = () => Promise.resolve()
  harness.cacheModelsCalls = 0
})

afterEach(() => {
  __resetAuthControllerForTests()
  // The sign-in transient-mint path now schedules a background online-retry
  // loop; make sure a test that triggered it doesn't leak a parked timer.
  stopCopilotOnlineRetry()
  state.githubToken = undefined
  state.copilotToken = undefined
  state.userName = undefined
})

// --- getAuthStatus branches ------------------------------------------------

describe("getAuthStatus", () => {
  test("returns { state: 'authenticated' } with the login passed to markSignedIn", () => {
    // ADR-0006 (post-carve-out resolution): markSignedIn requires a real
    // login string — there is no "unknown" sentinel. An unknown identity
    // is an error state, not an authenticated one. Cold-boot callers
    // resolve the login via logUser() first.
    markSignedIn("alice")
    const status = getAuthStatus()
    expect(status.state).toBe("authenticated")
    if (status.state === "authenticated") {
      expect(status.account_login).toBe("alice")
      // No avatar was passed → the field is omitted, not an empty string.
      expect(status.account_avatar_url).toBeUndefined()
      // markSignedIn stamps the connection time; surfaced as an ISO string.
      expect(status.connected_since).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  test("carries the avatar URL passed to markSignedIn", () => {
    markSignedIn("alice", "https://avatars.githubusercontent.com/u/42?v=4")
    const status = getAuthStatus()
    if (status.state === "authenticated") {
      expect(status.account_avatar_url).toBe(
        "https://avatars.githubusercontent.com/u/42?v=4",
      )
    }
  })

  test("includes account_login when the controller has fetched it", async () => {
    // Drive a full success flow so accountLogin is populated.
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise
    harness.getGitHubUserImpl = () => Promise.resolve({ login: "alice" })

    await startDeviceFlow()
    poll.resolve("ghu_ok")
    await flushMicrotasks(10)

    const status = getAuthStatus()
    expect(status.state).toBe("authenticated")
    if (status.state === "authenticated") {
      expect(status.account_login).toBe("alice")
    }
  })

  test("primes the models cache after a successful device-flow sign-in", async () => {
    // Regression: the cold-boot path (bootstrap) calls cacheModels() after
    // minting the Copilot token, but the device-flow sign-in path did not.
    // On a fresh install (boot has no token → boot never primes), the lazy
    // stale-refresh middleware can't help (it no-ops on an unprimed cache),
    // so the models list stayed empty until a forced refresh. Sign-in must
    // prime it itself.
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise

    await startDeviceFlow()
    poll.resolve("ghu_ok")
    await flushMicrotasks(10)

    expect(getAuthStatus().state).toBe("authenticated")
    expect(harness.cacheModelsCalls).toBe(1)
  })

  test("a models-cache failure does not fail sign-in (best-effort)", async () => {
    // cacheModels is best-effort: a Copilot /models hiccup must not block the
    // user from reaching the signed-in state.
    harness.cacheModelsImpl = () => Promise.reject(new Error("models 503"))
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise

    await startDeviceFlow()
    poll.resolve("ghu_ok")
    await flushMicrotasks(10)

    expect(harness.cacheModelsCalls).toBe(1)
    expect(getAuthStatus().state).toBe("authenticated")
  })

  test("returns { state: 'unauthenticated' } literal when no token and no flow", () => {
    const status = getAuthStatus()
    expect(status).toEqual({ state: "unauthenticated" })
    expect(status.state).toBe("unauthenticated")
  })

  test("returns { state: 'error', error } when lastError is set and no flow active", async () => {
    // Drive a flow that fails.
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise
    await startDeviceFlow()
    poll.reject(new Error("access_denied"))
    await flushMicrotasks(10)

    const status = getAuthStatus()
    expect(status.state).toBe("error")
    if (status.state === "error") {
      expect(status.error).toBe("access_denied")
    }
  })

  test("does NOT return error state when lastError is set but a new flow is active", async () => {
    // First flow errors out.
    const poll1 = deferred<string>()
    harness.pollAccessTokenImpl = () => poll1.promise
    await startDeviceFlow()
    poll1.reject(new Error("expired_token"))
    await flushMicrotasks(10)

    // Second flow starts — lastError is cleared.
    harness.pollAccessTokenImpl = () => new Promise<string>(() => {})
    await startDeviceFlow()
    const status = getAuthStatus()
    expect(status.state).not.toBe("error")
    expect(["device_code_issued", "polling"]).toContain(status.state)
  })

  test("reports unauthenticated when flow is present but expired (mid-flow stale)", async () => {
    // Give the device code a tiny expires_in window, then wait it out.
    harness.getDeviceCodeImpl = () =>
      Promise.resolve({
        device_code: "device-xyz",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        // 0 second window: expiresAt = Date.now() + 0 -> immediately expired.
        expires_in: 0,
        interval: 5,
      })
    await startDeviceFlow()
    // Wait one tick so Date.now() ticks past expiresAt.
    await new Promise((r) => setTimeout(r, 5))

    const status = getAuthStatus()
    expect(status.state).toBe("unauthenticated")
  })

  test("emits state: 'polling' literal once the background poller has flipped isPolling", async () => {
    // Make pollAccessToken non-blocking but never-resolving: invoking it
    // forces the sync prelude of runPoller (`flow.isPolling = true`) to
    // execute and be observable. Use a setTimeout-based promise so the
    // microtask queue drains naturally.
    const state2 = { pollSignaledStart: false }
    harness.pollAccessTokenImpl = () => {
      state2.pollSignaledStart = true
      return new Promise<string>(() => {})
    }
    await startDeviceFlow()
    // Spin until we know pollAccessToken was entered (which only happens
    // after `flow.isPolling = true` ran).
    for (let i = 0; i < 50; i++) {
      if (state2.pollSignaledStart) break
      await new Promise((r) => setTimeout(r, 1))
    }
    expect(state2.pollSignaledStart).toBe(true)
    const status = getAuthStatus()
    expect(status.state).toBe("polling")
  })

  test("emits state: 'device_code_issued' literal with the user_code/verification_uri/expires_at fields", async () => {
    await startDeviceFlow()
    const status = getAuthStatus()
    assertPending(status)
    expect(status.user_code).toBe("ABCD-1234")
    expect(status.verification_uri).toBe("https://github.com/login/device")
    expect(typeof status.expires_at).toBe("string")
    // expires_at should be ~900s in the future. The * 1000 mutant would
    // produce ~0.9s in the future, falling well below this threshold.
    const delta = Date.parse(status.expires_at) - Date.now()
    expect(delta).toBeGreaterThan(60_000)
  })
})

// --- startDeviceFlow / idempotency / expired-flow replacement -------------

describe("startDeviceFlow", () => {
  test("returns the literal state: 'device_code_issued' on first issue", async () => {
    const res = await startDeviceFlow()
    expect(res.state).toBe("device_code_issued")
    assertPending(res)
    expect(res.user_code).toBe("ABCD-1234")
    expect(res.verification_uri).toBe("https://github.com/login/device")
  })

  test("idempotent re-call returns the literal state: 'device_code_issued' (not empty string)", async () => {
    await startDeviceFlow()
    const second = await startDeviceFlow()
    expect(second.state).toBe("device_code_issued")
  })

  test("invokes pollAccessToken once after device code is issued (poller actually runs)", async () => {
    await startDeviceFlow()
    await flushMicrotasks(10)
    expect(harness.pollAccessTokenCalls).toBe(1)
  })

  test("aborts the prior (expired) flow when starting a fresh flow — late resolution of stale poll is ignored", async () => {
    // First flow: expires_in 0 → immediately expired by next call.
    harness.getDeviceCodeImpl = () =>
      Promise.resolve({
        device_code: "device-1",
        user_code: "CODE-1",
        verification_uri: "https://github.com/login/device",
        expires_in: 0,
        interval: 5,
      })
    const firstPoll = deferred<string>()
    harness.pollAccessTokenImpl = () => firstPoll.promise
    await startDeviceFlow()
    await flushMicrotasks(5)
    // Wait so the first flow expires by wall-clock.
    await new Promise((r) => setTimeout(r, 5))

    // Second flow replaces the stale one. startDeviceFlow calls abort()
    // on the prior flow before nulling it out.
    harness.getDeviceCodeImpl = () =>
      Promise.resolve({
        device_code: "device-2",
        user_code: "CODE-2",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      })
    const secondPoll = deferred<string>()
    harness.pollAccessTokenImpl = () => secondPoll.promise
    const second = await startDeviceFlow()
    assertPending(second)
    expect(second.user_code).toBe("CODE-2")

    // Now resolve the FIRST poll. Because its AbortController was
    // aborted, the success branch must short-circuit — no token written,
    // no clobbering of the second flow.
    firstPoll.resolve("ghu_stale_first_flow")
    await flushMicrotasks(20)

    expect(state.githubToken).toBeUndefined()
    expect(harness.addAccountCalls.length).toBe(0)
    // Second flow still active.
    const status = getAuthStatus()
    assertPending(status)
    expect(status.user_code).toBe("CODE-2")
  })

  test("idempotent re-call returns same code without minting a new device code", async () => {
    let calls = 0
    harness.getDeviceCodeImpl = () => {
      calls++
      return Promise.resolve({
        device_code: `device-${calls}`,
        user_code: `CODE-${calls}`,
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      })
    }

    const first = await startDeviceFlow()
    const second = await startDeviceFlow()
    assertPending(first)
    assertPending(second)
    expect(second.user_code).toBe(first.user_code)
    expect(second.expires_at).toBe(first.expires_at)
    expect(calls).toBe(1) // existing && !isFlowExpired -> short-circuits
  })

  test("when the existing flow has expired, mints a fresh device code and aborts old", async () => {
    let calls = 0
    harness.getDeviceCodeImpl = () => {
      calls++
      return Promise.resolve({
        device_code: `device-${calls}`,
        user_code: `CODE-${calls}`,
        verification_uri: "https://github.com/login/device",
        expires_in: calls === 1 ? 0 : 900,
        interval: 5,
      })
    }

    const first = await startDeviceFlow()
    // Wait for the first flow's expiresAt to elapse.
    await new Promise((r) => setTimeout(r, 5))

    const second = await startDeviceFlow()
    expect(calls).toBe(2)
    assertPending(first)
    assertPending(second)
    expect(second.user_code).not.toBe(first.user_code)
    expect(second.user_code).toBe("CODE-2")
  })

  test("expires_at is roughly Date.now() + expires_in * 1000 (not / 1000)", async () => {
    harness.getDeviceCodeImpl = () =>
      Promise.resolve({
        device_code: "device-xyz",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 600, // 10 minutes
        interval: 5,
      })
    const before = Date.now()
    const res = await startDeviceFlow()
    const after = Date.now()
    assertPending(res)
    const expiresAtMs = Date.parse(res.expires_at)
    // *1000 -> +600000ms; /1000 -> +0.6ms. Wide window catches the mutant.
    expect(expiresAtMs - before).toBeGreaterThanOrEqual(599_000)
    expect(expiresAtMs - after).toBeLessThanOrEqual(600_500)
  })
})

// --- runPoller success / failure / abort branches --------------------------

describe("runPoller (driven by startDeviceFlow)", () => {
  test("success: writes token, populates accountLogin/userName, clears flow", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise
    harness.getGitHubUserImpl = () => Promise.resolve({ login: "alice" })

    await startDeviceFlow()
    // Mid-flow: while pollAccessToken pending, isPolling must be true
    // (BooleanLiteral mutant: flow.isPolling = true vs false).
    await flushMicrotasks()
    expect(getAuthStatus().state).toBe("polling")

    poll.resolve("ghu_success")
    await flushMicrotasks(20)

    expect(state.githubToken).toBe("ghu_success")
    expect(state.userName).toBe("alice")
    expect(harness.addAccountCalls.length).toBe(1)
    expect(harness.addAccountCalls[0]).toMatchObject({ token: "ghu_success" })
    // controllerState.flow cleared.
    const status = getAuthStatus()
    assertAuthenticated(status)
    expect(status.account_login).toBe("alice")
  })

  test("never reports 'authenticated' before the login is fetched (no '(unknown)' polling window)", async () => {
    // The Account UI polls /status every 2s while pending and STOPS the
    // instant it sees `authenticated`, re-fetching only on re-navigation.
    // So if the controller flips to authenticated before account_login is
    // populated, the UI latches "(unknown)" + a placeholder avatar. Guard
    // the ordering: the login must be resolved before `authenticated`.
    const poll = deferred<string>()
    const user = deferred<{ login: string }>()
    harness.pollAccessTokenImpl = () => poll.promise
    harness.getGitHubUserImpl = () => user.promise

    await startDeviceFlow()
    poll.resolve("ghu_ok")
    await flushMicrotasks(20)

    // Token has been polled + the user fetch is in flight, but the login
    // hasn't resolved yet. Status must NOT be authenticated here.
    expect(getAuthStatus().state).not.toBe("authenticated")

    user.resolve({ login: "alice" })
    await flushMicrotasks(20)

    const finalStatus = getAuthStatus()
    assertAuthenticated(finalStatus)
    expect(finalStatus.account_login).toBe("alice")
  })

  test("getGitHubUser failure surfaces error state, does NOT persist or claim authenticated", async () => {
    // ADR-0006 (post-carve-out resolution): a token we can't tie to a real
    // GitHub login is not "authenticated" — it's an unverifiable session.
    // The controller must surface an error so the user retries the device
    // flow rather than ending up with an `unknown@github.com` row in the
    // account registry and a "Signed in as ?" UI forever.
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise
    harness.getGitHubUserImpl = () => Promise.reject(new Error("403 user"))

    await startDeviceFlow()
    poll.resolve("ghu_should_not_persist")
    await flushMicrotasks(20)

    // Token dropped from in-memory state — never written.
    expect(state.githubToken).toBeUndefined()
    // userName was never populated because getGitHubUser threw.
    expect(state.userName).toBeUndefined()
    // No persistence: addAccount must not have been called.
    expect(harness.addAccountCalls.length).toBe(0)

    // Status reports the failure with a user-actionable message.
    const status = getAuthStatus()
    assertError(status)
    expect(status.error).toMatch(/verify your GitHub account/i)
  })

  test("fatal Copilot rejection after sign-in surfaces the error, never latches signed-in", async () => {
    // setupCopilotToken mimics production: a 401/403 from Copilot (license
    // revoked / TOS unaccepted) routes through markAuthDegraded — which drops
    // the live token AND sets the error state (but RETAINS the on-disk
    // credential) — then rethrows. runPoller must NOT paper a signed-in UI over
    // that degraded session and bury the reason.
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise
    harness.getGitHubUserImpl = () => Promise.resolve({ login: "alice" })
    const fatal = new CopilotAuthFatalError(
      "Copilot license revoked",
      403,
      "https://github.com/settings/copilot",
    )
    harness.setupCopilotTokenImpl = async () => {
      await markAuthDegraded(fatal)
      throw fatal
    }

    await startDeviceFlow()
    poll.resolve("ghu_no_copilot")
    await flushMicrotasks(20)

    const status = getAuthStatus()
    assertError(status)
    expect(status.error).toBe("Copilot license revoked")
    // The live token was dropped by markAuthDegraded — never left signed-in.
    expect(state.githubToken).toBeUndefined()
  })

  test("signOut during the Copilot-mint await wins — no signed-in over a wiped session", async () => {
    // Poller resolves the token + login, then parks on setupCopilotToken. The
    // user signs out during that await; when the mint resolves, the abort
    // re-check must short-circuit instead of latching signed-in.
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise
    harness.getGitHubUserImpl = () => Promise.resolve({ login: "alice" })
    const mint = deferred<undefined>()
    harness.setupCopilotTokenImpl = () => mint.promise

    await startDeviceFlow()
    poll.resolve("ghu_tok")
    await flushMicrotasks(20)

    await signOut()
    mint.resolve(undefined)
    await flushMicrotasks(20)

    expect(getAuthStatus().state).toBe("unauthenticated")
    expect(state.githubToken).toBeUndefined()
  })

  test("poll error emits the 'device-code poll terminated' warn with the message", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise
    const spy = spyConsola("warn")
    try {
      await startDeviceFlow()
      poll.reject(new Error("access_denied"))
      await flushMicrotasks(10)
      const hit = spy.calls.find(
        (args) =>
          typeof args[0] === "string"
          && args[0].includes("device-code poll terminated"),
      )
      expect(hit).toBeDefined()
      expect(hit?.[1]).toBe("access_denied")
    } finally {
      spy.restore()
    }
  })

  test("getGitHubUser failure emits the 'failed to verify GitHub account' warn", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise
    const userErr = new Error("403 forbidden")
    harness.getGitHubUserImpl = () => Promise.reject(userErr)
    const spy = spyConsola("warn")
    try {
      await startDeviceFlow()
      poll.resolve("ghu_tok")
      await flushMicrotasks(20)
      const hit = spy.calls.find(
        (args) =>
          typeof args[0] === "string"
          && args[0].includes("failed to verify GitHub account"),
      )
      expect(hit).toBeDefined()
      // The second argument is now the coerced string message
      // (the controller wraps the error into a user-facing message
      // and logs the underlying string), not the raw Error instance.
      expect(hit?.[1]).toBe(userErr.message)
    } finally {
      spy.restore()
    }
  })

  test("poll error: lastError surfaces, flow cleared, isPolling false (finally ran)", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise

    await startDeviceFlow()
    poll.reject(new Error("expired_token"))
    await flushMicrotasks(10)

    expect(state.githubToken).toBeUndefined()
    const status = getAuthStatus()
    assertError(status)
    expect(status.error).toBe("expired_token")
  })

  test("poll error with non-Error rejection: message coerced via String(err)", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise

    await startDeviceFlow()
    poll.reject("plain-string-rejection")
    await flushMicrotasks(10)

    const status = getAuthStatus()
    assertError(status)
    expect(status.error).toBe("plain-string-rejection")
  })

  test("abort before pollAccessToken resolves: success branch is short-circuited, no token written", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise

    await startDeviceFlow()
    // Sign out before the poll resolves — aborts the active flow.
    const signOutPromise = signOut()
    // Now resolve the poll: the post-await aborted guard must short-circuit.
    poll.resolve("ghu_should_be_dropped")
    await signOutPromise
    await flushMicrotasks(20)

    // Token was wiped by signOut and the resolved poll did NOT re-set it.
    expect(state.githubToken).toBeUndefined()
    expect(harness.addAccountCalls.length).toBe(0)
  })

  test("proactive mint: calls setupCopilotToken once after a successful poll", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise

    await startDeviceFlow()
    poll.resolve("ghu_success")
    await flushMicrotasks(20)

    expect(harness.setupCopilotTokenCalls).toBe(1)
    expect(state.githubToken).toBe("ghu_success")
  })

  test("proactive mint failure does NOT fail sign-in (token still set, status authenticated)", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise
    harness.setupCopilotTokenImpl = () =>
      Promise.reject(new Error("no copilot license"))
    const spy = spyConsola("warn")
    try {
      await startDeviceFlow()
      poll.resolve("ghu_kept_despite_mint_fail")
      await flushMicrotasks(20)

      // githubToken still set, sign-in still authenticated.
      expect(state.githubToken).toBe("ghu_kept_despite_mint_fail")
      expect(getAuthStatus().state).toBe("authenticated")
      // The warn surfaces the mint failure for diagnostics.
      const hit = spy.calls.find(
        (args) =>
          typeof args[0] === "string"
          && args[0].includes("Copilot token mint failed"),
      )
      expect(hit).toBeDefined()
    } finally {
      spy.restore()
    }
  })

  test("abort before pollAccessToken rejects: lastError NOT recorded", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise

    await startDeviceFlow()
    const signOutPromise = signOut()
    poll.reject(new Error("expired_token_after_abort"))
    await signOutPromise
    await flushMicrotasks(20)

    const status = getAuthStatus()
    // signOut cleared everything; aborted catch returned early so no error.
    expect(status.state).toBe("unauthenticated")
  })
})

describe("rearmCopilotAuth — re-mint discriminator", () => {
  test("ghu_ token + successful mint → 'online' and re-signs-in", async () => {
    state.githubToken = "ghu_valid"
    state.userName = "octocat"
    harness.setupCopilotTokenImpl = () => Promise.resolve()
    const outcome = await rearmCopilotAuth()
    expect(outcome).toBe("online")
    expect(harness.setupCopilotTokenCalls).toBe(1)
    expect(getAuthStatus().state).toBe("authenticated")
  })

  test("ghu_ token + auth-fatal mint → 'auth_fatal' (caller degrades)", async () => {
    state.githubToken = "ghu_dead"
    harness.setupCopilotTokenImpl = () =>
      Promise.reject(new CopilotAuthFatalError("revoked", 401, null))
    const outcome = await rearmCopilotAuth()
    expect(outcome).toBe("auth_fatal")
  })

  test("ghu_ token + transient mint failure → 'offline' (must NOT degrade)", async () => {
    state.githubToken = "ghu_valid"
    harness.setupCopilotTokenImpl = () =>
      Promise.reject(new Error("network down"))
    const outcome = await rearmCopilotAuth()
    expect(outcome).toBe("offline")
  })

  test("gho_ token short-circuits to 'auth_fatal' without a mint round-trip", async () => {
    state.githubToken = "gho_used_directly"
    const outcome = await rearmCopilotAuth()
    expect(outcome).toBe("auth_fatal")
    expect(harness.setupCopilotTokenCalls).toBe(0)
  })

  test("no GitHub credential → 'auth_fatal'", async () => {
    state.githubToken = undefined
    const outcome = await rearmCopilotAuth()
    expect(outcome).toBe("auth_fatal")
    expect(harness.setupCopilotTokenCalls).toBe(0)
  })

  test("is single-flight: concurrent triggers coalesce into one mint", async () => {
    state.githubToken = "ghu_valid"
    state.userName = "octocat"
    let release: (() => void) | undefined
    harness.setupCopilotTokenImpl = () =>
      new Promise<void>((r) => {
        release = () => {
          r()
        }
      })
    const a = rearmCopilotAuth()
    const b = rearmCopilotAuth()
    release?.()
    const [ra, rb] = await Promise.all([a, b])
    expect(harness.setupCopilotTokenCalls).toBe(1)
    expect(ra).toBe("online")
    expect(rb).toBe("online")
  })
})

describe("forwardError recovery path (integration with rearmCopilotAuth)", () => {
  test("completion 401 with a re-mintable ghu_ → 503 retry, session NOT degraded", async () => {
    state.githubToken = "ghu_valid"
    state.userName = "octocat"
    markSignedIn("octocat")
    harness.setupCopilotTokenImpl = () => Promise.resolve()

    const captured = { status: 0 }
    const ctx = {
      json: (_body: unknown, status?: number): Response => {
        captured.status = status ?? 200
        return new Response(null, { status: status ?? 200 })
      },
    }
    await forwardError(
      ctx as unknown as Parameters<typeof forwardError>[0],
      new CopilotAuthFatalError("stale bearer", 401, null),
    )

    // Recovered via re-mint → retryable 503, and we did NOT tear the session
    // down: still authenticated, no needs-reauth flag written.
    expect(captured.status).toBe(503)
    expect(getAuthStatus().state).toBe("authenticated")
    expect(harness.markNeedsReauthCalls.length).toBe(0)
  })
})
