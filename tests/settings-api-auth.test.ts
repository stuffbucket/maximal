/**
 * /settings/api/auth/github/* — explicit on-demand device-code flow.
 *
 * getDeviceCode / pollAccessToken are mocked so tests never hit GitHub
 * and never sleep on the real RFC 8628 interval. writeDefaultRecord is
 * also mocked to avoid touching the user's real ~/.local/share token
 * file when the success path runs.
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
import { Hono } from "hono"

// Capture real get-device-code so afterAll can restore. poll-access-token
// and github-token-store are NOT mocked via mock.module here — they have
// their own dedicated test files (poll-access-token.test.ts,
// github-token-store.test.ts) that conflict with a process-wide mock.
// Instead we inject stubs via __setAuthControllerDepsForTests so the
// module registry stays clean.
const realGetDeviceCodeModule =
  await import("~/services/github/get-device-code")

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

const { AuthStatus } = await import("~/lib/settings-types")
const { __resetAuthControllerForTests, __setAuthControllerDepsForTests } =
  await import("~/lib/auth-controller")
const { createAuthMiddleware } = await import("~/lib/request-auth")
const { settingsApiRoutes } = await import("~/routes/settings/api")
const { state } = await import("~/lib/state")

function buildApp(opts?: { apiKeys?: Array<string> }) {
  const app = new Hono()
  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => opts?.apiKeys ?? [],
      // Tests pre-date the enforce flag; treat "any configured key"
      // as "enforce on" to preserve the original intent.
      isEnforcing: () => (opts?.apiKeys?.length ?? 0) > 0,
      allowUnauthenticatedPaths: ["/", "/usage-viewer"],
    }),
  )
  app.route("/settings/api", settingsApiRoutes)
  return app
}

beforeEach(() => {
  __resetAuthControllerForTests()
  __setAuthControllerDepsForTests({
    // Never resolves: tests assert on device_code_issued / polling state
    // without racing the success path. Tests that need a successful poll
    // re-inject locally.
    pollAccessToken: () => new Promise<string>(() => {}),
    addAccount: () => Promise.resolve(),
  })
  state.githubToken = undefined
  state.userName = undefined
})

afterEach(() => {
  __resetAuthControllerForTests()
  state.githubToken = undefined
  state.userName = undefined
})

describe("/settings/api/auth/github", () => {
  test("GET /status when unauthenticated returns { state: 'unauthenticated' }", async () => {
    const app = buildApp()
    const res = await app.request("/settings/api/auth/github/status")
    expect(res.status).toBe(200)
    const body = await res.json()
    const parsed = AuthStatus.safeParse(body)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.state).toBe("unauthenticated")
    }
  })

  test("POST /start returns device_code_issued with the user_code and verification_uri", async () => {
    const app = buildApp()
    const res = await app.request("/settings/api/auth/github/start", {
      method: "POST",
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    const parsed = AuthStatus.safeParse(body)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.state).toBe("device_code_issued")
      expect(parsed.data.user_code).toBe("ABCD-1234")
      expect(parsed.data.verification_uri).toBe(
        "https://github.com/login/device",
      )
      expect(typeof parsed.data.expires_at).toBe("string")
      // ISO timestamp parseable as a real Date.
      expect(Number.isNaN(Date.parse(parsed.data.expires_at ?? ""))).toBe(false)
    }
  })

  test("POST /start is idempotent: returns the same user_code while an active flow exists", async () => {
    const app = buildApp()
    const first = (await (
      await app.request("/settings/api/auth/github/start", { method: "POST" })
    ).json()) as { user_code: string; expires_at: string }
    const second = (await (
      await app.request("/settings/api/auth/github/start", { method: "POST" })
    ).json()) as { user_code: string; expires_at: string }
    expect(second.user_code).toBe(first.user_code)
    expect(second.expires_at).toBe(first.expires_at)
  })

  test("POST /sign-out clears state and returns { ok: true }", async () => {
    const app = buildApp()
    // Seed an authenticated state.
    state.githubToken = "ghu_seeded"
    state.userName = "alice"

    const res = await app.request("/settings/api/auth/github/sign-out", {
      method: "POST",
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(state.githubToken).toBeUndefined()
    expect(state.userName).toBeUndefined()

    // Subsequent status reflects the wipe.
    const statusBody = await (
      await app.request("/settings/api/auth/github/status")
    ).json()
    const parsedStatus = AuthStatus.safeParse(statusBody)
    expect(parsedStatus.success).toBe(true)
    if (parsedStatus.success) {
      expect(parsedStatus.data.state).toBe("unauthenticated")
    }
  })

  test("auth middleware: GET /status without API key returns 401 when keys are configured", async () => {
    const app = buildApp({ apiKeys: ["test-key"] })
    const unauth = await app.request("/settings/api/auth/github/status")
    expect(unauth.status).toBe(401)
    const authed = await app.request("/settings/api/auth/github/status", {
      headers: { "x-api-key": "test-key" },
    })
    expect(authed.status).toBe(200)
  })

  test("GET /status while an active flow exists reflects device_code_issued", async () => {
    const app = buildApp()
    await app.request("/settings/api/auth/github/start", { method: "POST" })
    const res = await app.request("/settings/api/auth/github/status")
    const body = await res.json()
    const parsed = AuthStatus.safeParse(body)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // Either device_code_issued (just emitted) or polling (poller
      // started flipping the flag) — both are valid mid-flow states.
      expect(["device_code_issued", "polling"]).toContain(parsed.data.state)
      expect(parsed.data.user_code).toBe("ABCD-1234")
    }
  })
})

afterAll(() => {
  void mock.module(
    "~/services/github/get-device-code",
    () => realGetDeviceCodeModule,
  )
})
