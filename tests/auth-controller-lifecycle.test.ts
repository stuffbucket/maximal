/**
 * auth-controller lifecycle: signOut, markAuthDegraded (non-destructive), and
 * __resetAuthControllerForTests. Self-contained mock preamble (Bun mock.module
 * is process-global, so each file owns its mocks); shares only the pure
 * utilities via ./helpers/auth-flow-utils.
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

import {
  deferred,
  flushMicrotasks,
  spyConsola,
} from "./helpers/auth-flow-utils"
import { assertAuthenticated, assertError } from "./helpers/auth-status"

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
const realTokenModule = await import("~/lib/token")
const realUtilsModule = await import("~/lib/utils")
const realFsPromisesModule = await import("node:fs/promises")

void mock.module("~/services/github/get-device-code", () => ({
  getDeviceCode: () => harness.getDeviceCodeImpl(),
}))

void mock.module("~/services/github/get-user", () => ({
  getGitHubUser: (_token?: string) => harness.getGitHubUserImpl(),
}))

void mock.module("~/lib/token", () => ({
  setupCopilotToken: () => {
    harness.setupCopilotTokenCalls++
    return harness.setupCopilotTokenImpl()
  },
  // markAuthDegraded calls this to halt the refresh loop; no-op in unit tests.
  stopCopilotRefreshLoop: () => {},
}))

// Sign-in now primes the models cache (cacheModels) after minting the
// Copilot token. Stub it so completing a device flow doesn't make a real
// Copilot /models fetch; spread the real namespace so the other utils
// exports survive.
void mock.module("~/lib/utils", () => ({
  ...realUtilsModule,
  cacheModels: () => Promise.resolve(),
}))

// Spread the real namespace so `readFile` / `writeFile` / etc. survive
// the override — `tests/github-token-store.test.ts` reads/writes via
// the same module and gets undefined functions otherwise.
void mock.module("node:fs/promises", () => ({
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

afterAll(() => {
  void mock.module(
    "~/services/github/get-device-code",
    () => realGetDeviceCodeModule,
  )
  void mock.module("~/services/github/get-user", () => realGetUserModule)
  void mock.module("~/lib/token", () => realTokenModule)
  void mock.module("~/lib/utils", () => realUtilsModule)
  void mock.module("node:fs/promises", () => realFsPromisesModule)
})

const {
  startDeviceFlow,
  getAuthStatus,
  signOut,
  markSignedIn,
  markAuthDegraded,
  __resetAuthControllerForTests,
  __setAuthControllerDepsForTests,
} = await import("~/lib/auth-controller")
const { CopilotAuthFatalError } = await import("~/lib/error")
const { state } = await import("~/lib/state")
const { PATHS } = await import("~/lib/paths")

beforeEach(() => {
  __resetAuthControllerForTests()
  __setAuthControllerDepsForTests({
    pollAccessToken: (_dc: unknown) => {
      harness.pollAccessTokenCalls++
      return harness.pollAccessTokenImpl()
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
})

afterEach(() => {
  __resetAuthControllerForTests()
  state.githubToken = undefined
  state.copilotToken = undefined
  state.userName = undefined
})

// --- getAuthStatus branches ------------------------------------------------
// --- signOut: state wipe + on-disk unlink ENOENT branch -------------------

describe("signOut", () => {
  test("clears tokens, attempts to unlink the on-disk token at the configured path", async () => {
    state.githubToken = "ghu_seed"
    state.copilotToken = "cop_seed"
    state.userName = "alice"

    await signOut()

    expect(state.githubToken).toBeUndefined()
    expect(state.copilotToken).toBeUndefined()
    expect(state.userName).toBeUndefined()
    expect(harness.unlinkCalls).toContain(PATHS.GITHUB_TOKEN_PATH)
  })

  test("swallows ENOENT from unlink without warning", async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error("missing"), {
      code: "ENOENT",
    })
    harness.unlinkImpl = () => Promise.reject(err)
    const spy = spyConsola("warn")
    try {
      await signOut()
      expect(state.githubToken).toBeUndefined()
      // The ENOENT path must NOT emit the "failed to delete token file" warn.
      const failedDelete = spy.calls.find(
        (args) =>
          typeof args[0] === "string"
          && args[0].includes("failed to delete token file"),
      )
      expect(failedDelete).toBeUndefined()
    } finally {
      spy.restore()
    }
  })

  test("non-ENOENT unlink error emits the 'failed to delete token file' warn", async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error("permission"), {
      code: "EACCES",
    })
    harness.unlinkImpl = () => Promise.reject(err)
    const spy = spyConsola("warn")
    try {
      await signOut()
      const failedDelete = spy.calls.find(
        (args) =>
          typeof args[0] === "string"
          && args[0].includes("failed to delete token file"),
      )
      expect(failedDelete).toBeDefined()
      // The error object is passed through as the second arg.
      expect(failedDelete?.[1]).toBe(err)
    } finally {
      spy.restore()
    }
  })

  test("non-Error rejection from unlink (no code property) is swallowed without crashing", async () => {
    // Tests the typeof / null / 'code' in branches of the catch guard.
    harness.unlinkImpl = () => Promise.reject(new Error("plain-error-no-code"))
    await signOut()
    // Must not throw — the catch's `'code' in err` guard short-circuits.
    expect(state.githubToken).toBeUndefined()
  })

  test("rejection of type null is swallowed (err !== null guard)", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately exercising the `err !== null` guard
    harness.unlinkImpl = () => Promise.reject(null)
    await signOut()
    expect(state.githubToken).toBeUndefined()
  })

  test("rejection without 'code' property does not produce the 'failed to delete' warn", async () => {
    // Tests that 'code' in err is required to enter the warn branch.
    harness.unlinkImpl = () => Promise.reject(new Error("bare error, no code"))
    const spy = spyConsola("warn")
    try {
      await signOut()
      const failedDelete = spy.calls.find(
        (args) =>
          typeof args[0] === "string"
          && args[0].includes("failed to delete token file"),
      )
      expect(failedDelete).toBeUndefined()
    } finally {
      spy.restore()
    }
  })

  test("aborts any active flow's AbortController and nulls controllerState.flow", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise

    await startDeviceFlow()
    // Mid-flow: status reflects active flow.
    expect(["device_code_issued", "polling"]).toContain(getAuthStatus().state)

    await signOut()

    expect(getAuthStatus()).toEqual({ state: "unauthenticated" })

    // Even if the poll later resolves, no token is written.
    poll.resolve("ghu_late")
    await flushMicrotasks(20)
    expect(state.githubToken).toBeUndefined()
  })
})

// --- markAuthDegraded (non-destructive) -----------------------------------

describe("markAuthDegraded", () => {
  test("drops the LIVE tokens + sets the error state but RETAINS the credential (no unlink) and flags needs-reauth", async () => {
    state.githubToken = "ghu_x"
    state.copilotToken = "tok"
    state.userName = "alice"

    await markAuthDegraded(
      new CopilotAuthFatalError(
        "nope",
        403,
        "https://github.com/settings/copilot",
      ),
    )

    // Live in-memory tokens are dropped so we fail fast.
    expect(state.githubToken).toBeUndefined()
    expect(state.copilotToken).toBeUndefined()
    expect(state.userName).toBeUndefined()
    // CRITICAL: the on-disk credential is NOT deleted — never unlink here, and
    // never run the destructive deactivate. The account is flagged needs-reauth
    // (retained) with a structured error instead.
    expect(harness.unlinkCalls).not.toContain(PATHS.GITHUB_TOKEN_PATH)
    expect(harness.deactivateCalls).toBe(0)
    expect(harness.markNeedsReauthCalls).toHaveLength(1)
    expect(harness.markNeedsReauthCalls[0].status).toBe(403)
    expect(harness.markNeedsReauthCalls[0].message).toBe("nope")
    expect(typeof harness.markNeedsReauthCalls[0].at).toBe("string")
    expect(getAuthStatus()).toEqual({
      state: "error",
      error: "nope",
      remediation_url: "https://github.com/settings/copilot",
    })
  })

  test("idempotent: repeated calls with the same error flag the account only once (no stampede)", async () => {
    state.githubToken = "ghu_x"
    const err = new CopilotAuthFatalError("revoked", 401, null)

    // A burst of concurrent completion-401s all call markAuthDegraded.
    await markAuthDegraded(err)
    await markAuthDegraded(err)
    await markAuthDegraded(new CopilotAuthFatalError("revoked", 401, null))

    // The disk flag write happens once; the later calls early-return.
    expect(harness.markNeedsReauthCalls).toHaveLength(1)
    // But the live token is dropped on every call (idempotent fail-fast).
    state.githubToken = "ghu_again"
    await markAuthDegraded(err)
    expect(state.githubToken).toBeUndefined()
  })

  test("omits remediation_url from status when remediationUrl is null", async () => {
    state.githubToken = "ghu_x"
    state.copilotToken = "tok"
    state.userName = "alice"

    await markAuthDegraded(new CopilotAuthFatalError("revoked", 401, null))

    const status = getAuthStatus()
    expect(status).toEqual({ state: "error", error: "revoked" })
    expect(status).not.toHaveProperty("remediation_url")
  })

  test("subsequent startDeviceFlow clears the remediation", async () => {
    await markAuthDegraded(
      new CopilotAuthFatalError(
        "nope",
        403,
        "https://github.com/settings/copilot",
      ),
    )
    expect(getAuthStatus().state).toBe("error")

    await startDeviceFlow()
    const status = getAuthStatus()
    expect(["device_code_issued", "polling"]).toContain(status.state)
    expect(status).not.toHaveProperty("error")
    expect(status).not.toHaveProperty("remediation_url")
  })

  test("tolerates a registry-write failure without throwing (credential degrade is best-effort)", async () => {
    // The needs-reauth flag write rejects; markAuthDegraded must swallow it and
    // still land in the error state (degrading must never throw).
    __setAuthControllerDepsForTests({
      markActiveNeedsReauth: () => Promise.reject(new Error("disk full")),
    })

    await markAuthDegraded(
      new CopilotAuthFatalError("tos not accepted", 403, null),
    )

    const status = getAuthStatus()
    assertError(status)
    expect(status.error).toBe("tos not accepted")
  })

  test("cancels an in-flight device flow (status becomes error, not device_code_issued)", async () => {
    // Active flow with a hanging poll.
    harness.pollAccessTokenImpl = () => new Promise<string>(() => {})

    await startDeviceFlow()
    expect(["device_code_issued", "polling"]).toContain(getAuthStatus().state)

    await markAuthDegraded(
      new CopilotAuthFatalError("revoked mid-flow", 401, null),
    )

    // Post-cancel status must NOT surface the in-flight flow. The auth-fatal
    // sets the error state, so we see `error` rather than `unauthenticated`.
    const status = getAuthStatus()
    assertError(status)
    expect(status.error).toBe("revoked mid-flow")
    expect(["device_code_issued", "polling"]).not.toContain(status.state)
  })
})

// --- __resetAuthControllerForTests behaviour ------------------------------

describe("__resetAuthControllerForTests", () => {
  test("nulls flow + clears lastError + accountLogin and aborts the active flow", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise
    harness.getGitHubUserImpl = () => Promise.resolve({ login: "alice" })

    await startDeviceFlow()
    expect(["device_code_issued", "polling"]).toContain(getAuthStatus().state)

    __resetAuthControllerForTests()

    // Flow nulled, lastError cleared, accountLogin cleared.
    expect(getAuthStatus()).toEqual({ state: "unauthenticated" })

    // Late poll resolution after reset must not reinstate state.
    poll.resolve("ghu_late_reset")
    await flushMicrotasks(20)
    expect(state.githubToken).toBeUndefined()
  })

  test("clears lastError so post-reset status is unauthenticated, not error", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise

    await startDeviceFlow()
    poll.reject(new Error("expired_token"))
    await flushMicrotasks(10)
    expect(getAuthStatus().state).toBe("error")

    __resetAuthControllerForTests()
    expect(getAuthStatus()).toEqual({ state: "unauthenticated" })
  })

  test("clears accountLogin so the next markSignedIn call sees a fresh slate", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise
    harness.getGitHubUserImpl = () => Promise.resolve({ login: "alice" })

    await startDeviceFlow()
    poll.resolve("ghu_a")
    await flushMicrotasks(20)
    const before = getAuthStatus()
    assertAuthenticated(before)
    expect(before.account_login).toBe("alice")

    __resetAuthControllerForTests()
    // After reset the controller is signed-out; the next markSignedIn
    // call writes its own login without inheriting alice. ADR-0006:
    // markSignedIn requires a real login (no `null`), so we pass one.
    markSignedIn("bob")
    const status = getAuthStatus()
    assertAuthenticated(status)
    expect(status.account_login).toBe("bob")
  })
})
