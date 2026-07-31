import { afterEach, describe, expect, test } from "bun:test"

import { apiCall } from "../src/proxy/client"

/**
 * Tests the response-validation layer in `apiCall` (shell/src/proxy/client.ts):
 * a well-formed body parses through; a body that doesn't match the endpoint's
 * schema becomes an `{ ok: false }` Result rather than a raw cast that a
 * consumer would later crash on. This is the guard that would have caught the
 * diagnostics island blanking on an older sidecar's payload.
 */

const realFetch = globalThis.fetch

function stubJson(body: unknown, status = 200): void {
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === "string" ? body : ""),
    } as Response)) as unknown as typeof fetch
}

function validModels() {
  return {
    count: 1,
    loaded_at: null,
    models: [
      {
        id: "gpt-5",
        name: "GPT-5",
        vendor: "openai",
        family: "gpt",
        type: "chat",
        preview: false,
        context_window_tokens: 400000,
        max_output_tokens: 128000,
        capabilities: {
          vision: true,
          tool_calls: true,
          streaming: true,
          reasoning: true,
        },
      },
    ],
  }
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("apiCall response validation", () => {
  test("passes a well-formed body through", async () => {
    stubJson(validModels())
    const res = await apiCall(
      { kind: "models-list", method: "GET", path: "/settings/api/models" },
      { apiKey: "test" },
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.models[0]?.id).toBe("gpt-5")
  })

  test("rejects a body missing a required field as ok:false", async () => {
    const bad = validModels() as Record<string, unknown>
    delete bad.count // required by ModelsListResponse
    stubJson(bad)
    const res = await apiCall(
      { kind: "models-list", method: "GET", path: "/settings/api/models" },
      { apiKey: "test" },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("Malformed response")
  })

  test("rejects a wrong-typed nested field as ok:false", async () => {
    const bad = validModels()
    // capabilities.vision must be a boolean.
    const caps = bad.models[0].capabilities as Record<string, unknown>
    caps.vision = "yes"
    stubJson(bad)
    const res = await apiCall(
      { kind: "models-list", method: "GET", path: "/settings/api/models" },
      { apiKey: "test" },
    )
    expect(res.ok).toBe(false)
  })

  test("accepts a diagnostics body without copilot_service (older sidecar)", async () => {
    stubJson({
      version: "0.4.41",
      source_revision: null,
      source_branch: null,
      launch_path: "/usr/local/bin/maximal",
      launch_kind: "user-bin",
      pid: 1,
      uptime_ms: 1000,
      account_type: "individual",
      models_cached: 0,
      tokens: { github_token_present: false, copilot_token_present: false },
      rate_limit: {
        interval_seconds: null,
        last_request_at: null,
        wait_when_throttled: false,
      },
      web_search: { kind: "none", detail: null },
      // copilot_service deliberately absent — now optional in the schema.
    })
    const res = await apiCall(
      { kind: "diagnostics", method: "GET", path: "/settings/api/diagnostics" },
      { apiKey: "test" },
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.copilot_service).toBeUndefined()
  })
})
