/**
 * HTTP contract tests for /auth/start and /auth/poll.
 *
 * See docs/first-run-setup-prd.md, "HTTP contract".
 *
 * We point `COPILOT_API_HOME` at a tmp dir BEFORE importing server.ts
 * so the real `github-token-store` writes happen against an
 * isolated location, and stub global fetch to script GitHub's
 * device-code + access-token endpoints. clipboardy is stubbed to a
 * no-op (headless CI has no clipboard).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-auth-route-"))
process.env.COPILOT_API_HOME = tmpHome
// Default AUTH_APP is empty, so the github_token lives at the top of
// APP_DIR. The dir itself already exists from mkdtempSync.
delete process.env.COPILOT_API_OAUTH_APP

// clipboardy throws on headless CI; stub it.
void mock.module("clipboardy", () => ({
  default: { writeSync: () => {} },
}))

const { server } = await import("~/server")
const { PATHS } = await import("~/lib/paths")
const { _setSessionForTests, clearDeviceAuthSession } =
  await import("~/lib/device-auth")

let realFetch: typeof fetch

beforeEach(() => {
  realFetch = globalThis.fetch
  // Wipe any token file left from the prior test.
  fs.rmSync(PATHS.GITHUB_TOKEN_PATH, { force: true })
  clearDeviceAuthSession()
})

afterEach(() => {
  globalThis.fetch = realFetch
  clearDeviceAuthSession()
})

function scriptedFetch(handlers: {
  deviceCode?: () => unknown
  accessToken?: Array<unknown>
  user?: () => unknown
}): ReturnType<typeof mock> {
  const accessTokenQueue = [...(handlers.accessToken ?? [])]
  const fn = mock((input: string | URL | Request) => {
    let url: string
    if (typeof input === "string") {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else {
      url = input.url
    }
    if (url.includes("/login/device/code")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(handlers.deviceCode?.() ?? { error: "no_handler" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    }
    if (url.includes("/login/oauth/access_token")) {
      const body = accessTokenQueue.shift() ?? {
        error: "authorization_pending",
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }
    if (url.endsWith("/user")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(handlers.user?.() ?? { login: "octocat" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    }
    return Promise.resolve(new Response("not mocked", { status: 500 }))
  })
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

const DEVICE_CODE_OK = {
  device_code: "device-xyz",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
}

describe("POST /auth/start", () => {
  test("returns device-code envelope on happy path", async () => {
    scriptedFetch({ deviceCode: () => DEVICE_CODE_OK })

    const res = await server.request("/auth/start", { method: "POST" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      verification_uri: string
      user_code: string
      expires_in: number
      interval: number
      device_code: string
    }
    expect(body.user_code).toBe("ABCD-1234")
    expect(body.verification_uri).toBe("https://github.com/login/device")
    expect(body.device_code).toBe("device-xyz")
    expect(body.expires_in).toBe(900)
    expect(body.interval).toBe(5)
  })

  test("returns 409 when token on disk validates against /user", async () => {
    fs.writeFileSync(
      PATHS.GITHUB_TOKEN_PATH,
      JSON.stringify({
        schemaVersion: 1,
        tokenType: "ghu_",
        accessToken: "ghu_already_have_one",
        refreshToken: null,
        obtainedAt: "2026-05-12T00:00:00.000Z",
      }),
    )
    scriptedFetch({ user: () => ({ login: "octocat" }) })

    const res = await server.request("/auth/start", { method: "POST" })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("already_authenticated")
  })

  test("clears stale token and starts fresh when /user rejects it", async () => {
    fs.writeFileSync(
      PATHS.GITHUB_TOKEN_PATH,
      JSON.stringify({
        schemaVersion: 1,
        tokenType: "ghu_",
        accessToken: "ghu_revoked",
        refreshToken: null,
        obtainedAt: "2026-05-12T00:00:00.000Z",
      }),
    )
    // /user returns 401 → stale token; the route should drop it and
    // proceed with a fresh device-code session.
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : (input as Request).url
      if (url.endsWith("/user")) {
        return Promise.resolve(new Response("unauth", { status: 401 }))
      }
      if (url.includes("/login/device/code")) {
        return Promise.resolve(
          new Response(JSON.stringify(DEVICE_CODE_OK), { status: 200 }),
        )
      }
      return Promise.resolve(new Response("not mocked", { status: 500 }))
    }) as unknown as typeof fetch

    const res = await server.request("/auth/start", { method: "POST" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_code: string }
    expect(body.user_code).toBe("ABCD-1234")
    expect(fs.existsSync(PATHS.GITHUB_TOKEN_PATH)).toBe(false)
  })

  test("returns 5xx on upstream failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("nope", { status: 503 })),
    ) as unknown as typeof fetch

    const res = await server.request("/auth/start", { method: "POST" })
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/upstream|github/i)
  })
})

describe("GET /auth/poll", () => {
  test("404 when no /auth/start has been called", async () => {
    const res = await server.request("/auth/poll")
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: string }).toEqual({
      error: "no_pending_auth",
    })
  })

  test("pending → ready transition writes the token and returns username", async () => {
    scriptedFetch({
      deviceCode: () => DEVICE_CODE_OK,
      accessToken: [
        { error: "authorization_pending" },
        { access_token: "ghu_real_token", token_type: "bearer" },
      ],
      user: () => ({ login: "stuffbucket" }),
    })

    const start = await server.request("/auth/start", { method: "POST" })
    expect(start.status).toBe(200)

    const pending = await server.request("/auth/poll")
    expect(pending.status).toBe(200)
    const pendingBody = (await pending.json()) as {
      status: string
      expires_in: number
    }
    expect(pendingBody.status).toBe("pending")
    expect(typeof pendingBody.expires_in).toBe("number")

    const ready = await server.request("/auth/poll")
    expect(ready.status).toBe(200)
    const readyBody = (await ready.json()) as {
      status: string
      username: string
    }
    expect(readyBody.status).toBe("ready")
    expect(readyBody.username).toBe("stuffbucket")

    // Token persisted to disk.
    const written = fs.readFileSync(PATHS.GITHUB_TOKEN_PATH, "utf8")
    expect(written).toContain("ghu_real_token")
  })

  test("expired device code surfaces status=expired", async () => {
    // Seed a session manually with a startedAt far in the past so the
    // remaining time is zero. This is the path the handler takes
    // without ever needing to hit the network.
    _setSessionForTests({
      deviceCode: "expired-device",
      userCode: "DEAD-BEEF",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: undefined,
      expiresIn: 1,
      startedAtMs: Date.now() - 60_000,
      interval: 5,
      copiedToClipboard: false,
    })

    const res = await server.request("/auth/poll")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe("expired")
  })

  test("upstream access_denied surfaces status=error and clears session", async () => {
    scriptedFetch({
      deviceCode: () => DEVICE_CODE_OK,
      accessToken: [{ error: "access_denied" }],
    })

    await server.request("/auth/start", { method: "POST" })
    const denied = await server.request("/auth/poll")
    expect(denied.status).toBe(200)
    const body = (await denied.json()) as { status: string; reason: string }
    expect(body.status).toBe("error")
    expect(body.reason).toMatch(/denied/)

    // Session cleared: next poll is a 404.
    const next = await server.request("/auth/poll")
    expect(next.status).toBe(404)
  })
})
