/**
 * Coverage for the network-banner hysteresis + its wiring onto the auth status.
 *
 * Two layers, deliberately kept distinct (see the DUT-vs-harness note below):
 *
 *   1. The PURE reducer `step()` — onset debounce, reconnect-notify threshold,
 *      outage-anchor semantics. Driven with a fake clock; no globals touched.
 *
 *   2. The WIRED seam — feed a diagnosis through the shared singleton
 *      (`advanceHysteresis`) into `setNetworkDiagnosis`, and assert it surfaces
 *      on `getAuthStatus()` (the exact shape the SSE `auth.changed` event and
 *      the GET endpoint carry). This proves state.ts + auth-controller are
 *      actually connected to the reducer — a pure-`step` test alone can't, and
 *      a narrow state-only test would leave the projector unregistered and the
 *      emit path silently a no-op. The wired test imports auth-controller so the
 *      projector IS registered, mirroring production module-load order.
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

import type { NetworkDiagnosis } from "~/lib/net/network-diagnostics"

import {
  NETWORK_DIAGNOSIS_KIND,
  NETWORK_SCOPE,
} from "~/lib/net/network-diagnostics"
import {
  __resetHysteresisForTests,
  advanceHysteresis,
  getHysteresisState,
  initialHysteresisState,
  NETWORK_BANNER_ONSET_MS,
  NOTIFY_ON_RECONNECT_MS,
  step,
} from "~/lib/net/network-hysteresis"
import {
  clearNetworkDiagnosis,
  setNetworkDiagnosis,
  state,
} from "~/lib/runtime-state/state"

/** A minimal `NetworkDiagnosis` for the reducer. `step()` reads only `kind` +
 *  `scope`; `summary`/`probe` are carried opaquely, so stub them. */
function diag(
  kind: NetworkDiagnosis["kind"],
  scope: NetworkDiagnosis["scope"] = NETWORK_SCOPE.githubCopilotAuth,
): NetworkDiagnosis {
  return {
    kind,
    scope,
    summary: {
      code: "ENETUNREACH",
      errno: -51,
      syscall: "connect",
      url: null,
      name: null,
      message: null,
    },
    probe: {
      ipReachable: false,
      ipv4Reachable: false,
      ipv6Reachable: false,
      dnsResolves: false,
      activeInterfaces: [],
    },
  }
}

const OFFLINE = diag(NETWORK_DIAGNOSIS_KIND.offline)
const SCOPE_DOWN = diag(NETWORK_DIAGNOSIS_KIND.scopeUnreachable)

// --- Pure reducer: onset debounce -----------------------------------------

describe("step — onset debounce", () => {
  test("a failure inside the onset window does NOT surface a banner", () => {
    const t0 = 1_000
    const r = step(initialHysteresisState, OFFLINE, t0)
    expect(r.bannerDiagnosis).toBeNull()
    expect(r.state.firstFailureAt).toBe(t0)
    expect(r.state.active).toBe(false)
  })

  test("a failure that persists past the onset window surfaces the banner", () => {
    const t0 = 1_000
    const first = step(initialHysteresisState, OFFLINE, t0)
    // Same continuous outage, now past the onset threshold.
    const later = step(first.state, OFFLINE, t0 + NETWORK_BANNER_ONSET_MS)
    expect(later.bannerDiagnosis).toEqual(OFFLINE)
    expect(later.state.active).toBe(true)
  })

  test("the onset window anchors on the FIRST failure and isn't reset by a differing verdict", () => {
    const t0 = 1_000
    const first = step(initialHysteresisState, OFFLINE, t0)
    // A different failure kind arrives mid-window — the outage is continuous,
    // so firstFailureAt must NOT move (else onset never elapses under churn).
    const churn = step(first.state, SCOPE_DOWN, t0 + 5_000)
    expect(churn.state.firstFailureAt).toBe(t0)
    expect(churn.bannerDiagnosis).toBeNull()
    // Once the ORIGINAL anchor + onset elapses, the LATEST verdict surfaces.
    const shown = step(churn.state, SCOPE_DOWN, t0 + NETWORK_BANNER_ONSET_MS)
    expect(shown.bannerDiagnosis).toEqual(SCOPE_DOWN)
  })

  test("the boundary is inclusive (>= onset shows)", () => {
    const t0 = 0
    const first = step(initialHysteresisState, OFFLINE, t0)
    const exact = step(first.state, OFFLINE, t0 + NETWORK_BANNER_ONSET_MS)
    expect(exact.bannerDiagnosis).toEqual(OFFLINE)
  })
})

// --- Pure reducer: reconnect-notify ---------------------------------------

describe("step — reconnect notify", () => {
  test("a sub-threshold outage clears SILENTLY (no notify)", () => {
    const t0 = 1_000
    const first = step(initialHysteresisState, OFFLINE, t0)
    const recovered = step(first.state, null, t0 + NOTIFY_ON_RECONNECT_MS - 1)
    expect(recovered.bannerDiagnosis).toBeNull()
    expect(recovered.notifyReconnect).toBe(false)
    expect(recovered.state).toEqual(initialHysteresisState)
  })

  test("an outage longer than the notify threshold fires notify on recovery", () => {
    const t0 = 1_000
    const first = step(initialHysteresisState, OFFLINE, t0)
    const recovered = step(first.state, null, t0 + NOTIFY_ON_RECONNECT_MS + 1)
    expect(recovered.notifyReconnect).toBe(true)
    expect(recovered.state).toEqual(initialHysteresisState)
  })

  test("notify fires on the recovery TRANSITION only, not on the next healthy tick", () => {
    const t0 = 1_000
    const first = step(initialHysteresisState, OFFLINE, t0)
    const recovered = step(first.state, null, t0 + NOTIFY_ON_RECONNECT_MS + 1)
    expect(recovered.notifyReconnect).toBe(true)
    // A subsequent null tick has no outage to recover from.
    const stillHealthy = step(recovered.state, null, t0 + 999_999)
    expect(stillHealthy.notifyReconnect).toBe(false)
  })

  test("recovery from no prior outage never notifies", () => {
    const r = step(initialHysteresisState, null, 5_000)
    expect(r.notifyReconnect).toBe(false)
    expect(r.state).toEqual(initialHysteresisState)
  })
})

// --- Singleton wrapper ----------------------------------------------------

describe("advanceHysteresis — shared singleton", () => {
  beforeEach(() => __resetHysteresisForTests())
  afterEach(() => __resetHysteresisForTests())

  test("carries state across calls and promotes past onset", () => {
    const t0 = 10_000
    expect(advanceHysteresis(OFFLINE, t0).bannerDiagnosis).toBeNull()
    expect(getHysteresisState().firstFailureAt).toBe(t0)
    const shown = advanceHysteresis(OFFLINE, t0 + NETWORK_BANNER_ONSET_MS)
    expect(shown.bannerDiagnosis).toEqual(OFFLINE)
  })

  test("__resetForTests returns to the initial state", () => {
    advanceHysteresis(OFFLINE, 1)
    __resetHysteresisForTests()
    expect(getHysteresisState()).toEqual(initialHysteresisState)
  })
})

// --- State feed: compare-then-emit ----------------------------------------

describe("setNetworkDiagnosis / clearNetworkDiagnosis", () => {
  beforeEach(() => {
    state.networkDiagnosis = undefined
  })
  afterEach(() => {
    state.networkDiagnosis = undefined
  })

  test("sets the typed { kind, scope } and a null argument clears", () => {
    setNetworkDiagnosis({
      kind: NETWORK_DIAGNOSIS_KIND.offline,
      scope: NETWORK_SCOPE.githubCopilotAuth,
    })
    expect(state.networkDiagnosis).toEqual({
      kind: NETWORK_DIAGNOSIS_KIND.offline,
      scope: NETWORK_SCOPE.githubCopilotAuth,
    })
    setNetworkDiagnosis(null)
    expect(state.networkDiagnosis).toBeUndefined()
  })

  test("clearNetworkDiagnosis is safe when nothing is set", () => {
    state.networkDiagnosis = undefined
    clearNetworkDiagnosis()
    expect(state.networkDiagnosis).toBeUndefined()
  })
})

// --- Wired seam: getAuthStatus propagation --------------------------------
//
// auth-controller pulls in several sibling modules at import; mock them at
// module scope before the dynamic import (the exact pattern in
// tests/last-upstream-rejection.test.ts), restored in afterAll so the stubs
// don't leak into later files in the same `bun test` run. The dynamic import
// registers the auth-status projector, so `setNetworkDiagnosis` reaches a real
// emit — the production wiring, not a re-plumbed parallel.

const realGetDeviceCodeModule =
  await import("~/services/github/get-device-code")
const realGetUserModule = await import("~/services/github/get-user")
const realTokenModule = await import("~/lib/auth/token")
const realFsPromisesModule = await import("node:fs/promises")

await mock.module("~/services/github/get-device-code", () => ({
  getDeviceCode: () =>
    Promise.resolve({
      device_code: "device-xyz",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    }),
}))

await mock.module("~/services/github/get-user", () => ({
  getGitHubUser: () => Promise.resolve({ login: "octocat" }),
}))

await mock.module("~/lib/auth/token", () => ({
  ...realTokenModule,
  setupCopilotToken: () => Promise.resolve(),
}))

await mock.module("node:fs/promises", () => ({
  ...realFsPromisesModule,
  default: {
    ...(realFsPromisesModule as { default: object }).default,
    unlink: () => Promise.resolve(),
  },
  unlink: () => Promise.resolve(),
}))

afterAll(async () => {
  await mock.module(
    "~/services/github/get-device-code",
    () => realGetDeviceCodeModule,
  )
  await mock.module("~/services/github/get-user", () => realGetUserModule)
  await mock.module("~/lib/auth/token", () => realTokenModule)
  await mock.module("node:fs/promises", () => realFsPromisesModule)
})

const { getAuthStatus, signOut, markSignedIn, __resetAuthControllerForTests } =
  await import("~/lib/auth/auth-controller")

describe("getAuthStatus + network_diagnosis / account_type", () => {
  beforeEach(() => {
    __resetAuthControllerForTests()
    state.githubToken = undefined
    state.copilotToken = undefined
    state.userName = undefined
    state.accountType = "individual"
    state.networkDiagnosis = undefined
  })

  afterEach(() => {
    __resetAuthControllerForTests()
    state.githubToken = undefined
    state.copilotToken = undefined
    state.userName = undefined
    state.accountType = "individual"
    state.networkDiagnosis = undefined
  })

  test("authenticated state surfaces network_diagnosis + the resolved account_type", () => {
    markSignedIn("alice")
    state.accountType = "enterprise"
    setNetworkDiagnosis({
      kind: NETWORK_DIAGNOSIS_KIND.scopeUnreachable,
      scope: NETWORK_SCOPE.githubCopilotAuth,
    })

    const status = getAuthStatus()
    if (status.state !== "authenticated") {
      throw new Error(`expected authenticated, got ${status.state}`)
    }
    expect(status.account_login).toBe("alice")
    expect(status.account_type).toBe("enterprise")
    expect(status.network_diagnosis).toEqual({
      kind: NETWORK_DIAGNOSIS_KIND.scopeUnreachable,
      scope: NETWORK_SCOPE.githubCopilotAuth,
    })
  })

  test("network_diagnosis rides the unauthenticated state so the banner works signed-out", () => {
    setNetworkDiagnosis({
      kind: NETWORK_DIAGNOSIS_KIND.offline,
      scope: NETWORK_SCOPE.githubCopilotAuth,
    })

    const status = getAuthStatus()
    expect(status.state).toBe("unauthenticated")
    if (status.state !== "unauthenticated") throw new Error("unreachable")
    expect(status.network_diagnosis).toEqual({
      kind: NETWORK_DIAGNOSIS_KIND.offline,
      scope: NETWORK_SCOPE.githubCopilotAuth,
    })
  })

  test("omits network_diagnosis entirely when connectivity is healthy", () => {
    markSignedIn("alice")
    state.networkDiagnosis = undefined

    const status = getAuthStatus()
    expect(status).not.toHaveProperty("network_diagnosis")
  })

  test("account_type is present (nullable contract) even with no network issue", () => {
    markSignedIn("alice")

    const status = getAuthStatus()
    if (status.state !== "authenticated") throw new Error("unreachable")
    // The wire contract is `account_type: AccountType | null` — always present
    // on the authenticated variant, defaulting to the resolved plan.
    expect(status.account_type).toBe("individual")
  })

  test("signOut clears the network-diagnosis sidecar", async () => {
    markSignedIn("alice")
    setNetworkDiagnosis({
      kind: NETWORK_DIAGNOSIS_KIND.offline,
      scope: NETWORK_SCOPE.githubCopilotAuth,
    })

    await signOut()

    expect(state.networkDiagnosis).toBeUndefined()
    const status = getAuthStatus()
    expect(status).not.toHaveProperty("network_diagnosis")
  })
})
