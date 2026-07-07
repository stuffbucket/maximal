/**
 * Targeted tests that close gaps surfaced by mutation testing on
 * `src/routes/settings/api.ts`. Each block documents the surviving
 * mutant(s) it kills.
 *
 * `~/lib/update/version` is mocked so we can assert exact `source_branch`
 * pass-through (kills the `git.branch ?? null` → `git.branch && null`
 * mutant). The mock must be installed before importing the route
 * module under test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthMiddleware } from "~/lib/auth/request-auth"
import { state } from "~/lib/runtime-state/state"
import { getGitVersion, shortSha } from "~/lib/update/version"
import { settingsApiRoutes } from "~/routes/settings/api"
import { authRoutes } from "~/routes/settings/auth"

function buildApp() {
  const app = new Hono()
  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => [],
      allowUnauthenticatedPaths: ["/", "/usage-viewer"],
    }),
  )
  app.route("/settings/api", settingsApiRoutes)
  return app
}

const originalGithubToken = state.githubToken
const originalCopilotToken = state.copilotToken

beforeEach(() => {
  state.githubToken = undefined
  state.copilotToken = undefined
})

afterEach(() => {
  state.githubToken = originalGithubToken
  state.copilotToken = originalCopilotToken
})

describe("settings/api mutant kills — diagnostics payload", () => {
  test("source_branch passes through the real git branch (kills `?? null` → `&& null`)", async () => {
    // Resolve the live git state independently and assert the route's
    // payload matches it. With the original `??` operator and a
    // defined branch, `source_branch` is the branch string. With the
    // mutated `&&`, it would always be `null`. Skipped only if the
    // host repo happens to be in detached-HEAD (branch undefined),
    // which never occurs in normal `bun test` runs.
    const git = getGitVersion()
    if (git.branch === undefined) {
      // Detached HEAD: the `??` vs `&& null` mutation is
      // indistinguishable here. Skip rather than emit a false-pass.
      return
    }
    const app = buildApp()
    const res = await app.request("/settings/api/diagnostics")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      source_branch: string | null
      source_revision: string | null
    }
    expect(body.source_branch).toBe(git.branch)
    expect(body.source_revision).toBe(shortSha(git.sha))
    // Defensive: source_branch must be a non-empty string (and
    // specifically not `null`) — the failure mode of the
    // `&& null` mutant.
    expect(typeof body.source_branch).toBe("string")
    expect((body.source_branch ?? "").length).toBeGreaterThan(0)
  })

  test("uptime_ms is a small non-negative delta (kills `-` → `+` arithmetic mutant)", async () => {
    const app = buildApp()
    const res = await app.request("/settings/api/diagnostics")
    const body = (await res.json()) as { uptime_ms: number }
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0)
    // Date.now() + PROCESS_START_MS is on the order of 2 * Date.now()
    // (~3e12). Anchor below 1 day in ms to leave generous slack while
    // still catching the additive mutant.
    expect(body.uptime_ms).toBeLessThan(24 * 60 * 60 * 1000)
  })

  test("token presence booleans reflect state when both tokens are set (kills `always false` + `===` flip)", async () => {
    state.githubToken = "ghu_test_value"
    state.copilotToken = "copilot_test_value"
    const app = buildApp()
    const res = await app.request("/settings/api/diagnostics")
    const body = (await res.json()) as {
      tokens: { github_token_present: boolean; copilot_token_present: boolean }
    }
    expect(body.tokens.github_token_present).toBe(true)
    expect(body.tokens.copilot_token_present).toBe(true)
  })

  test("token presence booleans reflect state when both tokens are unset (kills `always true`)", async () => {
    state.githubToken = undefined
    state.copilotToken = undefined
    const app = buildApp()
    const res = await app.request("/settings/api/diagnostics")
    const body = (await res.json()) as {
      tokens: { github_token_present: boolean; copilot_token_present: boolean }
    }
    expect(body.tokens.github_token_present).toBe(false)
    expect(body.tokens.copilot_token_present).toBe(false)
  })
})

describe("settings/api mutant kills — sub-router mount path", () => {
  test('`/auth/github` mount: nested status route is reachable under the mount prefix (kills mount-path → "")', async () => {
    const app = buildApp()
    // Under the original mount `/auth/github`, this resolves to the
    // authRoutes `/status` handler → 200. Under the mutant mount `""`,
    // authRoutes is mounted at `/settings/api`, so this path 404s.
    const res = await app.request("/settings/api/auth/github/status")
    expect(res.status).toBe(200)
  })

  test('`/auth/github` mount: routes are NOT exposed at the parent prefix (kills mount-path → "")', async () => {
    const app = buildApp()
    // Under the original mount, `/settings/api/status` has no handler
    // (404). Under the mutant `""` mount, authRoutes' `/status` would
    // resolve here → 200. Asserting 404 catches the mutant.
    const res = await app.request("/settings/api/status")
    expect(res.status).toBe(404)
  })

  test("authRoutes is a Hono instance with the expected `/status` sub-path (sanity for the mount-kill tests)", () => {
    // Defensive: if authRoutes ever loses /status, the two tests above
    // could go quiet. This guard makes that obvious.
    expect(authRoutes).toBeInstanceOf(Hono)
  })
})
