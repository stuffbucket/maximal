/**
 * Unit tests for src/lib/auth/copilot-online-retry.ts — the self-healing
 * background retry that recovers from a transient FIRST Copilot-token mint
 * failure (the gap that used to wedge the app tokenless until a manual
 * restart). Drives the test-only DI hooks so setupCopilotToken / cacheModels
 * are observed without real network.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { CopilotAuthFatalError, HTTPError } from "~/lib/errors/error"
import { state } from "~/lib/runtime-state/state"

// See token-auth-fatal.test.ts for why a `?nomock` specifier is used: sibling
// files install process-wide module mocks whose afterAll restore is unreliable
// across files in one `bun test` process, so a distinct registry key resolving
// to the same source keeps this file on the real module.
const spec = "../src/lib/auth/copilot-online-retry.ts?nomock=online-retry"
const mod = (await import(
  spec
)) as typeof import("~/lib/auth/copilot-online-retry")
const {
  __resetOnlineRetryDepsForTests,
  __setOnlineRetryDepsForTests,
  scheduleCopilotOnlineRetry,
  stopCopilotOnlineRetry,
} = mod

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

const harness = {
  setupCalls: 0,
  setupQueue: [] as Array<() => Promise<void>>,
  setupImpl: (): Promise<void> => Promise.resolve(),
  cacheCalls: 0,
  cacheImpl: (): Promise<void> => Promise.resolve(),
  onOnlineCalls: 0,
}

beforeEach(() => {
  harness.setupCalls = 0
  harness.setupQueue = []
  harness.setupImpl = () => Promise.resolve()
  harness.cacheCalls = 0
  harness.cacheImpl = () => Promise.resolve()
  harness.onOnlineCalls = 0
  state.githubToken = "ghu_test"

  __setOnlineRetryDepsForTests({
    setupCopilotToken: () => {
      harness.setupCalls++
      const next = harness.setupQueue.shift()
      if (next) return next()
      return harness.setupImpl()
    },
    cacheModels: () => {
      harness.cacheCalls++
      return harness.cacheImpl()
    },
  })
})

afterEach(() => {
  stopCopilotOnlineRetry()
  __resetOnlineRetryDepsForTests()
  state.githubToken = undefined
})

describe("scheduleCopilotOnlineRetry — recovery after transient failure", () => {
  test("keeps retrying until the mint succeeds, then caches models and fires onOnline once", async () => {
    const httpErr = new HTTPError("502", new Response(null, { status: 502 }))
    // First scheduled attempt fails transiently; second succeeds.
    harness.setupQueue = [
      () => Promise.reject(httpErr),
      () => Promise.resolve(),
    ]

    scheduleCopilotOnlineRetry({
      retryDelayMs: 10,
      onOnline: () => {
        harness.onOnlineCalls++
      },
    })

    // Two 10ms ticks + slack for the second attempt to resolve.
    await tick(60)
    stopCopilotOnlineRetry()

    expect(harness.setupCalls).toBe(2)
    expect(harness.cacheCalls).toBe(1)
    expect(harness.onOnlineCalls).toBe(1)
  })
})

describe("scheduleCopilotOnlineRetry — auth-fatal mint stops the loop", () => {
  test("a CopilotAuthFatalError ends the loop without further attempts or onOnline", async () => {
    const fatal = new CopilotAuthFatalError("no_license", 403, null)
    harness.setupImpl = () => Promise.reject(fatal)

    scheduleCopilotOnlineRetry({
      retryDelayMs: 10,
      onOnline: () => {
        harness.onOnlineCalls++
      },
    })

    await tick(60)

    // Exactly one attempt, then stop — no retry storm on a genuinely bad cred.
    expect(harness.setupCalls).toBe(1)
    expect(harness.onOnlineCalls).toBe(0)
  })
})

describe("scheduleCopilotOnlineRetry — abandons when the GitHub token is gone", () => {
  test("stops without minting once the credential is cleared (sign-out)", async () => {
    state.githubToken = undefined

    scheduleCopilotOnlineRetry({ retryDelayMs: 10 })
    await tick(40)

    expect(harness.setupCalls).toBe(0)
  })
})

describe("scheduleCopilotOnlineRetry — is single-flight", () => {
  test("scheduling again aborts the prior loop so attempts don't stack", async () => {
    harness.setupImpl = () =>
      Promise.reject(new HTTPError("502", new Response(null, { status: 502 })))

    scheduleCopilotOnlineRetry({ retryDelayMs: 10 })
    // Immediately reschedule; the first loop's controller is aborted.
    scheduleCopilotOnlineRetry({ retryDelayMs: 10 })

    await tick(35)
    stopCopilotOnlineRetry()

    // Only the second loop advances; a stacked pair would roughly double this.
    expect(harness.setupCalls).toBeLessThanOrEqual(3)
  })
})

describe("stopCopilotOnlineRetry — clean teardown mid-wait", () => {
  test("aborting while parked in the delay raises no unhandled rejection", async () => {
    harness.setupImpl = () => Promise.resolve()

    const rejections: Array<unknown> = []
    const onUnhandled = (err: unknown): void => {
      rejections.push(err)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      scheduleCopilotOnlineRetry({ retryDelayMs: 10_000 })
      // Parked in the long wait; abort it.
      stopCopilotOnlineRetry()
      await tick(30)
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})
