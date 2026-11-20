/**
 * A sign-in another process writes to accounts.json (`maximal auth`) reaches a
 * running sidecar that is signed out or degraded. The registry is the real
 * store, sandboxed to a temp COPILOT_API_HOME by the global test preload; the
 * mint and model refresh go through the auth-recovery DI shim.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  __resetAuthControllerForTests,
  getAuthStatus,
  markAuthDegraded,
  markSignedIn,
} from "~/lib/auth/auth-controller"
import {
  __resetAuthRecoveryDepsForTests,
  __setAuthRecoveryDepsForTests,
} from "~/lib/auth/auth-recovery"
import {
  accountKey,
  addAndActivate,
  deactivate,
  emptyRegistry,
  makeAccountRecord,
  markNeedsReauth,
  readDefaultRegistry,
  writeDefaultRegistry,
} from "~/lib/auth/github-token-store"
import {
  pickAdoption,
  startRegistryAdoption,
  stopRegistryAdoption,
  tickRegistryAdoption,
} from "~/lib/auth/registry-adoption"
import { CopilotAuthFatalError } from "~/lib/errors/error"
import { state } from "~/lib/runtime-state/state"

const HOST = "github.com"
const rec = (login: string, token = `ghu_${login}`) =>
  makeAccountRecord({ login, host: HOST, token, addedVia: "device-code" })
const key = (login: string) => accountKey(login, HOST)

const harness = {
  setup: (): Promise<void> => Promise.resolve(),
  setupTokens: [] as Array<string | undefined>,
}

beforeEach(async () => {
  stopRegistryAdoption()
  __resetAuthControllerForTests()
  __resetAuthRecoveryDepsForTests()
  state.githubToken = undefined
  state.copilotToken = undefined
  state.userName = undefined
  harness.setup = () => Promise.resolve()
  harness.setupTokens = []
  __setAuthRecoveryDepsForTests({
    setupCopilotToken: () => {
      harness.setupTokens.push(state.githubToken)
      return harness.setup()
    },
    cacheModels: () => Promise.resolve(),
  })
  await writeDefaultRegistry(emptyRegistry())
})

afterEach(() => {
  stopRegistryAdoption()
  __resetAuthRecoveryDepsForTests()
  __resetAuthControllerForTests()
})

describe("registry adoption", () => {
  test("a degraded sidecar adopts a fresh token written for its account", async () => {
    await writeDefaultRegistry(
      addAndActivate(emptyRegistry(), rec("alice", "ghu_old")),
    )
    state.githubToken = "ghu_old"
    await markAuthDegraded(new CopilotAuthFatalError("revoked", 401, null))
    expect(getAuthStatus().state).toBe("error")
    await startRegistryAdoption()

    await writeDefaultRegistry(
      addAndActivate(await readDefaultRegistry(), rec("alice", "ghu_new")),
    )
    await tickRegistryAdoption()

    expect(harness.setupTokens).toEqual(["ghu_new"])
    expect(getAuthStatus()).toMatchObject({
      state: "authenticated",
      account_login: "alice",
    })
    expect(state.githubToken).toBe("ghu_new")
  })

  test("a sidecar that booted signed out adopts the account the CLI activates", async () => {
    await startRegistryAdoption()

    await writeDefaultRegistry(addAndActivate(emptyRegistry(), rec("bob")))
    await tickRegistryAdoption()

    expect(harness.setupTokens).toEqual(["ghu_bob"])
    expect(getAuthStatus()).toMatchObject({
      state: "authenticated",
      account_login: "bob",
    })
  })

  test("a signed-in session ignores registry changes", async () => {
    await writeDefaultRegistry(addAndActivate(emptyRegistry(), rec("alice")))
    state.githubToken = "ghu_alice"
    markSignedIn("alice")
    await startRegistryAdoption()

    await writeDefaultRegistry(addAndActivate(emptyRegistry(), rec("bob")))
    await tickRegistryAdoption()

    expect(harness.setupTokens).toEqual([])
    expect(getAuthStatus()).toMatchObject({ account_login: "alice" })
    expect(state.githubToken).toBe("ghu_alice")
  })

  test("an active account flagged needsReauth is not adopted", async () => {
    await startRegistryAdoption()

    await writeDefaultRegistry(
      markNeedsReauth(addAndActivate(emptyRegistry(), rec("bob")), key("bob"), {
        status: 401,
        message: "revoked",
        at: "t",
      }),
    )
    await tickRegistryAdoption()

    expect(harness.setupTokens).toEqual([])
    expect(getAuthStatus().state).toBe("unauthenticated")
  })

  test("a fatal mint flags the account, surfaces the reason, and is not retried", async () => {
    await startRegistryAdoption()
    harness.setup = () =>
      Promise.reject(new CopilotAuthFatalError("bob revoked", 401, null))

    await writeDefaultRegistry(addAndActivate(emptyRegistry(), rec("bob")))
    await tickRegistryAdoption()
    await tickRegistryAdoption()

    expect(harness.setupTokens).toEqual(["ghu_bob"])
    expect(getAuthStatus()).toMatchObject({
      state: "error",
      error: "bob revoked",
    })
    const after = await readDefaultRegistry()
    expect(after.accounts[key("bob")].needsReauth).toBe(true)
    expect(state.githubToken).toBeUndefined()
  })

  test("a non-fatal mint failure leaves the state alone and is not retried", async () => {
    await startRegistryAdoption()
    harness.setup = () => Promise.reject(new Error("network down"))

    await writeDefaultRegistry(addAndActivate(emptyRegistry(), rec("bob")))
    await tickRegistryAdoption()
    await tickRegistryAdoption()

    expect(harness.setupTokens).toEqual(["ghu_bob"])
    expect(getAuthStatus().state).toBe("unauthenticated")
    expect(state.githubToken).toBeUndefined()
    expect(state.userName).toBeUndefined()
    const after = await readDefaultRegistry()
    expect(after.accounts[key("bob")].needsReauth ?? false).toBe(false)
  })

  test("an explicit sign-out (no active account) adopts nothing", async () => {
    await startRegistryAdoption()

    await writeDefaultRegistry(
      deactivate(addAndActivate(emptyRegistry(), rec("bob"))),
    )
    await tickRegistryAdoption()

    expect(harness.setupTokens).toEqual([])
    expect(getAuthStatus().state).toBe("unauthenticated")
  })

  test("the token boot already tried is not adopted again", async () => {
    await writeDefaultRegistry(addAndActivate(emptyRegistry(), rec("bob")))
    await startRegistryAdoption()

    await tickRegistryAdoption()

    expect(harness.setupTokens).toEqual([])
  })
})

describe("pickAdoption", () => {
  const active = { ...rec("bob"), key: key("bob") }

  test("returns the active record only while signed out or degraded", () => {
    for (const authKind of ["signed-out", "error"] as const) {
      expect(pickAdoption({ authKind, active, lastAttemptedToken: null })).toBe(
        active,
      )
    }
    for (const authKind of ["signed-in", "polling", "device-issued"] as const) {
      expect(
        pickAdoption({ authKind, active, lastAttemptedToken: null }),
      ).toBeNull()
    }
  })

  test("skips a missing, flagged, or already-attempted record", () => {
    const authKind = "signed-out"
    expect(
      pickAdoption({ authKind, active: null, lastAttemptedToken: null }),
    ).toBeNull()
    expect(
      pickAdoption({
        authKind,
        active: { ...active, needsReauth: true },
        lastAttemptedToken: null,
      }),
    ).toBeNull()
    expect(
      pickAdoption({ authKind, active, lastAttemptedToken: "ghu_bob" }),
    ).toBeNull()
  })
})
