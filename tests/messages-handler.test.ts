import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

const actualStateModule = await import("../src/lib/runtime-state/state")
const actualConfigModule = await import("../src/lib/config/config")
const actualModelsModule = await import("../src/lib/models/models")
const actualRateLimitModule = await import("../src/lib/http/rate-limit")
const actualUtilsModule = await import("../src/lib/platform/utils")
const actualApiFlowsModule = await import("../src/routes/messages/api-flows")

const state = {
  ...actualStateModule.state,
  manualApprove: false,
  verbose: false,
}

let messagesApiEnabled = true
type SelectedModel = {
  id: string
  supported_endpoints?: Array<string>
}

type FlowCallOptions = {
  requestId: string
  sessionId?: string
  subagentMarker?: unknown
  anthropicBetaHeader?: string
}

let selectedModel: SelectedModel | undefined

const findEndpointModel = mock((_: string) => selectedModel)
const handleWithMessagesApi = mock(
  (
    _c: unknown,
    _payload: AnthropicMessagesPayload,
    _options: FlowCallOptions,
  ) => new Response("messages"),
)
const handleWithResponsesApi = mock(
  (
    _c: unknown,
    _payload: AnthropicMessagesPayload,
    _options: FlowCallOptions,
  ) => new Response("responses"),
)
const handleWithChatCompletions = mock(
  (
    _c: unknown,
    _payload: AnthropicMessagesPayload,
    _options: FlowCallOptions,
  ) => new Response("chat"),
)

await mock.module("~/lib/runtime-state/state", () => ({
  ...actualStateModule,
  state,
}))
await mock.module("~/lib/http/rate-limit", () => ({
  ...actualRateLimitModule,
  checkRateLimit: async () => {},
}))
await mock.module("~/lib/config/config", () => ({
  ...actualConfigModule,
  getSmallModel: () => "small-model",
  isMessagesApiEnabled: () => messagesApiEnabled,
}))
await mock.module("~/lib/models/models", () => ({
  ...actualModelsModule,
  findEndpointModel,
}))
await mock.module("~/lib/platform/utils", () => ({
  ...actualUtilsModule,
}))
await mock.module("~/routes/messages/api-flows", () => ({
  handleWithMessagesApi,
  handleWithResponsesApi,
  handleWithChatCompletions,
  isNonStreaming: (response: unknown) =>
    Object.hasOwn(response as object, "choices"),
}))

const { handleCompletion } = await import("../src/routes/messages/handler")

const createApp = () => {
  const app = new Hono()
  app.post("/", handleCompletion)
  return app
}

const createPayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  model: "original-model",
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
})

beforeEach(() => {
  state.manualApprove = false
  state.verbose = false
  messagesApiEnabled = true
  selectedModel = undefined

  findEndpointModel.mockClear()
  handleWithMessagesApi.mockClear()
  handleWithResponsesApi.mockClear()
  handleWithChatCompletions.mockClear()
})

describe("messages handler orchestration", () => {
  test("removes executeCode and rewrites getDiagnostics before forwarding tools", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createPayload({
          tools: [
            {
              name: "mcp__ide__executeCode",
              description: "Execute code in VS Code",
              input_schema: { type: "object" },
            },
            {
              name: "mcp__ide__getDiagnostics",
              description: "Old description",
              input_schema: { type: "object" },
            },
            {
              name: "keep_me",
              description: "Keep me",
              input_schema: { type: "object" },
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.tools).toEqual([
      {
        name: "mcp__ide__getDiagnostics",
        description:
          "Get language diagnostics from VS Code. Returns errors, warnings, information, and hints for files in the workspace.",
        input_schema: { type: "object" },
      },
      {
        name: "keep_me",
        description: "Keep me",
        input_schema: { type: "object" },
      },
    ])
  })

  test("delegates to the Messages API flow when the model supports /v1/messages", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")
    expect(handleWithMessagesApi).toHaveBeenCalledTimes(1)
    expect(handleWithResponsesApi).not.toHaveBeenCalled()
    expect(handleWithChatCompletions).not.toHaveBeenCalled()

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.model).toBe("messages-model")
  })

  test("strips unsupported top-level diagnostics before forwarding", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...createPayload({
          metadata: { user_id: "session-id" },
        }),
        diagnostics: {
          client: "claude-code",
          enabled: true,
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(Object.hasOwn(forwardedPayload, "diagnostics")).toBe(false)
    expect(forwardedPayload.metadata).toEqual({ user_id: "session-id" })
  })

  test("delegates to the Responses API flow when the model supports /responses", async () => {
    selectedModel = {
      id: "responses-model",
      supported_endpoints: ["/responses"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("responses")
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).toHaveBeenCalledTimes(1)
    expect(handleWithChatCompletions).not.toHaveBeenCalled()
  })

  test("falls back to the Chat Completions flow when no endpoint matches", async () => {
    selectedModel = {
      id: "chat-model",
      supported_endpoints: [],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("chat")
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).not.toHaveBeenCalled()
    expect(handleWithChatCompletions).toHaveBeenCalledTimes(1)
  })

  test("does not downgrade a non-warmup no-tool request", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const payload = createPayload({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: '<system-reminder>__SUBAGENT_MARKER__{"session_id":"sub-session","agent_id":"agent-1","agent_type":"Explore"}</system-reminder>',
            },
            {
              type: "text",
              text: "hello",
            },
          ],
        },
      ],
    })

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "warmup-beta",
        "x-session-id": "session-123",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")
    // Regression for B3: the broad small-model downgrade no longer fires on
    // non-warmup no-tool turns; the requested model is preserved.
    expect(findEndpointModel).toHaveBeenCalledWith("original-model")
    expect(findEndpointModel).not.toHaveBeenCalledWith("small-model")

    const expectedSessionId = actualUtilsModule.getUUID("session-123")
    const expectedRequestId = actualUtilsModule.generateRequestIdFromPayload(
      payload,
      expectedSessionId,
    )

    const options = handleWithMessagesApi.mock.calls[0][2]
    expect(options.requestId).toBe(expectedRequestId)
    expect(options.sessionId).toBe(expectedSessionId)
    expect(options.subagentMarker).toEqual({
      session_id: "sub-session",
      agent_id: "agent-1",
      agent_type: "Explore",
    })
    expect(options.anthropicBetaHeader).toBe("warmup-beta")
  })
})

describe("warmup short-circuit", () => {
  test("short-circuits a genuine warmup request without an upstream call", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "warmup-beta",
      },
      body: JSON.stringify(
        createPayload({
          messages: [{ role: "user", content: "Warmup" }],
        }),
      ),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      type: string
      content: Array<{ type: string; text: string }>
    }
    expect(body.type).toBe("message")
    expect(body.content).toEqual([{ type: "text", text: "OK" }])

    // No flow was dispatched — the response is canned locally.
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).not.toHaveBeenCalled()
    expect(handleWithChatCompletions).not.toHaveBeenCalled()
  })
})

// Restore real modules so their mocks don't bleed into other test files
// that share this Bun worker (e.g. find-endpoint-model.test.ts). Awaited so
// the restore actually lands before a later file's static imports resolve
// (Bun keeps module mocks for the whole process; an unawaited restore never
// lands).
afterAll(async () => {
  await mock.module("~/lib/runtime-state/state", () => actualStateModule)
  await mock.module("~/lib/models/models", () => actualModelsModule)
  await mock.module("~/lib/http/rate-limit", () => actualRateLimitModule)
  await mock.module("~/lib/config/config", () => actualConfigModule)
  await mock.module("~/lib/platform/utils", () => actualUtilsModule)
  await mock.module("~/routes/messages/api-flows", () => actualApiFlowsModule)
})
