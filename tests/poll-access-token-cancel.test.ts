import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"

/**
 * Cancellation semantics for the device-code poll: an aborted flow must stop the
 * loop promptly instead of running to the self-expiry deadline. `sleep`/
 * `abortableSleep` are stubbed to no-ops (as in tests/poll-access-token.test.ts)
 * so the loop's control flow is exercised deterministically; the cancel is
 * driven from the fetch stub (synchronously), not a wall-clock timer, so the
 * test can't depend on macrotask scheduling.
 */
const realUtils = await import("~/lib/platform/utils")
await mock.module("~/lib/platform/utils", () => ({
  ...realUtils,
  sleep: () => Promise.resolve(),
  abortableSleep: () => Promise.resolve(),
}))
afterAll(async () => {
  await mock.module("~/lib/platform/utils", () => realUtils)
})

const { pollAccessToken } = await import("~/services/github/poll-access-token")
const { DeviceCodeResponseSchema } =
  await import("~/services/github/get-device-code")

const deviceCode = DeviceCodeResponseSchema.parse({
  device_code: "dev-123",
  user_code: "WXYZ-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
})

async function rejection(p: Promise<unknown>): Promise<Error | undefined> {
  try {
    await p
  } catch (err) {
    return err as Error
  }
  return undefined
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe("pollAccessToken cancellation", () => {
  test("an already-aborted signal rejects with AbortError and never polls", async () => {
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      return Promise.resolve(new Response("{}", { status: 200 }))
    }) as unknown as typeof fetch

    const c = new AbortController()
    c.abort()

    const err = await rejection(pollAccessToken(deviceCode, c.signal))
    expect(err?.name).toBe("AbortError")
    expect(calls).toBe(0)
  })

  test("a cancel during polling stops the loop promptly (no run to deadline)", async () => {
    // authorization_pending would otherwise loop until the ~900s deadline.
    const c = new AbortController()
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      if (calls >= 3) c.abort() // the flow is cancelled after a few polls
      return Promise.resolve(
        new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 200,
        }),
      )
    }) as unknown as typeof fetch

    const err = await rejection(pollAccessToken(deviceCode, c.signal))
    expect(err?.name).toBe("AbortError")
    // Stops within one iteration of the abort — not the hundreds it would take
    // to reach the deadline.
    expect(calls).toBeLessThanOrEqual(4)
  })
})
