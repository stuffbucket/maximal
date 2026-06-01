/**
 * forwardError's CopilotAuthFatalError branch — clears the token,
 * stashes the rejection reason, and emits an auth_fatal envelope.
 *
 * Lives in its own file because exercising forwardError on a
 * CopilotAuthFatalError eventually reaches signOut() →
 * fs.unlink(PATHS.GITHUB_TOKEN_PATH), which on a dev machine with a
 * signed-in maximal install would silently delete the user's real
 * token file. We stub node:fs/promises via mock.module at module
 * load to neutralize that side effect. The dynamic-import dance is
 * required because Bun's mock.module hoisting happens AFTER static
 * imports, and once paths.ts has resolved unlink to the real fn,
 * later module-level mocks don't rewrite the captured reference.
 */

import { afterAll, describe, expect, mock, test } from "bun:test"

// Capture the real module BEFORE mocking so afterAll can restore it
// (mock.module is process-wide; without the restore, a later test
// file in the same `bun test` process gets our stub).
const realFsPromisesModule = await import("node:fs/promises")
const unlinkCalls: Array<string> = []
void mock.module("node:fs/promises", () => ({
  ...realFsPromisesModule,
  default: {
    ...(realFsPromisesModule as { default: object }).default,
    unlink: (p: string) => {
      unlinkCalls.push(p)
      return Promise.resolve()
    },
  },
  unlink: (p: string) => {
    unlinkCalls.push(p)
    return Promise.resolve()
  },
}))
afterAll(() => {
  void mock.module("node:fs/promises", () => realFsPromisesModule)
})

const errorMod = await import("~/lib/error")
const { CopilotAuthFatalError, forwardError, HTTPError } = errorMod
const stateMod = await import("~/lib/state")
const { state } = stateMod

interface CapturedResponse {
  body: unknown
  status: number
  headers: Record<string, string>
}

function makeContextStub(): {
  ctx: {
    json: (body: unknown, status?: number) => Response
    header: (name: string, value: string) => void
  }
  captured: CapturedResponse
} {
  const captured: CapturedResponse = {
    body: undefined,
    status: 0,
    headers: {},
  }
  const ctx = {
    json(body: unknown, status?: number): Response {
      captured.body = body
      captured.status = status ?? 200
      return new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      })
    },
    header(name: string, value: string): void {
      captured.headers[name] = value
    },
  }
  return { ctx, captured }
}

describe("forwardError", () => {
  test("CopilotAuthFatalError: clears githubToken and returns auth_fatal body", async () => {
    state.githubToken = "gho_pretend_real"
    const { ctx, captured } = makeContextStub()
    const error = new CopilotAuthFatalError(
      "tos",
      403,
      "https://github.com/site/terms",
    )

    const response = await forwardError(
      ctx as unknown as Parameters<typeof forwardError>[0],
      error,
    )

    expect(state.githubToken).toBeUndefined()
    expect(captured.status).toBe(403)
    expect(response.status).toBe(403)
    expect(captured.body).toEqual({
      error: {
        message: "tos",
        type: "auth_fatal",
        remediation_url: "https://github.com/site/terms",
      },
    })
  })

  test("CopilotAuthFatalError without remediation URL: omits remediation_url field", async () => {
    state.githubToken = "gho_pretend_real"
    const { ctx, captured } = makeContextStub()
    const error = new CopilotAuthFatalError("subscription_lapsed", 401, null)

    await forwardError(
      ctx as unknown as Parameters<typeof forwardError>[0],
      error,
    )

    expect(state.githubToken).toBeUndefined()
    expect(captured.status).toBe(401)
    expect(captured.body).toEqual({
      error: {
        message: "subscription_lapsed",
        type: "auth_fatal",
      },
    })
  })

  test("HTTPError: leaves githubToken untouched and forwards upstream status", async () => {
    state.githubToken = "gho_pretend_real"
    const { ctx, captured } = makeContextStub()
    const upstream = new Response("nope", { status: 429 })
    const error = new HTTPError("nope", upstream)

    const response = await forwardError(
      ctx as unknown as Parameters<typeof forwardError>[0],
      error,
    )

    expect(state.githubToken).toBe("gho_pretend_real")
    expect(captured.status).toBe(429)
    expect(response.status).toBe(429)
    expect((captured.body as { error: { type: string } }).error.type).toBe(
      "error",
    )
  })
})
