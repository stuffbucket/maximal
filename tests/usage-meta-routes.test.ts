import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { CODEX_KEY_LABEL } from "../src/apps/codex/config"
import { getConfig, writeConfig } from "../src/lib/config/config"
import {
  requestContext,
  type RequestUsageMeta,
} from "../src/lib/http/request-context"
import { traceIdMiddleware } from "../src/lib/http/trace"
import { state } from "../src/lib/runtime-state/state"
import { closeUsageStore } from "../src/lib/token-usage"
import { completionRoutes } from "../src/routes/chat-completions/route"
import { messageRoutes } from "../src/routes/messages/route"
import {
  __resetCreateResponsesForTests,
  __setCreateResponsesForTests,
} from "../src/routes/responses/handler"
import { responsesRoutes } from "../src/routes/responses/route"
import { resolveResponsesCompactThreshold } from "../src/routes/responses/utils"
import { tokenUsageRoute } from "../src/routes/token-usage/route"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

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

/** A copy of the request's usage meta, taken at the moment upstream is called. */
let seenUsage: RequestUsageMeta | undefined
let apiKeyLabel: string | null = null

const limits = {
  max_prompt_tokens: 128_000,
  max_context_window_tokens: 400_000,
}

const createModels = () =>
  ({
    object: "list",
    data: [
      {
        capabilities: { family: "gpt", limits, supports: {}, type: "chat" },
        id: "gpt-test",
        model_picker_enabled: true,
        supported_endpoints: ["/responses", "/chat/completions"],
      },
      {
        capabilities: { family: "claude", limits, supports: {}, type: "chat" },
        id: "claude-test",
        model_picker_enabled: true,
        supported_endpoints: ["/v1/messages"],
      },
    ],
  }) as unknown as typeof state.models

function createApp(): Hono {
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.use(async (_c, next) => {
    const store = requestContext.getStore()
    if (store) store.usage.apiKeyLabel = apiKeyLabel
    await next()
  })
  app.route("/v1/responses", responsesRoutes)
  app.route("/v1/chat/completions", completionRoutes)
  app.route("/v1/messages", messageRoutes)
  app.route("/token-usage", tokenUsageRoute)
  return app
}

function snapshotUsage(): void {
  seenUsage = { ...requestContext.getStore()?.usage }
}

const responsesResult = (): Record<string, unknown> => ({
  id: "resp_1",
  object: "response",
  model: "gpt-test",
  output: [],
  status: "completed",
  usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
})

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

async function recordedSessionIds(app: Hono): Promise<Array<string>> {
  const response = await app.request(
    "/token-usage/events?period=day&page=1&page_size=10",
  )
  const page = (await response.json()) as {
    items: Array<{ session_id: string }>
  }
  return page.items.map((item) => item.session_id)
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  writeConfig({ modelMappings: [] })
  await closeUsageStore()

  seenUsage = undefined
  apiKeyLabel = null
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.manualApprove = false
  state.verbose = false
  state.vsCodeVersion = "1.0.0"
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  state.models = createModels()
})

afterEach(async () => {
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  __resetCreateResponsesForTests()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  Object.assign(state, originalState)
  writeConfig(originalConfig)
})

describe("responses route usage metadata", () => {
  beforeEach(() => {
    __setCreateResponsesForTests((() => {
      snapshotUsage()
      return Promise.resolve(responsesResult())
    }) as never)
  })

  test("keys the session on prompt_cache_key, not the last user message", async () => {
    const app = createApp()
    for (const text of ["first question", "a different question"]) {
      const response = await post(app, "/v1/responses", {
        model: "gpt-test",
        input: [{ role: "user", content: text }],
        prompt_cache_key: "conv-1",
      })
      expect(response.status).toBe(200)
    }

    expect(await recordedSessionIds(app)).toEqual(["conv-1", "conv-1"])
    expect(seenUsage).toMatchObject({
      sessionId: "conv-1",
      model: "gpt-test",
      cacheTtlS: 300,
      cacheTtlRequested: false,
      isCompact: false,
    })
  })

  test("has no session without a prompt_cache_key", async () => {
    const app = createApp()
    await post(app, "/v1/responses", { model: "gpt-test", input: "hello" })

    expect(await recordedSessionIds(app)).toEqual([""])
    expect(seenUsage?.sessionId).toBe("")
  })

  test("uses the 24h retention for the cache lifetime", async () => {
    await post(createApp(), "/v1/responses", {
      model: "gpt-test",
      input: "hello",
      prompt_cache_retention: "24h",
    })

    expect(seenUsage?.cacheTtlS).toBe(86_400)
  })

  test("flags a request that carries a compaction item", async () => {
    await post(createApp(), "/v1/responses", {
      model: "gpt-test",
      input: [
        { type: "compaction", id: "cmp_1", encrypted_content: "x" },
        { role: "user", content: "go on" },
      ],
    })

    expect(seenUsage?.isCompact).toBe(true)
  })

  test("sets the compaction point only when Maximal injected management", async () => {
    apiKeyLabel = CODEX_KEY_LABEL
    writeConfig({
      modelMappings: [],
      responsesApiContextManagementModels: ["gpt-test"],
    })
    const app = createApp()

    await post(app, "/v1/responses", { model: "gpt-test", input: "hello" })
    expect(seenUsage?.context?.compactAtTokens).toBe(
      resolveResponsesCompactThreshold(128_000),
    )

    await post(app, "/v1/responses", {
      model: "gpt-test",
      input: "hello",
      context_management: [{ type: "compaction", compact_threshold: 1000 }],
    })
    expect(seenUsage?.context?.compactAtTokens).toBeNull()
    expect(seenUsage?.context?.source).toBe("codex-catalog")
  })
})

describe("chat completions route usage metadata", () => {
  test("records no session and a five minute cache lifetime", async () => {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (() => {
      snapshotUsage()
      return Promise.resolve(
        Response.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 0,
          model: "gpt-test",
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      )
    }) as unknown as typeof fetch

    const app = createApp()
    const response = await post(app, "/v1/chat/completions", {
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
    })
    expect(response.status).toBe(200)

    expect(await recordedSessionIds(app)).toEqual([""])
    expect(seenUsage).toMatchObject({
      sessionId: "",
      model: "gpt-test",
      cacheTtlS: 300,
      cacheTtlRequested: false,
    })
  })
})

describe("messages route usage metadata", () => {
  test("reads the cache lifetime off the client's cache_control", async () => {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (() => {
      snapshotUsage()
      return Promise.resolve(
        Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-test",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      )
    }) as unknown as typeof fetch

    const response = await post(createApp(), "/v1/messages", {
      model: "claude-test",
      max_tokens: 16,
      system: [
        {
          type: "text",
          text: "be brief",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.status).toBe(200)

    expect(seenUsage).toMatchObject({
      model: "claude-test",
      cacheTtlS: 3600,
      cacheTtlRequested: true,
      isCompact: false,
    })
    expect(seenUsage?.context?.windowTokens).toBe(400_000)
  })

  test("follows the upstream model's rule when routed to a GPT model", async () => {
    writeConfig({ modelMappings: [], promptCacheRetention: "24h" })
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (() => {
      snapshotUsage()
      return Promise.resolve(Response.json(responsesResult()))
    }) as unknown as typeof fetch

    const response = await post(createApp(), "/v1/messages", {
      model: "gpt-test",
      max_tokens: 16,
      system: [
        {
          type: "text",
          text: "be brief",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.status).toBe(200)

    expect(seenUsage?.cacheTtlS).toBe(86_400)
  })
})
