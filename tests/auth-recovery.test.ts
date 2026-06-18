/**
 * Zero-click auto-recovery (src/lib/auth-recovery.ts). Drives the DI shim so
 * preflight / mint / model-refresh are observable without real network. The
 * registry is the real store, isolated to a temp COPILOT_API_HOME by the global
 * test preload (tests/test-setup.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  __resetAuthControllerForTests,
  getAuthStatus,
  markAuthDegraded,
  markSignedIn,
  registerAutoRecovery,
} from "~/lib/auth-controller"
import {
  __resetAuthRecoveryDepsForTests,
  __setAuthRecoveryDepsForTests,
  attemptAutoRecovery,
} from "~/lib/auth-recovery"
import { CopilotAuthFatalError } from "~/lib/error"
import {
  accountKey,
  addAndActivate,
  emptyRegistry,
  makeAccountRecord,
  markNeedsReauth,
  readDefaultRegistry,
  writeDefaultRegistry,
} from "~/lib/github-token-store"
import { state } from "~/lib/state"

const HOST = "github.com"
const rec = (login: string) =>
  makeAccountRecord({
    login,
    host: HOST,
    token: `ghu_${login}`,
    addedVia: "device-code",
  })
const key = (login: string) => accountKey(login, HOST)
const ERR = { status: 401 as number | null, message: "revoked", at: "t" }

const harness = {
  preflight: (_t: string, _l: string): Promise<string | null> =>
    Promise.resolve(null),
  setup: (): Promise<void> => Promise.resolve(),
  setupSawToken: undefined as string | undefined,
}

beforeEach(async () => {
  __resetAuthControllerForTests()
  __resetAuthRecoveryDepsForTests()
  state.githubToken = undefined
  state.copilotToken = undefined
  state.userName = undefined
  harness.preflight = () => Promise.resolve(null)
  harness.setup = () => Promise.resolve()
  harness.setupSawToken = undefined
  __setAuthRecoveryDepsForTests({
    preflightCopilotError: (t, l) => harness.preflight(t, l),
    setupCopilotToken: () => {
      harness.setupSawToken = state.githubToken
      return harness.setup()
    },
    cacheModels: () => Promise.resolve(),
  })
  await writeDefaultRegistry(emptyRegistry())
})

afterEach(() => {
  __resetAuthRecoveryDepsForTests()
  __resetAuthControllerForTests()
})

describe("attemptAutoRecovery", () => {
  test("switches LIVE to a known-good account and signs in", async () => {
    // alice is active and just failed (flagged); bob is good.
    let reg = addAndActivate(
      addAndActivate(emptyRegistry(), rec("bob")),
      rec("alice"),
    )
    reg = markNeedsReauth(reg, key("alice"), ERR)
    await writeDefaultRegistry(reg)

    const ok = await attemptAutoRecovery()

    expect(ok).toBe(true)
    expect(harness.setupSawToken).toBe("ghu_bob") // minted with bob's token
    expect(state.githubToken).toBe("ghu_bob")
    expect(state.userName).toBe("bob")
    expect(getAuthStatus()).toMatchObject({
      state: "authenticated",
      account_login: "bob",
    })
    const after = await readDefaultRegistry()
    expect(after.activeKey).toBe(key("bob"))
    expect(after.accounts[key("bob")].needsReauth ?? false).toBe(false)
    // The failed account is retained, still flagged — never deleted.
    expect(after.accounts[key("alice")].needsReauth).toBe(true)
    expect(after.accounts[key("alice")].token).toBe("ghu_alice")
  })

  test("returns false (and clears state) when every other account is flagged or active", async () => {
    let reg = addAndActivate(
      addAndActivate(emptyRegistry(), rec("bob")),
      rec("alice"),
    )
    reg = markNeedsReauth(reg, key("alice"), ERR) // active, flagged
    reg = markNeedsReauth(reg, key("bob"), ERR) // also flagged → excluded
    await writeDefaultRegistry(reg)

    const ok = await attemptAutoRecovery()

    expect(ok).toBe(false)
    expect(harness.setupSawToken).toBeUndefined() // no mint attempted
    expect(state.githubToken).toBeUndefined()
    expect(getAuthStatus().state).not.toBe("authenticated")
  })

  test("flags a candidate that FAILS preflight and recovers onto the next good one", async () => {
    let reg = addAndActivate(emptyRegistry(), rec("bob"))
    reg = addAndActivate(reg, rec("carol"))
    reg = addAndActivate(reg, rec("alice")) // alice active
    reg = markNeedsReauth(reg, key("alice"), ERR)
    await writeDefaultRegistry(reg)
    harness.preflight = (_t, l) =>
      Promise.resolve(l === "bob" ? "bob has no Copilot" : null)

    const ok = await attemptAutoRecovery()

    expect(ok).toBe(true)
    expect(state.userName).toBe("carol")
    const after = await readDefaultRegistry()
    expect(after.activeKey).toBe(key("carol"))
    expect(after.accounts[key("bob")].needsReauth).toBe(true) // flagged by sweep
  })

  test("flags a candidate that passes preflight but FAILS the live mint (TOCTOU), tries next", async () => {
    let reg = addAndActivate(emptyRegistry(), rec("bob"))
    reg = addAndActivate(reg, rec("carol"))
    reg = addAndActivate(reg, rec("alice"))
    reg = markNeedsReauth(reg, key("alice"), ERR)
    await writeDefaultRegistry(reg)
    // preflight passes for all; the mint throws only for bob's token.
    harness.setup = () =>
      state.githubToken === "ghu_bob" ?
        Promise.reject(new Error("mint 401"))
      : Promise.resolve()

    const ok = await attemptAutoRecovery()

    expect(ok).toBe(true)
    expect(state.userName).toBe("carol")
    const after = await readDefaultRegistry()
    expect(after.accounts[key("bob")].needsReauth).toBe(true)
    expect(after.activeKey).toBe(key("carol"))
  })
})

describe("markAuthDegraded → auto-recovery wiring", () => {
  test("invokes the registered recovery and skips the error state on success", async () => {
    let called = 0
    registerAutoRecovery(() => {
      called++
      markSignedIn("bob") // recovery switched live onto another account
      return Promise.resolve(true)
    })
    state.githubToken = "ghu_x"

    await markAuthDegraded(new CopilotAuthFatalError("revoked", 401, null))

    expect(called).toBe(1)
    expect(getAuthStatus()).toMatchObject({
      state: "authenticated",
      account_login: "bob",
    })
  })

  test("falls to the error state when recovery finds no good account", async () => {
    registerAutoRecovery(() => Promise.resolve(false))
    state.githubToken = "ghu_x"

    await markAuthDegraded(
      new CopilotAuthFatalError("revoked", 401, "https://x"),
    )

    expect(getAuthStatus()).toMatchObject({ state: "error", error: "revoked" })
  })
})
