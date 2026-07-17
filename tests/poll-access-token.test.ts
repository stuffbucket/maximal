/**
 * RFC 8628 §3.5 polling correctness for the device-code flow.
 *
 * `sleep`/`abortableSleep` are mocked to no-ops so the test doesn't actually
 * wait for the poll interval to elapse. fetch is mocked to return scripted
 * responses.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test"

// Spread the real module so this stub doesn't strip `~/lib/platform/utils`'s other
// exports for sibling files, and restore it in an awaited afterAll so it can't
// leak forward (Bun keeps module mocks for the whole `bun test` process).
const realUtilsModule = await import("~/lib/platform/utils")
await mock.module("~/lib/platform/utils", () => ({
  ...realUtilsModule,
  sleep: () => Promise.resolve(),
  abortableSleep: () => Promise.resolve(),
}))
afterAll(async () => {
  await mock.module("~/lib/platform/utils", () => realUtilsModule)
})

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

  it("self-expires once the device code's lifetime has elapsed, without polling", async () => {
    // A perpetually-pending upstream would loop forever; the deadline guard
    // (deviceCode.expires_in) must terminate `polling` on its own. With an
    // already-elapsed lifetime, it throws before the first fetch.
    const fetchMock = withResponses([{ error: "authorization_pending" }])
    await expectRejects(
      () => pollAccessToken({ ...DEVICE_CODE, expires_in: 0 }),
      /expired_token/,
    )
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  it("gives up after repeated transport failures instead of polling forever", async () => {
    // A persistently-unreachable network can't complete the flow. It must
    // terminate (and, when the failure is instantaneous — as under a stubbed
    // fetch — never spin), not retry until the code expires.
    const fetchMock = mock(() => Promise.reject(new Error("network down")))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expectRejects(
      () => pollAccessToken(DEVICE_CODE),
      /network unreachable/,
    )
    // Bounded: MAX_CONSECUTIVE_TRANSPORT_ERRORS attempts, then throw.
    expect(fetchMock).toHaveBeenCalledTimes(12)
  })

  it("does not hot-loop or run unbounded when interval/expires_in are missing", async () => {
    // A malformed device-code response — no `interval` (would make sleep(NaN) a
    // zero-delay spin) and no `expires_in` (would make the deadline NaN and
    // never fire) — must still terminate. With a failing transport it exits via
    // the consecutive-error cap rather than hanging.
    const malformed = {
      device_code: "device-xyz",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
    } as unknown as typeof DEVICE_CODE
    const fetchMock = mock(() => Promise.reject(new Error("network down")))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expectRejects(() => pollAccessToken(malformed), /network unreachable/)
    expect(fetchMock).toHaveBeenCalledTimes(12)
  })

  it("retries a transient transport error and then succeeds", async () => {
    // A single dropped request must not abort the flow — the poll retries and
    // completes once the transport recovers (the failure streak resets on any
    // response), so a brief blip doesn't cost the user their sign-in.
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      if (calls === 1) return Promise.reject(new Error("blip"))
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: "ghu_recovered" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    expect(await pollAccessToken(DEVICE_CODE)).toBe("ghu_recovered")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
