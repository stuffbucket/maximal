/**
 * Coverage for the upstream-rejection sidecar: pure state helpers in
 * src/lib/state.ts plus propagation through auth-controller.getAuthStatus
 * and clearing on signOut.
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

import {
  clearLastUpstreamRejection,
  setLastUpstreamRejection,
  state,
} from "~/lib/state"

// --- Pure state-helper tests ----------------------------------------------

describe("setLastUpstreamRejection", () => {
  beforeEach(() => {
    state.lastUpstreamRejection = undefined
  })

  afterEach(() => {
    state.lastUpstreamRejection = undefined
  })

  test("writes message, status, remediationUrl plus an ISO `at` timestamp", () => {
    const before = Date.now()
    setLastUpstreamRejection({
      message: "quota exhausted",
      remediationUrl: "https://github.com/settings/copilot",
      status: 402,
    })
    const after = Date.now()

    const rec = state.lastUpstreamRejection
    expect(rec).toBeDefined()
    if (!rec) throw new Error("unreachable")
    expect(rec.message).toBe("quota exhausted")
    expect(rec.remediationUrl).toBe("https://github.com/settings/copilot")
    expect(rec.status).toBe(402)
    expect(typeof rec.at).toBe("string")
    const atMs = Date.parse(rec.at)
    expect(Number.isNaN(atMs)).toBe(false)
    expect(atMs).toBeGreaterThanOrEqual(before)
    expect(atMs).toBeLessThanOrEqual(after)
    // ISO format sanity (Z-terminated, has T separator).
    expect(rec.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
  })

  test("accepts null remediationUrl and preserves it as null", () => {
    setLastUpstreamRejection({
      message: "model not on plan",
      remediationUrl: null,
      status: 403,
    })
    expect(state.lastUpstreamRejection?.remediationUrl).toBeNull()
  })

  test("is idempotent on identical content (does not bump `at`)", () => {
    setLastUpstreamRejection({
      message: "quota exhausted",
      remediationUrl: null,
      status: 402,
    })
    const firstAt = state.lastUpstreamRejection?.at
    expect(firstAt).toBeDefined()

    setLastUpstreamRejection({
      message: "quota exhausted",
      remediationUrl: null,
      status: 402,
    })
    expect(state.lastUpstreamRejection?.at).toBe(firstAt as string)
  })

  test("updates `at` when the message differs", () => {
    setLastUpstreamRejection({
      message: "first",
      remediationUrl: null,
      status: 402,
    })
    const firstAt = state.lastUpstreamRejection?.at as string
    // Force a later wall-clock by advancing through enough event-loop turns
    // that Date.now() ticks at least one ms on every platform.
    const start = Date.now()
    while (Date.now() === start) {
      /* spin */
    }

    setLastUpstreamRejection({
      message: "second",
      remediationUrl: null,
      status: 402,
    })
    const rec = state.lastUpstreamRejection
    expect(rec?.message).toBe("second")
    expect(rec?.at).not.toBe(firstAt)
  })

  test("updates `at` when only the status differs", () => {
    setLastUpstreamRejection({
      message: "same",
      remediationUrl: null,
      status: 402,
    })
    const firstAt = state.lastUpstreamRejection?.at as string
    const start = Date.now()
    while (Date.now() === start) {
      /* spin */
    }

    setLastUpstreamRejection({
      message: "same",
      remediationUrl: null,
      status: 500,
    })
    const rec = state.lastUpstreamRejection
    expect(rec?.status).toBe(500)
    expect(rec?.at).not.toBe(firstAt)
  })

  test("updates `at` when only the remediationUrl differs", () => {
    setLastUpstreamRejection({
      message: "same",
      remediationUrl: null,
      status: 402,
    })
    const firstAt = state.lastUpstreamRejection?.at as string
    const start = Date.now()
    while (Date.now() === start) {
      /* spin */
    }

    setLastUpstreamRejection({
      message: "same",
      remediationUrl: "https://example.test/remediate",
      status: 402,
    })
    const rec = state.lastUpstreamRejection
    expect(rec?.remediationUrl).toBe("https://example.test/remediate")
    expect(rec?.at).not.toBe(firstAt)
  })
})

describe("clearLastUpstreamRejection", () => {
  beforeEach(() => {
    state.lastUpstreamRejection = undefined
  })

  afterEach(() => {
    state.lastUpstreamRejection = undefined
  })

  test("sets state.lastUpstreamRejection back to undefined", () => {
    setLastUpstreamRejection({
      message: "x",
      remediationUrl: null,
      status: 402,
    })
    expect(state.lastUpstreamRejection).toBeDefined()
    clearLastUpstreamRejection()
    expect(state.lastUpstreamRejection).toBeUndefined()
  })

  test("is safe to call when nothing is set", () => {
    state.lastUpstreamRejection = undefined
    clearLastUpstreamRejection()
    expect(state.lastUpstreamRejection).toBeUndefined()
  })
})

// --- getAuthStatus propagation --------------------------------------------
//
// auth-controller depends on several sibling modules at import time. We
// mock them at module scope before the dynamic import below, mirroring
// the pattern in tests/auth-controller.test.ts. Restored in afterAll so
// the stubs don't leak to later test files in the same `bun test` run.

const realGetDeviceCodeModule =
  await import("~/services/github/get-device-code")
const realGetUserModule = await import("~/services/github/get-user")
const realTokenModule = await import("~/lib/token")
const realFsPromisesModule = await import("node:fs/promises")

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
  getGitHubUser: () => Promise.resolve({ login: "octocat" }),
}))

void mock.module("~/lib/token", () => ({
  setupCopilotToken: () => Promise.resolve(),
}))

void mock.module("node:fs/promises", () => ({
  ...realFsPromisesModule,
  default: {
    ...(realFsPromisesModule as { default: object }).default,
    unlink: () => Promise.resolve(),
  },
  unlink: () => Promise.resolve(),
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

const { getAuthStatus, signOut, markSignedIn, __resetAuthControllerForTests } =
  await import("~/lib/auth-controller")

describe("getAuthStatus + lastUpstreamRejection", () => {
  beforeEach(() => {
    __resetAuthControllerForTests()
    state.githubToken = undefined
    state.copilotToken = undefined
    state.userName = undefined
    state.lastUpstreamRejection = undefined
  })

  afterEach(() => {
    __resetAuthControllerForTests()
    state.githubToken = undefined
    state.copilotToken = undefined
    state.userName = undefined
    state.lastUpstreamRejection = undefined
  })

  test("authenticated state surfaces last_upstream_rejection with remediation_url", () => {
    markSignedIn("alice")
    setLastUpstreamRejection({
      message: "quota exhausted",
      remediationUrl: "https://github.com/settings/copilot",
      status: 402,
    })
    const at = state.lastUpstreamRejection?.at as string

    const status = getAuthStatus()
    expect(status).toEqual({
      state: "authenticated",
      account_login: "alice",
      last_upstream_rejection: {
        message: "quota exhausted",
        status: 402,
        at,
        remediation_url: "https://github.com/settings/copilot",
      },
    })
  })

  test("rejection rides along on the unauthenticated state when no token is set", () => {
    setLastUpstreamRejection({
      message: "boom",
      remediationUrl: null,
      status: 500,
    })
    const at = state.lastUpstreamRejection?.at as string

    const status = getAuthStatus()
    expect(status).toEqual({
      state: "unauthenticated",
      last_upstream_rejection: {
        message: "boom",
        status: 500,
        at,
      },
    })
  })

  test("omits remediation_url when remediationUrl is null", () => {
    markSignedIn("alice")
    setLastUpstreamRejection({
      message: "no plan",
      remediationUrl: null,
      status: 403,
    })

    const status = getAuthStatus()
    if (status.state !== "authenticated") {
      throw new Error(`expected authenticated, got ${status.state}`)
    }
    expect(status.last_upstream_rejection).toBeDefined()
    expect(status.last_upstream_rejection).not.toHaveProperty("remediation_url")
  })

  test("omits last_upstream_rejection entirely when state.lastUpstreamRejection is undefined", () => {
    markSignedIn("alice")
    state.lastUpstreamRejection = undefined

    const status = getAuthStatus()
    expect(status).toEqual({ state: "authenticated", account_login: "alice" })
    expect(status).not.toHaveProperty("last_upstream_rejection")
  })
})

describe("signOut clears the upstream-rejection sidecar", () => {
  beforeEach(() => {
    __resetAuthControllerForTests()
    state.githubToken = undefined
    state.copilotToken = undefined
    state.userName = undefined
    state.lastUpstreamRejection = undefined
  })

  afterEach(() => {
    __resetAuthControllerForTests()
    state.githubToken = undefined
    state.copilotToken = undefined
    state.userName = undefined
    state.lastUpstreamRejection = undefined
  })

  test("signOut wipes state.lastUpstreamRejection and getAuthStatus no longer reports it", async () => {
    markSignedIn("alice")
    state.lastUpstreamRejection = {
      message: "x",
      remediationUrl: null,
      status: 402,
      at: new Date().toISOString(),
    }

    await signOut()

    expect(state.lastUpstreamRejection).toBeUndefined()
    const status = getAuthStatus()
    expect(status).not.toHaveProperty("last_upstream_rejection")
  })
})
