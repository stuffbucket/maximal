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

// --- Mock harness ----------------------------------------------------------

type Deferred<T> = {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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
  writeDefaultRecordImpl: (_: unknown): Promise<void> => Promise.resolve(),
  unlinkImpl: (_p: string): Promise<void> => Promise.resolve(),
  unlinkCalls: [] as Array<string>,
  writeDefaultRecordCalls: [] as Array<unknown>,
  setupCopilotTokenImpl: (): Promise<void> => Promise.resolve(),
  setupCopilotTokenCalls: 0,
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
  void mock.module("node:fs/promises", () => realFsPromisesModule)
})

const {
  startDeviceFlow,
  getAuthStatus,
  signOut,
  markSignedIn,
  __resetAuthControllerForTests,
  __setAuthControllerDepsForTests,
} = await import("~/lib/auth-controller")
const { state } = await import("~/lib/state")
const { PATHS } = await import("~/lib/paths")
const consolaMod = await import("consola")
const consola = consolaMod.default

// Spy helper for consola.warn / consola.error.
function spyConsola(method: "warn" | "error"): {
  calls: Array<Array<unknown>>
  restore: () => void
} {
  const calls: Array<Array<unknown>> = []
  const original = consola[method].bind(consola)
  consola[method] = ((...args: Array<unknown>) => {
    calls.push(args)
  }) as typeof consola.warn
  return {
    calls,
    restore: () => {
      consola[method] = original
    },
  }
}

// Helper to wait for the fire-and-forget poller microtask chain to settle.
async function flushMicrotasks(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  __resetAuthControllerForTests()
  __setAuthControllerDepsForTests({
    pollAccessToken: (_dc: unknown) => {
      harness.pollAccessTokenCalls++
      return harness.pollAccessTokenImpl()
    },
    writeDefaultRecord: (rec: unknown) => {
      harness.writeDefaultRecordCalls.push(rec)
      return harness.writeDefaultRecordImpl(rec)
    },
    makeRecord: (accessToken: string) => ({
      schemaVersion: 1,
      tokenType: "ghu_",
      accessToken,
      refreshToken: null,
      obtainedAt: new Date().toISOString(),
    }),
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
  harness.writeDefaultRecordImpl = () => Promise.resolve()
  harness.unlinkImpl = () => Promise.resolve()
  harness.unlinkCalls = []
  harness.writeDefaultRecordCalls = []
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

describe("getAuthStatus", () => {
  test("returns { state: 'authenticated' } (literal) when signed-in and no login known", () => {
    markSignedIn(null)
    const status = getAuthStatus()
    expect(status).toEqual({ state: "authenticated" })
    // Literal string check pins the StringLiteral mutant.
    expect(status.state).toBe("authenticated")
    expect("account_login" in status).toBe(false)
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
    expect(status.account_login).toBe("alice")
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
    expect(status.error).toBe("access_denied")
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
    expect(["device_code_issued", "polling"]).toContain(status.state)
    expect(status.user_code).toBe("ABCD-1234")
    expect(status.verification_uri).toBe("https://github.com/login/device")
    expect(typeof status.expires_at).toBe("string")
    // expires_at should be ~900s in the future. The * 1000 mutant would
    // produce ~0.9s in the future, falling well below this threshold.
    const delta = Date.parse(status.expires_at ?? "") - Date.now()
    expect(delta).toBeGreaterThan(60_000)
  })
})

// --- startDeviceFlow / idempotency / expired-flow replacement -------------

describe("startDeviceFlow", () => {
  test("returns the literal state: 'device_code_issued' on first issue", async () => {
    const res = await startDeviceFlow()
    expect(res.state).toBe("device_code_issued")
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
    expect(second.user_code).toBe("CODE-2")

    // Now resolve the FIRST poll. Because its AbortController was
    // aborted, the success branch must short-circuit — no token written,
    // no clobbering of the second flow.
    firstPoll.resolve("ghu_stale_first_flow")
    await flushMicrotasks(20)

    expect(state.githubToken).toBeUndefined()
    expect(harness.writeDefaultRecordCalls.length).toBe(0)
    // Second flow still active.
    const status = getAuthStatus()
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
    const expiresAtMs = Date.parse(res.expires_at ?? "")
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
    expect(harness.writeDefaultRecordCalls.length).toBe(1)
    expect(harness.writeDefaultRecordCalls[0]).toMatchObject({
      accessToken: "ghu_success",
    })
    // controllerState.flow cleared.
    const status = getAuthStatus()
    expect(status.state).toBe("authenticated")
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
    expect(finalStatus.state).toBe("authenticated")
    expect(finalStatus.account_login).toBe("alice")
  })

  test("getGitHubUser failure does NOT invalidate the token (best-effort login)", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise
    harness.getGitHubUserImpl = () => Promise.reject(new Error("403 user"))

    await startDeviceFlow()
    poll.resolve("ghu_token_kept")
    await flushMicrotasks(20)

    expect(state.githubToken).toBe("ghu_token_kept")
    // accountLogin remained null, userName never set.
    expect(state.userName).toBeUndefined()
    const status = getAuthStatus()
    expect(status.state).toBe("authenticated")
    expect(status.account_login).toBeUndefined()
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

  test("getGitHubUser failure emits the 'failed to fetch GitHub user' warn", async () => {
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
          && args[0].includes("failed to fetch GitHub user"),
      )
      expect(hit).toBeDefined()
      expect(hit?.[1]).toBe(userErr)
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
    expect(status.state).toBe("error")
    expect(status.error).toBe("expired_token")
  })

  test("poll error with non-Error rejection: message coerced via String(err)", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise

    await startDeviceFlow()
    poll.reject("plain-string-rejection")
    await flushMicrotasks(10)

    const status = getAuthStatus()
    expect(status.state).toBe("error")
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
    expect(harness.writeDefaultRecordCalls.length).toBe(0)
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
          && args[0].includes("failed to mint Copilot token"),
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

// --- markAuthFatalAndSignOut ----------------------------------------------

describe("markAuthFatalAndSignOut", () => {
  test("clears all token state and restamps lastError with structured payload", async () => {
    const { markAuthFatalAndSignOut } = await import("~/lib/auth-controller")
    const { CopilotAuthFatalError } = await import("~/lib/error")

    state.githubToken = "ghu_x"
    state.copilotToken = "tok"
    state.userName = "alice"

    await markAuthFatalAndSignOut(
      new CopilotAuthFatalError(
        "nope",
        403,
        "https://github.com/settings/copilot",
      ),
    )

    expect(state.githubToken).toBeUndefined()
    expect(state.copilotToken).toBeUndefined()
    expect(state.userName).toBeUndefined()
    expect(harness.unlinkCalls).toContain(PATHS.GITHUB_TOKEN_PATH)
    expect(getAuthStatus()).toEqual({
      state: "error",
      error: "nope",
      remediation_url: "https://github.com/settings/copilot",
    })
  })

  test("omits remediation_url from status when remediationUrl is null", async () => {
    const { markAuthFatalAndSignOut } = await import("~/lib/auth-controller")
    const { CopilotAuthFatalError } = await import("~/lib/error")

    state.githubToken = "ghu_x"
    state.copilotToken = "tok"
    state.userName = "alice"

    await markAuthFatalAndSignOut(
      new CopilotAuthFatalError("revoked", 401, null),
    )

    const status = getAuthStatus()
    expect(status).toEqual({ state: "error", error: "revoked" })
    expect(status).not.toHaveProperty("remediation_url")
  })

  test("subsequent startDeviceFlow clears the remediation", async () => {
    const { markAuthFatalAndSignOut } = await import("~/lib/auth-controller")
    const { CopilotAuthFatalError } = await import("~/lib/error")

    await markAuthFatalAndSignOut(
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

  test("tolerates a no-token starting state with ENOENT on unlink", async () => {
    const { markAuthFatalAndSignOut } = await import("~/lib/auth-controller")
    const { CopilotAuthFatalError } = await import("~/lib/error")

    // Nothing to clear, file already gone.
    const enoent: NodeJS.ErrnoException = Object.assign(new Error("missing"), {
      code: "ENOENT",
    })
    harness.unlinkImpl = () => Promise.reject(enoent)

    await markAuthFatalAndSignOut(
      new CopilotAuthFatalError("tos not accepted", 403, null),
    )

    const status = getAuthStatus()
    expect(status.state).toBe("error")
    expect(status.error).toBe("tos not accepted")
  })

  test("cancels an in-flight device flow (status becomes error, not device_code_issued)", async () => {
    const { markAuthFatalAndSignOut } = await import("~/lib/auth-controller")
    const { CopilotAuthFatalError } = await import("~/lib/error")

    // Active flow with a hanging poll.
    harness.pollAccessTokenImpl = () => new Promise<string>(() => {})

    await startDeviceFlow()
    expect(["device_code_issued", "polling"]).toContain(getAuthStatus().state)

    await markAuthFatalAndSignOut(
      new CopilotAuthFatalError("revoked mid-flow", 401, null),
    )

    // Mirrors existing signOut tests: post-cancel status must NOT
    // surface the in-flight flow. Here the auth-fatal restamps
    // lastError, so we see `error` rather than `unauthenticated`.
    const status = getAuthStatus()
    expect(status.state).toBe("error")
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

  test("clears accountLogin so the next authenticated status omits account_login", async () => {
    const poll = deferred<string>()
    harness.pollAccessTokenImpl = () => poll.promise
    harness.getGitHubUserImpl = () => Promise.resolve({ login: "alice" })

    await startDeviceFlow()
    poll.resolve("ghu_a")
    await flushMicrotasks(20)
    expect(getAuthStatus().account_login).toBe("alice")

    __resetAuthControllerForTests()
    // Re-sign-in without a login; account_login should not leak across resets.
    markSignedIn(null)
    const status = getAuthStatus()
    expect(status.state).toBe("authenticated")
    expect(status.account_login).toBeUndefined()
  })
})
