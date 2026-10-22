import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { getConfig, writeConfig } from "../src/lib/config/config"
import { state } from "../src/lib/runtime-state/state"
import { completionRoutes } from "../src/routes/chat-completions/route"

const originalFetch = globalThis.fetch
const originalConfig = getConfig()
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  lastRequestTimestamp: state.lastRequestTimestamp,
  manualApprove: state.manualApprove,
  models: state.models,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
  verbose: state.verbose,
  vsCodeVersion: state.vsCodeVersion,
}

const fetchMock = mock(() =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "gpt-test",
        choices: [],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    ),
  ),
)

const createModels = () => ({
  object: "list" as const,
  data: [
    {
      capabilities: {
        family: "gpt",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "gpt-5.4",
      model_picker_enabled: true,
      name: "gpt-5.4",
      object: "model" as const,
      preview: false,
      vendor: "openai",
      version: "1",
    },
    {
      capabilities: {
        family: "gpt",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "gpt-test",
      model_picker_enabled: true,
      name: "gpt-test",
      object: "model" as const,
      preview: false,
      supported_endpoints: ["/chat/completions"],
      vendor: "openai",
      version: "1",
    },
  ],
})

const createApp = () => {
  const app = new Hono()
  app.route("/v1/chat/completions", completionRoutes)
  return app
}

beforeEach(() => {
  writeConfig({ modelMappings: [] })
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.manualApprove = false
  state.verbose = false
  state.vsCodeVersion = "1.0.0"
  state.rateLimitWait = false
  state.rateLimitSeconds = undefined
  state.lastRequestTimestamp = undefined
  state.models = createModels()

  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  state.accountType = originalState.accountType
  state.copilotToken = originalState.copilotToken
  state.manualApprove = originalState.manualApprove
  state.verbose = originalState.verbose
  state.vsCodeVersion = originalState.vsCodeVersion
  state.rateLimitWait = originalState.rateLimitWait
  state.rateLimitSeconds = originalState.rateLimitSeconds
  state.lastRequestTimestamp = originalState.lastRequestTimestamp
  state.models = originalState.models
  writeConfig(originalConfig)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

describe("chat completions handler", () => {
  test("forwards a mapped model from the live catalog", async () => {
    writeConfig({
      modelMappings: [
        {
          match: { type: "exact", value: "chat-alias" },
          target: "gpt-test",
        },
      ],
    })

    const response = await createApp().request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chat-alias",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      unknown,
      RequestInit,
    ]
    const forwarded = JSON.parse(init.body as string) as { model: string }
    expect(forwarded.model).toBe("gpt-test")
  })

  test("rejects gpt-5.4 requests with invalid request error", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "Please use `/v1/responses` or `/v1/messages` API",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
