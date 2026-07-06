/**
 * forwardError's CopilotAuthFatalError branch — degrades NON-DESTRUCTIVELY:
 * drops the live in-memory token, stashes the rejection reason, emits an
 * auth_fatal envelope, and flags the active account needs-reauth — but RETAINS
 * the on-disk credential (it does NOT unlink the token file or remove the
 * account). The old behaviour ran signOut()+unlink here; these tests guard that
 * a transient completion 401 can never delete the saved credential.
 *
 * Registry/token paths are isolated to a temp COPILOT_API_HOME by the global
 * test preload (tests/test-setup.ts), so the real registry is never touched. We
 * still stub fs.unlink so an assertion can prove it is never called on the
 * token path.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"

// Capture the real module BEFORE mocking so afterAll can restore it
// (mock.module is process-wide; without the restore, a later test
// file in the same `bun test` process gets our stub).
const realFsPromisesModule = await import("node:fs/promises")
const unlinkCalls: Array<string> = []
await mock.module("node:fs/promises", () => ({
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
afterAll(async () => {
  await mock.module("node:fs/promises", () => realFsPromisesModule)
})

const errorMod = await import("~/lib/error")
const { CopilotAuthFatalError, forwardError, HTTPError } = errorMod
const stateMod = await import("~/lib/state")
const { state } = stateMod
const { PATHS } = await import("~/lib/paths")
const {
  accountKey,
  addAccountToDefaultRegistry,
  emptyRegistry,
  makeAccountRecord,
  readDefaultRegistry,
  writeDefaultRegistry,
} = await import("~/lib/github-token-store")
const { __resetAuthControllerForTests } = await import("~/lib/auth-controller")

beforeEach(async () => {
  // Reset the auth state machine (so markAuthDegraded's idempotency guard
  // doesn't dedupe across cases) and the temp registry between tests.
  __resetAuthControllerForTests()
  await writeDefaultRegistry(emptyRegistry())
  unlinkCalls.length = 0
  state.githubToken = undefined
})

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

  test("CopilotAuthFatalError RETAINS the account — flags needs-reauth, never unlinks or removes", async () => {
    // Seed an active account in the (temp-isolated) registry.
    await addAccountToDefaultRegistry(
      makeAccountRecord({
        login: "alice",
        host: "github.com",
        token: "ghu_seed_credential",
        addedVia: "device-code",
      }),
    )
    state.githubToken = "ghu_seed_credential"
    const { ctx } = makeContextStub()

    await forwardError(
      ctx as unknown as Parameters<typeof forwardError>[0],
      new CopilotAuthFatalError("revoked", 401, null),
    )

    const reg = await readDefaultRegistry()
    const key = accountKey("alice", "github.com")
    // The credential is RETAINED — the bug was deleting it here.
    expect(key in reg.accounts).toBe(true)
    expect(reg.accounts[key].token).toBe("ghu_seed_credential")
    expect(reg.accounts[key].needsReauth).toBe(true)
    expect(reg.accounts[key].lastError?.status).toBe(401)
    // The token file is never unlinked on an upstream rejection.
    expect(unlinkCalls).not.toContain(PATHS.GITHUB_TOKEN_PATH)
    // Live in-memory token is still dropped (fail fast).
    expect(state.githubToken).toBeUndefined()
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
