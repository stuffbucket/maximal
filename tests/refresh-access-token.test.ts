/**
 * Unit tests for src/services/github/refresh-access-token.ts — the OAuth
 * `refresh_token` grant that renews an expired `ghu_` access token. The network
 * layer is stubbed via a locally-swapped global fetch (restored in afterEach so
 * it can't leak into a sibling file).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

const { refreshAccessToken } =
  await import("~/services/github/refresh-access-token")

let realFetch: typeof fetch

beforeEach(() => {
  realFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Assert an async fn rejects with a message matching `pattern`. Avoids the
 *  `.rejects.toThrow` form (which trips await-thenable typing here). */
async function expectRejects(
  fn: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let err: unknown
  try {
    await fn()
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(Error)
  expect((err as Error).message).toMatch(pattern)
}

function stubFetchJson(body: unknown, status = 200): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof fetch
}

describe("refreshAccessToken", () => {
  it("returns the renewed token, the ROTATED refresh token, and expiries", async () => {
    stubFetchJson({
      access_token: "ghu_new",
      refresh_token: "ghr_rotated",
      expires_in: 28800,
      refresh_token_expires_in: 15897600,
    })
    const r = await refreshAccessToken("ghr_old")
    expect(r.accessToken).toBe("ghu_new")
    // GitHub rotates the refresh token; callers must persist the NEW one.
    expect(r.refreshToken).toBe("ghr_rotated")
    expect(r.accessTokenExpiresAt).toBeGreaterThan(Date.now())
    expect(r.refreshTokenExpiresAt).toBeGreaterThan(r.accessTokenExpiresAt ?? 0)
  })

  it("throws when the grant is rejected (error body, no access_token)", async () => {
    stubFetchJson({
      error: "bad_refresh_token",
      error_description: "The refresh token has expired.",
    })
    await expectRejects(
      () => refreshAccessToken("ghr_expired"),
      /refresh token has expired|bad_refresh_token/i,
    )
  })

  it("throws on a non-JSON response", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("<html>gateway</html>", { status: 502 }),
      )) as unknown as typeof fetch
    await expectRejects(() => refreshAccessToken("ghr_x"), /non-JSON/i)
  })
})
