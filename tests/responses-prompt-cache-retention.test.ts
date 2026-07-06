import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "~/lib/anthropic-types"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { getConfig, writeConfig } from "../src/lib/config"
import { state } from "../src/lib/state"
import { handleWithResponsesApi } from "../src/routes/messages/api-flows"
import { responsesRoutes } from "../src/routes/responses/route"
import {
  createResponses,
  isUnsupportedPromptCacheRetention,
} from "../src/services/copilot/create-responses"

// Covers the Copilot/OpenAI-Responses-specific `prompt_cache_retention`
// enablement: config-gated injection on both the translated Messages->Responses
// path and the native /responses passthrough, plus the one-shot strip-and-retry
// fallback in create-responses. Honors ADR-0011: no process-wide `mock.module`
// on shared modules — uses the real config module (via writeConfig round-trip)
// and a locally-swapped global fetch that is restored in afterEach.

const originalFetch = globalThis.fetch
let originalConfig: ReturnType<typeof getConfig>
const originalState = {
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
  accountType: state.accountType,
  models: state.models,
  manualApprove: state.manualApprove,
}

// Records every serialized request body sent to /responses so tests can assert
// on the presence/absence of prompt_cache_retention on the wire.
let sentBodies: Array<ResponsesPayload> = []

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function minimalResponsesResult(): Record<string, unknown> {
  return {
    id: "resp_1",
    model: "gpt-test",
    object: "response",
    status: "completed",
    output: [],
    output_text: "hi",
    usage: {
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      total_tokens: 4,
    },
  }
}

beforeEach(() => {
  originalConfig = getConfig()
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
  sentBodies = []
})

afterEach(() => {
  writeConfig(originalConfig)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.copilotToken = originalState.copilotToken
  state.vsCodeVersion = originalState.vsCodeVersion
  state.accountType = originalState.accountType
  state.models = originalState.models
  state.manualApprove = originalState.manualApprove
})

function installFetch(handler: (body: ResponsesPayload) => Response): void {
  const fetchMock = mock((_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? "{}") as ResponsesPayload
    sentBodies.push(body)
    return handler(body)
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
}

const anthropicPayload = (): AnthropicMessagesPayload => ({
  model: "gpt-test",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hello" }],
})

function createResponsesApp(): Hono {
  const app = new Hono()
  app.route("/v1/responses", responsesRoutes)
  return app
}

async function postResponses(body: Record<string, unknown>): Promise<void> {
  const app = createResponsesApp()
  const res = await app.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  await res.text()
}

describe("prompt_cache_retention injection — translated Messages->Responses", () => {
  test("omits the field when config is unset (default)", async () => {
    writeConfig({ ...originalConfig, promptCacheRetention: undefined })
    installFetch(() => jsonResponse(minimalResponsesResult()))

    const c = { json: (v: unknown) => v } as never
    await handleWithResponsesApi(c, anthropicPayload(), {
      logger: { debug() {}, warn() {} } as never,
      requestId: "req-1",
      sessionId: "sess-1",
      selectedModel: state.models?.data[0],
    })

    expect(sentBodies).toHaveLength(1)
    expect("prompt_cache_retention" in sentBodies[0]).toBe(false)
  })

  test("carries the configured value when set", async () => {
    writeConfig({ ...originalConfig, promptCacheRetention: "24h" })
    installFetch(() => jsonResponse(minimalResponsesResult()))

    const c = { json: (v: unknown) => v } as never
    await handleWithResponsesApi(c, anthropicPayload(), {
      logger: { debug() {}, warn() {} } as never,
      requestId: "req-1",
      sessionId: "sess-1",
      selectedModel: state.models?.data[0],
    })

    expect(sentBodies[0].prompt_cache_retention).toBe("24h")
  })
})

describe("prompt_cache_retention injection — native /responses passthrough", () => {
  test("fills in the configured value when the client omitted it", async () => {
    writeConfig({ ...originalConfig, promptCacheRetention: "24h" })
    installFetch(() => jsonResponse(minimalResponsesResult()))

    await postResponses({ model: "gpt-test", input: "hello" })

    expect(sentBodies).toHaveLength(1)
    expect(sentBodies[0].prompt_cache_retention).toBe("24h")
  })

  test("does NOT override an explicit client value", async () => {
    writeConfig({ ...originalConfig, promptCacheRetention: "24h" })
    installFetch(() => jsonResponse(minimalResponsesResult()))

    await postResponses({
      model: "gpt-test",
      input: "hello",
      prompt_cache_retention: "in_memory",
    })

    expect(sentBodies[0].prompt_cache_retention).toBe("in_memory")
  })

  test("omits the field when config is unset", async () => {
    writeConfig({ ...originalConfig, promptCacheRetention: undefined })
    installFetch(() => jsonResponse(minimalResponsesResult()))

    await postResponses({ model: "gpt-test", input: "hello" })

    expect("prompt_cache_retention" in sentBodies[0]).toBe(false)
  })
})

describe("prompt_cache_retention defensive fallback (create-responses)", () => {
  test("strips the field and retries once on the specific 400", async () => {
    installFetch((body) => {
      if (body.prompt_cache_retention) {
        return jsonResponse(
          {
            error: {
              message: "Unsupported parameter: prompt_cache_retention",
            },
          },
          400,
        )
      }
      return jsonResponse(minimalResponsesResult())
    })

    const payload: ResponsesPayload = {
      model: "gpt-test",
      input: "hello",
      prompt_cache_retention: "24h",
    }

    const result = await createResponses(payload, {
      vision: false,
      initiator: "user",
      requestId: "req-1",
    })

    expect(sentBodies).toHaveLength(2)
    expect(sentBodies[0].prompt_cache_retention).toBe("24h")
    expect("prompt_cache_retention" in sentBodies[1]).toBe(false)
    expect((result as { id: string }).id).toBe("resp_1")
  })

  test("does NOT retry a 400 with a different cause", async () => {
    installFetch(() =>
      jsonResponse({ error: { message: "context length exceeded" } }, 400),
    )

    const payload: ResponsesPayload = {
      model: "gpt-test",
      input: "hello",
      prompt_cache_retention: "24h",
    }

    let threw = false
    try {
      await createResponses(payload, {
        vision: false,
        initiator: "user",
        requestId: "req-1",
      })
    } catch {
      threw = true
    }

    expect(threw).toBe(true)
    expect(sentBodies).toHaveLength(1)
  })
})

describe("isUnsupportedPromptCacheRetention", () => {
  test("matches the observed unsupported-param body", () => {
    expect(
      isUnsupportedPromptCacheRetention(
        '{"error":{"message":"Unsupported parameter: prompt_cache_retention"}}',
      ),
    ).toBe(true)
  })

  test("does not match an unrelated 400 body", () => {
    expect(
      isUnsupportedPromptCacheRetention(
        '{"error":{"message":"context length exceeded"}}',
      ),
    ).toBe(false)
  })

  test("does not match an unsupported error about a different param", () => {
    expect(
      isUnsupportedPromptCacheRetention(
        '{"error":{"message":"Unsupported parameter: service_tier"}}',
      ),
    ).toBe(false)
  })
})
