/**
 * Unit tests for src/lib/token.ts's CopilotAuthFatalError handling in
 * setupCopilotToken() and the private refresh loop. Drives the test-only
 * DI hook __setTokenDepsForTests so getCopilotToken and markAuthFatalAndSignOut
 * can be observed without real network or signOut.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { CopilotAuthFatalError, HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
// Bypass Bun's module-mock registry for ~/lib/token. auth-controller.test.ts
// installs a process-wide mock.module for "~/lib/token" (stubbing
// setupCopilotToken) so its own tests can observe controller-driven sign-in
// without spinning up a real refresh loop. The afterAll restore is unreliable
// across sibling test files in the same `bun test` process, so a normal
// static import here picks up the stub instead of the real module. The
// `?nomock` suffix forces a distinct module-registry key while resolving to
// the same source file at runtime; the dynamic spec keeps TS happy. The
// /* eslint-disable */ pragma below excludes the two __forTest symbols from
// knip's unused-export check — they ARE used here, just behind a dynamic
// specifier knip can't statically resolve.
const tokenSpec = "../src/lib/token.ts?nomock=token-auth-fatal"
const tokenMod = (await import(tokenSpec)) as typeof import("~/lib/token")
const {
  __resetTokenDepsForTests,
  __setTokenDepsForTests,
  setupCopilotToken,
  stopCopilotRefreshLoop,
} = tokenMod

type TokenResult = { token: string; refresh_in: number; expires_at: number }

const ok = (token: string, refresh_in: number): TokenResult => ({
  token,
  refresh_in,
  expires_at: Date.now() / 1000 + refresh_in,
})

const harness = {
  getCopilotTokenImpl: (): Promise<TokenResult> =>
    Promise.resolve(ok("copilot_xyz", 1800)),
  getCopilotTokenCalls: 0,
  getCopilotTokenQueue: [] as Array<() => Promise<TokenResult>>,
  markImpl: (): Promise<void> => Promise.resolve(),
  markCalls: [] as Array<InstanceType<typeof CopilotAuthFatalError>>,
}

beforeEach(() => {
  harness.getCopilotTokenImpl = () => Promise.resolve(ok("copilot_xyz", 1800))
  harness.getCopilotTokenCalls = 0
  harness.getCopilotTokenQueue = []
  harness.markImpl = () => Promise.resolve()
  harness.markCalls = []
  state.githubToken = undefined
  state.copilotToken = undefined

  __setTokenDepsForTests({
    getCopilotToken: () => {
      harness.getCopilotTokenCalls++
      const next = harness.getCopilotTokenQueue.shift()
      if (next) return next()
      return harness.getCopilotTokenImpl()
    },
    markAuthFatalAndSignOut: (
      err: InstanceType<typeof CopilotAuthFatalError>,
    ) => {
      harness.markCalls.push(err)
      return harness.markImpl()
    },
  })
})

afterEach(() => {
  stopCopilotRefreshLoop()
  state.githubToken = undefined
  state.copilotToken = undefined
  state.copilotApiUrl = undefined
})

afterAll(() => {
  __resetTokenDepsForTests()
})

// --- A. happy path --------------------------------------------------------

describe("setupCopilotToken — happy path", () => {
  test("on success, sets state.copilotToken and does not invoke markAuthFatalAndSignOut", async () => {
    harness.getCopilotTokenImpl = () => Promise.resolve(ok("copilot_xyz", 1800))

    await setupCopilotToken()

    expect(state.copilotToken).toBe("copilot_xyz")
    expect(harness.markCalls.length).toBe(0)
  })
})

// --- B. auth-fatal on initial mint ----------------------------------------

describe("setupCopilotToken — CopilotAuthFatalError on initial mint", () => {
  test("calls markAuthFatalAndSignOut once with the error, rethrows, does not start loop", async () => {
    const fatal = new CopilotAuthFatalError(
      "tos",
      403,
      "https://github.com/site/terms",
    )
    harness.getCopilotTokenImpl = () => Promise.reject(fatal)

    let caught: unknown = null
    try {
      await setupCopilotToken()
    } catch (err) {
      caught = err
    }

    expect(caught).toBe(fatal)
    expect(harness.markCalls.length).toBe(1)
    const passed = harness.markCalls[0]
    expect(passed.status).toBe(403)
    expect(passed.remediationUrl).toBe("https://github.com/site/terms")
    // No refresh-loop iteration; only the initial throw was observed.
    expect(harness.getCopilotTokenCalls).toBe(1)
  })
})

// --- C. non-fatal propagates without signOut ------------------------------

describe("setupCopilotToken — non-fatal error", () => {
  test("HTTPError (500) is rethrown unchanged and markAuthFatalAndSignOut is NOT called", async () => {
    const httpErr = new HTTPError("5xx", new Response(null, { status: 500 }))
    harness.getCopilotTokenImpl = () => Promise.reject(httpErr)

    let caught: unknown = null
    try {
      await setupCopilotToken()
    } catch (err) {
      caught = err
    }

    expect(caught).toBe(httpErr)
    expect(harness.markCalls.length).toBe(0)
  })
})

// --- D. gho_ early-return path skips getCopilotToken entirely -------------

describe("setupCopilotToken — gho_ tokens", () => {
  test("uses gho_ token directly as Copilot bearer and never calls getCopilotToken", async () => {
    state.githubToken = "gho_xxx"

    await setupCopilotToken()

    expect(state.copilotToken).toBe("gho_xxx")
    expect(harness.getCopilotTokenCalls).toBe(0)
    expect(harness.markCalls.length).toBe(0)
  })
})

// --- E. refresh loop exits on auth-fatal mid-loop --------------------------

describe("runCopilotRefreshLoop — auth-fatal during refresh", () => {
  test("loop calls markAuthFatalAndSignOut once and stops (no further token calls)", async () => {
    const fatal = new CopilotAuthFatalError("subscription_lapsed", 403, null)
    // First call (initial mint): short refresh_in to fire the loop fast.
    // Second call (in-loop refresh): throw fatal — loop must exit.
    harness.getCopilotTokenQueue = [
      () => Promise.resolve(ok("copilot_init", 1)),
      () => Promise.reject(fatal),
    ]

    await setupCopilotToken()
    expect(state.copilotToken).toBe("copilot_init")

    // refresh_in=1 -> getRefreshDeadlineMs clamps to nowMs+1000;
    // getRefreshPollDelayMs returns ~1000. Wait past one tick.
    await new Promise((r) => setTimeout(r, 1500))

    stopCopilotRefreshLoop()

    expect(harness.markCalls.length).toBe(1)
    expect(harness.markCalls[0]).toBe(fatal)
    // 1 initial mint + 1 in-loop refresh = 2. No third call after fatal exit.
    expect(harness.getCopilotTokenCalls).toBe(2)
  })
})

// --- F. refresh loop retries on non-fatal (regression guard) --------------

describe("runCopilotRefreshLoop — non-fatal during refresh", () => {
  test("non-fatal error does NOT trigger markAuthFatalAndSignOut", async () => {
    const httpErr = new HTTPError("5xx", new Response(null, { status: 500 }))
    harness.getCopilotTokenQueue = [
      () => Promise.resolve(ok("copilot_init", 1)),
      () => Promise.reject(httpErr),
    ]

    await setupCopilotToken()
    await new Promise((r) => setTimeout(r, 1500))

    stopCopilotRefreshLoop()

    expect(harness.markCalls.length).toBe(0)
    expect(harness.getCopilotTokenCalls).toBeGreaterThanOrEqual(2)
  })
})

// --- G. completion host resolves from the token's endpoints.api ------------
// Regression: the bearer minted by /copilot_internal/v2/token is only valid
// against its own endpoints.api; POSTing it to another GitHub Copilot host is
// rejected with 421 Misdirected Request. The host must be (re)applied on every
// mint AND refresh so a server-side account migration self-heals.

const INDIVIDUAL = "https://api.individual.githubcopilot.com"
const ENTERPRISE = "https://api.enterprise.githubcopilot.com"

const okWithApi = (
  token: string,
  refresh_in: number,
  api: string,
): TokenResult & { endpoints: { api: string } } => ({
  ...ok(token, refresh_in),
  endpoints: { api },
})

describe("setupCopilotToken — copilotApiUrl endpoint resolution", () => {
  test("initial mint applies endpoints.api over a stale cached host", async () => {
    state.copilotApiUrl = INDIVIDUAL // stale value from a prior session
    harness.getCopilotTokenImpl = () =>
      Promise.resolve(okWithApi("copilot_xyz", 1800, ENTERPRISE))

    await setupCopilotToken()

    expect(state.copilotApiUrl).toBe(ENTERPRISE)
  })

  test("a mint without endpoints leaves the existing host untouched", async () => {
    state.copilotApiUrl = ENTERPRISE
    harness.getCopilotTokenImpl = () => Promise.resolve(ok("copilot_xyz", 1800))

    await setupCopilotToken()

    expect(state.copilotApiUrl).toBe(ENTERPRISE)
  })

  test("refresh self-heals the host when the account is migrated mid-session", async () => {
    state.copilotApiUrl = undefined
    harness.getCopilotTokenQueue = [
      () => Promise.resolve(okWithApi("copilot_init", 1, INDIVIDUAL)),
      () => Promise.resolve(okWithApi("copilot_refreshed", 1800, ENTERPRISE)),
    ]

    await setupCopilotToken()
    // Cast: TS narrows the field to `undefined` after the literal reset above;
    // the refresh loop mutates it through state that TS can't see into.
    expect(state.copilotApiUrl as string | undefined).toBe(INDIVIDUAL)

    // refresh_in=1 fires the loop within ~1s (see test E timing notes).
    await new Promise((r) => setTimeout(r, 1500))
    stopCopilotRefreshLoop()

    expect(state.copilotApiUrl as string | undefined).toBe(ENTERPRISE)
    expect(state.copilotToken).toBe("copilot_refreshed")
  })
})
