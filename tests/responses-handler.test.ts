import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import { Hono } from "hono"

const createResponses = mock(() => Promise.resolve(streamChunks([])))

const { state } = await import("../src/lib/state")
const { closeUsageStore } = await import("../src/lib/token-usage")
const { tokenUsageRoute } = await import("../src/routes/token-usage/route")
const { responsesRoutes } = await import("../src/routes/responses/route")
const { generateRequestIdFromPayload, getUUID } =
  await import("../src/lib/utils")
// DI shim — replaces the previous process-wide
// mock.module("~/services/copilot/create-responses", ...) which leaked
// the stub to other test files (notably tests/completion-rejection.test.ts)
// whose static `import { createResponses }` then captured the AsyncGenerator
// stub instead of the real function. The DI hook scopes the override to
// this file's handler-via-route call path only.
const { __setCreateResponsesForTests, __resetCreateResponsesForTests } =
  await import("../src/routes/responses/handler")
__setCreateResponsesForTests(createResponses)

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

const originalState = {
  copilotToken: state.copilotToken,
  lastRequestTimestamp: state.lastRequestTimestamp,
  manualApprove: state.manualApprove,
  models: state.models,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
  verbose: state.verbose,
}

function createApp(): Hono {
  const app = new Hono()
  app.route("/v1/responses", responsesRoutes)
  app.route("/token-usage", tokenUsageRoute)
  return app
}

async function* streamChunks(items: Array<Record<string, unknown>>) {
  await Promise.resolve()
  for (const item of items) {
    yield item
  }
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()

  state.copilotToken = "test-token"
  state.manualApprove = false
  state.verbose = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  state.models = {
    object: "list",
    data: [
      {
        capabilities: {
          limits: {
            max_prompt_tokens: 128000,
          },
        },
        id: "gpt-test",
        supported_endpoints: ["/responses"],
      },
    ],
  } as typeof state.models

  createResponses.mockReset()
})

afterEach(async () => {
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)

  state.copilotToken = originalState.copilotToken
  state.manualApprove = originalState.manualApprove
  state.verbose = originalState.verbose
  state.rateLimitSeconds = originalState.rateLimitSeconds
  state.rateLimitWait = originalState.rateLimitWait
  state.lastRequestTimestamp = originalState.lastRequestTimestamp
  state.models = originalState.models
})

describe("responses handler token usage", () => {
  test("records usage from failed streaming responses and falls back to interaction id", async () => {
    createResponses.mockImplementation(() =>
      Promise.resolve(
        streamChunks([
          {
            data: JSON.stringify({
              response: {
                created_at: 0,
                error: {
                  message: "request failed",
                },
                id: "resp_123",
                incomplete_details: null,
                instructions: null,
                metadata: null,
                model: "gpt-test",
                object: "response",
                output: [],
                output_text: "",
                parallel_tool_calls: false,
                status: "failed",
                temperature: null,
                tool_choice: "auto",
                tools: [],
                top_p: null,
                usage: {
                  input_tokens: 5,
                  input_tokens_details: {
                    cached_tokens: 1,
                  },
                  output_tokens: 2,
                  total_tokens: 7,
                },
              },
              sequence_number: 1,
              type: "response.failed",
            }),
            event: "response.failed",
            id: "event_1",
          },
        ]),
      ),
    )

    const app = createApp()
    const payload = {
      input: "hello",
      model: "gpt-test",
      stream: true,
    }

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    await response.text()

    const eventsResponse = await app.request(
      "/token-usage/events?period=day&page=1&page_size=10",
    )
    expect(eventsResponse.status).toBe(200)

    const page = (await eventsResponse.json()) as {
      items: Array<{
        cache_read_input_tokens: number
        input_tokens: number
        output_tokens: number
        session_id: string
        total_tokens: number
      }>
    }
    expect(page.items).toHaveLength(1)

    const expectedRequestId = generateRequestIdFromPayload({
      messages: payload.input,
    })
    const expectedInteractionId = getUUID(expectedRequestId)

    expect(page.items[0]?.session_id).toBe(expectedInteractionId)
    expect(page.items[0]?.cache_read_input_tokens).toBe(1)
    expect(page.items[0]?.input_tokens).toBe(4)
    expect(page.items[0]?.output_tokens).toBe(2)
    expect(page.items[0]?.total_tokens).toBe(7)
  })
})

afterAll(() => {
  // Release the DI shim for createResponses so the real function is
  // restored in the handler module. This file uses NO process-wide
  // `mock.module` on `~/lib/config` or `~/lib/rate-limit` — see the
  // header comment at the createResponses DI shim for why. The real
  // config module is used directly (test isolation via the temp
  // COPILOT_API_HOME preload), and rate limiting is inert because
  // `beforeEach` leaves `state.rateLimitSeconds` undefined.
  __resetCreateResponsesForTests()
})
