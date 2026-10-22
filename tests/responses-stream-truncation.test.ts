import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import { state } from "~/lib/runtime-state/state"
import { handleWithResponsesApi } from "~/routes/messages/api-flows"

// A Responses stream that closes before `response.completed` is an upstream
// drop, so the client should retry it: the terminal event must be a typed
// `overloaded_error`, not a generic `api_error`. Uses a locally-swapped global
// fetch (restored in afterEach) rather than mocking a shared module.

const originalFetch = globalThis.fetch
const originalState = {
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
  accountType: state.accountType,
  models: state.models,
  manualApprove: state.manualApprove,
}

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      {
        capabilities: { limits: { max_prompt_tokens: 128000 } },
        id: "gpt-test",
        supported_endpoints: ["/responses"],
      },
    ],
  } as typeof state.models
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  Object.assign(state, originalState)
})

function truncatedStream(): Response {
  const created = {
    type: "response.created",
    sequence_number: 0,
    response: {
      id: "resp_1",
      model: "gpt-test",
      object: "response",
      status: "in_progress",
      output: [],
    },
  }
  return new Response(
    `event: response.created\ndata: ${JSON.stringify(created)}\n\n`,
    {
      headers: { "content-type": "text/event-stream" },
    },
  )
}

test("a Responses stream that ends early emits a retryable overloaded_error", async () => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
    Promise.resolve(truncatedStream())) as unknown as typeof fetch

  const payload: AnthropicMessagesPayload = {
    model: "gpt-test",
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithResponsesApi(c, payload, {
      logger: { debug() {}, warn() {}, error() {} } as never,
      requestId: "req-1",
      sessionId: "sess-1",
      selectedModel: state.models?.data[0],
    }),
  )

  const text = await (await app.request("/", { method: "POST" })).text()
  const errorData = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map(
      (line) =>
        JSON.parse(line.slice(6)) as { type: string; error?: { type: string } },
    )
    .find((event) => event.type === "error")

  expect(errorData?.error?.type).toBe("overloaded_error")
})
