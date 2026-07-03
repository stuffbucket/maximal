import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthMiddleware } from "~/lib/request-auth"
import { DiagnosticsResponse } from "~/lib/settings-types"
import { server } from "~/server"

import { settingsApiRoutes } from "../src/routes/settings/api"

describe("GET /settings/api/diagnostics", () => {
  test("returns 200 with a payload matching DiagnosticsResponse", async () => {
    const res = await server.request("/settings/api/diagnostics")
    expect(res.status).toBe(200)
    const body = await res.json()
    const parsed = DiagnosticsResponse.safeParse(body)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(typeof parsed.data.version).toBe("string")
      expect(parsed.data.pid).toBe(process.pid)
      expect(parsed.data.uptime_ms).toBeGreaterThanOrEqual(0)
      expect(typeof parsed.data.tokens.github_token_present).toBe("boolean")
      // launch_path/kind classify where the sidecar was launched from.
      expect(parsed.data.launch_path.length).toBeGreaterThan(0)
      expect(["dmg-app", "homebrew", "user-bin", "dev", "other"]).toContain(
        parsed.data.launch_kind,
      )
      // web_search surfaces which executor resolves web tools.
      expect(parsed.data.web_search.kind.length).toBeGreaterThan(0)
    }
  })

  test("redacts secrets: response body never contains GitHub token", async () => {
    // Sanity: even if a token is set in state, the contract only
    // exposes presence booleans — never the value.
    const res = await server.request("/settings/api/diagnostics")
    const text = await res.text()
    expect(text).not.toMatch(/ghu_[A-Za-z0-9]+/u)
    expect(text).not.toMatch(/ghs_[A-Za-z0-9]+/u)
  })

  test("is auth-gated when api keys are configured (401 without key)", async () => {
    // Build a tiny standalone app to simulate "auth keys configured"
    // without mutating the real config cache. Verifies that the
    // settings router does NOT bypass the standard middleware.
    const app = new Hono()
    app.use(
      "*",
      createAuthMiddleware({
        getApiKeys: () => ["test-key"],
        isEnforcing: () => true,
        allowUnauthenticatedPaths: ["/", "/usage-viewer"],
      }),
    )
    app.route("/settings/api", settingsApiRoutes)

    const unauthorized = await app.request("/settings/api/diagnostics")
    expect(unauthorized.status).toBe(401)

    const authorized = await app.request("/settings/api/diagnostics", {
      headers: { "x-api-key": "test-key" },
    })
    expect(authorized.status).toBe(200)
  })
})

describe("DiagnosticsResponse schema round-trip", () => {
  test("parses a hand-built fixture identical to the route shape", () => {
    const fixture = {
      version: "0.1.0",
      source_revision: "a123fc0",
      source_branch: "main",
      launch_path: "/Applications/Maximal.app/Contents/MacOS/maximal",
      launch_kind: "dmg-app" as const,
      pid: 12345,
      uptime_ms: 60_000,
      account_type: "individual",
      models_cached: 47,
      tokens: {
        github_token_present: true,
        copilot_token_present: false,
      },
      rate_limit: {
        interval_seconds: null,
        last_request_at: null,
        wait_when_throttled: false,
      },
      web_search: {
        kind: "CopilotResponsesExecutor",
        detail: "gpt-5-mini",
      },
    }
    const parsed = DiagnosticsResponse.parse(fixture)
    expect(parsed).toEqual(fixture)
  })

  test("rejects an obviously bad shape", () => {
    const bad = { version: 123 }
    expect(() => DiagnosticsResponse.parse(bad)).toThrow()
  })
})
