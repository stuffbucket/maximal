import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { getConfig, writeConfig } from "~/lib/config/config"
import { state } from "~/lib/runtime-state/state"
import { handleCountTokens } from "~/routes/messages/count-tokens-handler"

const originalFetch = globalThis.fetch
const originalConfig = getConfig()
const originalModels = state.models
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.models = originalModels
  writeConfig(originalConfig)
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  }
})

describe("messages count_tokens handler", () => {
  test("strips unsupported top-level diagnostics before forwarding to Anthropic", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic_test"

    let upstreamBody: Record<string, unknown> | undefined
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      upstreamBody = JSON.parse(init?.body as string) as Record<string, unknown>
      return Promise.resolve(
        new Response(JSON.stringify({ input_tokens: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch

    const app = new Hono()
    app.post("/count_tokens", handleCountTokens)

    const response = await app.request("/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        metadata: { user_id: "session-id" },
        diagnostics: {
          client: "claude-code",
          enabled: true,
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ input_tokens: 42 })
    expect(upstreamBody).toBeDefined()
    expect(Object.hasOwn(upstreamBody as object, "diagnostics")).toBe(false)
    expect(upstreamBody?.metadata).toEqual({ user_id: "session-id" })
    expect(upstreamBody?.model).toBe("claude-opus-4-6")
  })

  test("reverses and maps the model before forwarding token counting", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic_test"
    writeConfig({
      modelMappings: [
        {
          match: { type: "exact", value: "claude-opus-4.6" },
          target: "claude-sonnet-4.5",
        },
      ],
    })
    state.models = {
      object: "list",
      data: [
        {
          id: "claude-sonnet-4.5",
          model_picker_enabled: true,
          supported_endpoints: ["/v1/messages"],
        },
      ],
    } as typeof state.models

    let upstreamBody: Record<string, unknown> | undefined
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      upstreamBody = JSON.parse(init?.body as string) as Record<string, unknown>
      return Promise.resolve(
        new Response(JSON.stringify({ input_tokens: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch

    const app = new Hono()
    app.post("/count_tokens", handleCountTokens)
    const response = await app.request("/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6-20260301",
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(upstreamBody?.model).toBe("claude-sonnet-4-5")
  })
})
