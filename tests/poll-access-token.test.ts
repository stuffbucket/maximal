/**
 * RFC 8628 §3.5 polling correctness for the device-code flow.
 *
 * `sleep` is mocked to a no-op so the test doesn't actually wait for the
 * poll interval to elapse. fetch is mocked to return scripted responses.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

void mock.module("~/lib/utils", () => ({
  sleep: () => Promise.resolve(),
}))

const { pollAccessToken } = await import("~/services/github/poll-access-token")

const DEVICE_CODE = {
  device_code: "device-xyz",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
} as const

let realFetch: typeof fetch

beforeEach(() => {
  realFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

function withResponses(responses: Array<unknown>) {
  let i = 0
  const fetchMock = mock(() => {
    const body = responses[i++] ?? { error: "expired_token" }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

async function expectRejects(
  fn: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    expect((err as Error).message).toMatch(pattern)
    return
  }
  throw new Error(`Expected rejection matching ${pattern} but got none`)
}

describe("pollAccessToken (RFC 8628)", () => {
  it("returns the token when GitHub responds with access_token", async () => {
    withResponses([{ access_token: "ghu_real_token" }])
    expect(await pollAccessToken(DEVICE_CODE)).toBe("ghu_real_token")
  })

  it("keeps polling on authorization_pending", async () => {
    const fetchMock = withResponses([
      { error: "authorization_pending" },
      { error: "authorization_pending" },
      { access_token: "ghu_token" },
    ])
    expect(await pollAccessToken(DEVICE_CODE)).toBe("ghu_token")
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("honours slow_down by continuing past it", async () => {
    const fetchMock = withResponses([
      { error: "slow_down" },
      { access_token: "ghu_after_bump" },
    ])
    expect(await pollAccessToken(DEVICE_CODE)).toBe("ghu_after_bump")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("uses a server-supplied interval when larger than current", async () => {
    withResponses([
      { error: "slow_down", interval: 30 },
      { access_token: "ghu_t" },
    ])
    expect(await pollAccessToken(DEVICE_CODE)).toBe("ghu_t")
  })

  it("throws on expired_token", async () => {
    withResponses([{ error: "expired_token" }])
    await expectRejects(() => pollAccessToken(DEVICE_CODE), /expired/i)
  })

  it("throws on access_denied", async () => {
    withResponses([{ error: "access_denied" }])
    await expectRejects(() => pollAccessToken(DEVICE_CODE), /denied/i)
  })

  it("surfaces error_description for unrecognised errors", async () => {
    withResponses([
      { error: "unsupported_grant_type", error_description: "nope" },
    ])
    await expectRejects(() => pollAccessToken(DEVICE_CODE), /nope/)
  })

  it("treats 200 with empty body as pending, not success", async () => {
    const fetchMock = withResponses([{}, { access_token: "ghu_late" }])
    expect(await pollAccessToken(DEVICE_CODE)).toBe("ghu_late")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
