import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { CODEX_KEY_LABEL } from "../src/apps/codex/config"
import { getConfig, writeConfig } from "../src/lib/config/config"
import {
  requestContext,
  type RequestUsageMeta,
} from "../src/lib/http/request-context"
import { traceIdMiddleware } from "../src/lib/http/trace"
import { openSqliteDatabase } from "../src/lib/platform/sqlite"
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
        capabilities: { family: "gpt", limits, supports: {}, type: "chat" },
        id: "chat-only",
        model_picker_enabled: true,
        supported_endpoints: ["/chat/completions"],
      },
      {
        capabilities: { family: "claude", limits, supports: {}, type: "chat" },
        id: "claude-test",
        model_picker_enabled: true,
        supported_endpoints: ["/v1/messages"],
      },
    ],
  }) as unknown as typeof state.models

function buildApp(): Hono {
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

const app = buildApp()

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

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

const chatResult = () => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "chat-only",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
})

const claudeResult = () => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  model: "claude-test",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
})

const stubFetch = (result: () => unknown): void => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (() => {
    snapshotUsage()
    return Promise.resolve(Response.json(result()))
  }) as unknown as typeof fetch
}

const oneHourSystem = [
  {
    type: "text",
    text: "be brief",
    cache_control: { type: "ephemeral", ttl: "1h" },
  },
]

async function recordedSessionIds(): Promise<Array<string>> {
  const response = await app.request(
    "/token-usage/events?period=day&page=1&page_size=10",
  )
  const page = (await response.json()) as {
    items: Array<{ session_id: string }>
  }
  return page.items.map((item) => item.session_id)
}

beforeEach(async () => {
  consola.level = 1
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
  consola.level = 3
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
    for (const text of ["first question", "a different question"]) {
      const response = await post("/v1/responses", {
        model: "gpt-test",
        input: [{ role: "user", content: text }],
        prompt_cache_key: "conv-1",
      })
      expect(response.status).toBe(200)
    }

    expect(await recordedSessionIds()).toEqual(["conv-1", "conv-1"])
    expect(seenUsage).toMatchObject({
      sessionId: "conv-1",
      model: "gpt-test",
      cacheTtlS: 300,
      cacheTtlRequested: false,
      isCompact: false,
    })
  })

  test("has no session without a prompt_cache_key", async () => {
    await post("/v1/responses", { model: "gpt-test", input: "hello" })

    expect(await recordedSessionIds()).toEqual([""])
    expect(seenUsage?.sessionId).toBe("")
  })

  test("uses the 24h retention for the cache lifetime", async () => {
    await post("/v1/responses", {
      model: "gpt-test",
      input: "hello",
      prompt_cache_retention: "24h",
    })

    expect(seenUsage?.cacheTtlS).toBe(86_400)
  })

  test("flags a request that carries a compaction item", async () => {
    await post("/v1/responses", {
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

    await post("/v1/responses", { model: "gpt-test", input: "hello" })
    expect(seenUsage?.context?.compactAtTokens).toBe(
      resolveResponsesCompactThreshold(128_000),
    )

    await post("/v1/responses", {
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
    stubFetch(chatResult)

    const response = await post("/v1/chat/completions", {
      model: "chat-only",
      messages: [{ role: "user", content: "hello" }],
    })
    expect(response.status).toBe(200)

    expect(await recordedSessionIds()).toEqual([""])
    expect(seenUsage).toMatchObject({
      sessionId: "",
      model: "chat-only",
      cacheTtlS: 300,
      cacheTtlRequested: false,
    })
  })
})

const messagesBody = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  max_tokens: 16,
  system: oneHourSystem,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
})

describe("messages route usage metadata", () => {
  test("reads the cache lifetime off the client's cache_control", async () => {
    stubFetch(claudeResult)

    const response = await post("/v1/messages", messagesBody("claude-test"))
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
    stubFetch(responsesResult)

    const response = await post("/v1/messages", messagesBody("gpt-test"))
    expect(response.status).toBe(200)

    expect(seenUsage).toMatchObject({
      cacheTtlS: 86_400,
      cacheTtlRequested: false,
    })
  })

  test("uses the automatic-cache rule when routed to chat completions", async () => {
    stubFetch(chatResult)

    const response = await post("/v1/messages", messagesBody("chat-only"))
    expect(response.status).toBe(200)

    expect(seenUsage).toMatchObject({
      cacheTtlS: 300,
      cacheTtlRequested: false,
    })
  })

  test("uses the automatic-cache rule on the web-tools path", async () => {
    stubFetch(chatResult)

    const response = await post(
      "/v1/messages",
      messagesBody("chat-only", {
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    )
    expect(response.status).toBe(200)

    expect(seenUsage).toMatchObject({
      cacheTtlS: 300,
      cacheTtlRequested: false,
    })
  })
})

describe("messages route persists the requested cache lifetime", () => {
  let dir: string
  let dbPath: string

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meta-routes-"))
    dbPath = path.join(dir, "usage.sqlite")
    await closeUsageStore()
    process.env[DB_PATH_ENV] = dbPath
  })

  afterEach(async () => {
    await closeUsageStore()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("a ttl 1h cache_control is stored as 3600 and requested", async () => {
    stubFetch(claudeResult)

    const response = await post("/v1/messages", messagesBody("claude-test"))
    expect(response.status).toBe(200)

    await closeUsageStore()
    const db = await openSqliteDatabase(dbPath)
    const rows = db
      .prepare(
        "SELECT cache_ttl_s, cache_ttl_requested FROM token_usage_events",
      )
      .all() as Array<{ cache_ttl_s: number; cache_ttl_requested: number }>
    db.close?.()
    expect(rows).toEqual([{ cache_ttl_s: 3600, cache_ttl_requested: 1 }])
  })
})

describe("usage.sessionId matches the recorded session_id", () => {
  const legacyUserId = "user_abc_account_xyz_session_sess-9"

  test("messages: the metadata session id, not the hashed root id", async () => {
    stubFetch(claudeResult)
    await post("/v1/messages", {
      model: "claude-test",
      max_tokens: 16,
      metadata: { user_id: legacyUserId },
      messages: [{ role: "user", content: "hi" }],
    })

    expect(seenUsage?.sessionId).toBe("sess-9")
    expect(await recordedSessionIds()).toEqual(["sess-9"])
  })

  test("messages: x-session-affinity wins", async () => {
    stubFetch(claudeResult)
    await post(
      "/v1/messages",
      {
        model: "claude-test",
        max_tokens: 16,
        metadata: { user_id: legacyUserId },
        messages: [{ role: "user", content: "hi" }],
      },
      { "x-session-affinity": "affinity-1" },
    )

    expect(seenUsage?.sessionId).toBe("affinity-1")
    expect(await recordedSessionIds()).toEqual(["affinity-1"])
  })

  test("responses: x-session-affinity wins over prompt_cache_key", async () => {
    __setCreateResponsesForTests((() => {
      snapshotUsage()
      return Promise.resolve(responsesResult())
    }) as never)
    await post(
      "/v1/responses",
      { model: "gpt-test", input: "hello", prompt_cache_key: "conv-1" },
      { "x-session-affinity": "affinity-2" },
    )

    expect(seenUsage?.sessionId).toBe("affinity-2")
    expect(await recordedSessionIds()).toEqual(["affinity-2"])
  })

  test("chat completions: x-session-affinity wins", async () => {
    stubFetch(chatResult)
    await post(
      "/v1/chat/completions",
      { model: "chat-only", messages: [{ role: "user", content: "hello" }] },
      { "x-session-affinity": "affinity-3" },
    )

    expect(seenUsage?.sessionId).toBe("affinity-3")
    expect(await recordedSessionIds()).toEqual(["affinity-3"])
  })
})
