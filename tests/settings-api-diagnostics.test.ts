import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthMiddleware } from "~/lib/auth/request-auth"
import { copilotBaseUrl } from "~/lib/config/api-config"
import { DiagnosticsResponse } from "~/lib/config/settings-types"
import { state } from "~/lib/runtime-state/state"
import { server } from "~/server"
import { observeContextManagementSupport } from "~/services/copilot/context-management-capabilities"

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

  test("reports observed context-management compatibility separately", async () => {
    const priorUserName = state.userName
    const priorModels = state.models
    state.userName = "diagnostics-context-test"
    state.models = {
      object: "list",
      data: [
        {
          id: "claude-diagnostics-test",
          name: "Diagnostics Test",
          object: "model",
          vendor: "Anthropic",
          version: "1",
          preview: false,
          model_picker_enabled: true,
          supported_endpoints: ["/v1/messages"],
          capabilities: {
            family: "claude",
            type: "chat",
            tokenizer: "o200k_base",
            object: "model_capabilities",
            limits: {},
            supports: {},
          },
        },
      ],
    }
    try {
      observeContextManagementSupport(
        {
          account: state.userName,
          host: copilotBaseUrl(state),
          model: "claude-diagnostics-test",
          strategy: "clear_thinking_20251015",
        },
        "rejected",
      )

      const app = new Hono()
      app.route("/settings/api", settingsApiRoutes)
      const res = await app.request("/settings/api/diagnostics")
      const json: unknown = await res.json()
      const body = DiagnosticsResponse.parse(json)

      expect(body.context_management.cache.policy).toBe("rejections-only")
      const observation = body.context_management.cache.entries.find(
        (entry) => entry.model === "claude-diagnostics-test",
      )
      expect(observation).toMatchObject({
        strategy: "clear_thinking_20251015",
      })
      expect(typeof observation?.rejected_at).toBe("string")
    } finally {
      // eslint-disable-next-line require-atomic-updates -- restores test-global state
      state.userName = priorUserName
      // eslint-disable-next-line require-atomic-updates -- restores test-global state
      state.models = priorModels
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
      context_management: {
        advertised: [{ model: "claude-opus-5", support: true }],
        cache: {
          policy: "rejections-only" as const,
          entries: [
            {
              model: "claude-opus-4.7",
              strategy: "clear_thinking_20251015",
              rejected_at: "2026-09-19T00:00:00.000Z",
            },
          ],
        },
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
