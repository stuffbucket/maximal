import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"
import type { ResponsesPayload } from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/runtime-state/state"
import { handleWithWebToolsAgent } from "~/routes/messages/web-tools/flow"

import { FakeExecutor } from "./helpers/fake-executor"

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
}

const responsesModel = {
  id: "gpt-5.6-sol",
  name: "GPT 5.6",
  object: "model",
  preview: false,
  vendor: "OpenAI",
  version: "5.6",
  model_picker_enabled: true,
  supported_endpoints: ["/responses"],
  capabilities: {
    family: "gpt-5.6",
    limits: { max_prompt_tokens: 128_000 },
    object: "model_capabilities",
    supports: { tool_calls: true, streaming: true },
    tokenizer: "o200k_base",
    type: "chat",
  },
} satisfies Model

const payload = (): AnthropicMessagesPayload => ({
  model: responsesModel.id,
  max_tokens: 128,
  messages: [{ role: "user", content: "search for release notes" }],
  tools: [],
})

const policy = {
  declarations: [
    { type: "web_search_20250305" as const, name: "web_search" as const },
  ],
  hasSearch: true,
  hasFetch: false,
}

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
})

afterEach(() => {
  state.copilotToken = originalState.copilotToken
  state.vsCodeVersion = originalState.vsCodeVersion
  state.accountType = originalState.accountType
  globalThis.fetch = originalFetch
})

describe("handleWithWebToolsAgent", () => {
  test("uses Responses for a Responses-only model", async () => {
    const urls: Array<string> = []
    let sentPayload: ResponsesPayload | undefined
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        urls.push(input instanceof Request ? input.url : input.toString())
        if (typeof init?.body !== "string")
          throw new Error("missing request body")
        sentPayload = JSON.parse(init.body) as ResponsesPayload
        return Promise.resolve(
          Response.json({
            id: "resp_1",
            object: "response",
            created_at: 0,
            model: responsesModel.id,
            output: [],
            output_text: "No search needed.",
            status: "completed",
            usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: null,
            parallel_tool_calls: true,
            temperature: 1,
            tool_choice: "auto",
            tools: [],
            top_p: null,
          }),
        )
      },
    ) as unknown as typeof fetch

    const app = new Hono()
    app.post("/", (c) =>
      handleWithWebToolsAgent({
        c,
        payload: payload(),
        options: {
          logger: consola,
          requestId: "req-1",
          sessionId: "session-1",
        },
        policy,
        selectedModel: responsesModel,
        executor: new FakeExecutor(),
      }),
    )

    const response = await app.request("/", { method: "POST" })

    expect(response.status).toBe(200)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toEndWith("/responses")
    expect(sentPayload?.tools).toContainEqual({
      type: "function",
      name: "web_search",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
      },
      strict: false,
      description: expect.any(String),
    })
  })
})

test("streams web-tool turns through Responses for a Responses-only model", async () => {
  const urls: Array<string> = []
  const responseShape = {
    id: "resp_stream_1",
    object: "response",
    created_at: 0,
    model: responsesModel.id,
    output: [],
    output_text: "",
    status: "in_progress",
    usage: null,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  }
  const completedShape = {
    ...responseShape,
    status: "completed",
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  }
  const sse = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: responseShape })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1, response: completedShape })}\n\n`,
  ].join("")
  globalThis.fetch = mock((input: string | URL | Request) => {
    urls.push(input instanceof Request ? input.url : input.toString())
    return Promise.resolve(
      new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    )
  }) as unknown as typeof fetch

  const app = new Hono()
  app.post("/", (c) =>
    handleWithWebToolsAgent({
      c,
      payload: { ...payload(), stream: true },
      options: {
        logger: consola,
        requestId: "req-stream-1",
        sessionId: "session-stream-1",
      },
      policy,
      selectedModel: responsesModel,
      executor: new FakeExecutor(),
    }),
  )

  const response = await app.request("/", { method: "POST" })
  const body = await response.text()

  expect(response.status).toBe(200)
  expect(urls).toHaveLength(1)
  expect(urls[0]).toEndWith("/responses")
  expect(body).toContain("message_start")
  expect(body).toContain("message_stop")
})

test("emits an Anthropic stream error when the web-tools upstream fails", async () => {
  globalThis.fetch = mock(() =>
    Promise.reject(new Error("upstream stream unavailable")),
  ) as unknown as typeof fetch

  const app = new Hono()
  app.post("/", (c) =>
    handleWithWebToolsAgent({
      c,
      payload: { ...payload(), stream: true },
      options: {
        logger: consola,
        requestId: "req-stream-error",
        sessionId: "session-stream-error",
      },
      policy,
      selectedModel: responsesModel,
      executor: new FakeExecutor(),
    }),
  )

  const response = await app.request("/", { method: "POST" })
  const body = await response.text()

  expect(response.status).toBe(200)
  expect(body).toContain("event: error")
  expect(body).toContain("upstream stream unavailable")
})
