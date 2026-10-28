import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { requestContext } from "~/lib/http/request-context"
import { traceIdMiddleware } from "~/lib/http/trace"
import { openSqliteDatabase } from "~/lib/platform/sqlite"
import { state } from "~/lib/runtime-state/state"
import {
  closeUsageStore,
  createCopilotTokenUsageRecorder,
  recordTokenUsageEvent,
  type TokenUsageEventsPage,
  type TokenUsageSummary,
} from "~/lib/token-usage"
import { tokenUsageRoute } from "~/routes/token-usage/route"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  state.userName = "copilot-login"
  await closeUsageStore()
})

afterEach(async () => {
  await closeUsageStore()
  state.userName = undefined
  state.models = undefined
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

function createTokenUsageApp(): Hono {
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.route("/token-usage", tokenUsageRoute)
  return app
}

async function fetchEventsPage(pageSize = 20): Promise<TokenUsageEventsPage> {
  const response = await createTokenUsageApp().request(
    `/token-usage/events?period=day&page=1&page_size=${pageSize}`,
  )
  expect(response.status).toBe(200)
  return (await response.json()) as TokenUsageEventsPage
}

describe("token usage storage", () => {
  test("records trace id and prefers x-session-affinity for session id", async () => {
    requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: "opencode-session",
        startTime: Date.now(),
        traceId: "trace-123",
        usage: {},
        userAgent: "test",
      },
      () => {
        recordTokenUsageEvent({
          endpoint: "messages",
          input_tokens: 10,
          model: "gpt-test",
          output_tokens: 5,
          sessionId: "claude-session",
          source: "copilot",
        })
      },
    )

    const page = await fetchEventsPage()
    const row = page.items[0]
    expect(row.trace_id).toBe("trace-123")
    expect(row.session_id).toBe("opencode-session")
    expect(row.user_id).toBe("copilot-login")
    expect(row.total_tokens).toBe(15)
  })

  test("uses explicit metadata session id when no session affinity exists", async () => {
    recordTokenUsageEvent({
      endpoint: "provider_messages",
      input_tokens: 12,
      model: "claude-test",
      output_tokens: 4,
      providerName: "anthropic",
      sessionId: "claude-session",
      source: "provider",
    })

    const page = await fetchEventsPage()
    const row = page.items[0]
    expect(typeof row.trace_id).toBe("string")
    expect(row.trace_id.length).toBeGreaterThan(0)
    expect(row.session_id).toBe("claude-session")
    expect(row.user_id).toBe("anthropic")
    expect(row.total_tokens).toBe(16)
  })

  test("does not write zero-token usage events", async () => {
    recordTokenUsageEvent({
      endpoint: "chat_completions",
      input_tokens: 0,
      model: "gpt-test",
      output_tokens: 0,
      source: "copilot",
    })

    const response = await createTokenUsageApp().request(
      "/token-usage?period=day",
    )
    expect(response.status).toBe(200)
    const summary = (await response.json()) as TokenUsageSummary
    expect(summary.totals.request_count).toBe(0)
  })

  test("summarizes by model with total token and user fields", async () => {
    recordTokenUsageEvent({
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
      endpoint: "chat_completions",
      input_tokens: 10,
      model: "gpt-a",
      output_tokens: 3,
      source: "copilot",
    })
    recordTokenUsageEvent({
      cache_read_input_tokens: 4,
      endpoint: "responses",
      input_tokens: 20,
      model: "gpt-b",
      output_tokens: 6,
      source: "copilot",
    })

    const response = await createTokenUsageApp().request(
      "/token-usage?period=day",
    )
    expect(response.status).toBe(200)

    const summary = (await response.json()) as TokenUsageSummary
    expect(summary.totals).toEqual({
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 6,
      input_tokens: 30,
      output_tokens: 9,
      request_count: 2,
      total_tokens: 46,
      total_nano_aiu: 0,
    })
    expect(summary.totals.total_tokens).toBe(46)
    expect(summary.byModel).toHaveLength(2)
    expect(summary.byModel.every((row) => row.total_tokens > 0)).toBe(true)
  })

  test("captures and sums total_nano_aiu cost across events", async () => {
    recordTokenUsageEvent({
      endpoint: "responses",
      input_tokens: 10,
      output_tokens: 5,
      model: "gpt-a",
      source: "copilot",
      total_nano_aiu: 22775000,
    })
    recordTokenUsageEvent({
      endpoint: "responses",
      input_tokens: 8,
      output_tokens: 4,
      model: "gpt-a",
      source: "copilot",
      total_nano_aiu: 20400000,
    })

    const response = await createTokenUsageApp().request(
      "/token-usage?period=day",
    )
    const summary = (await response.json()) as TokenUsageSummary
    expect(summary.totals.total_nano_aiu).toBe(43175000)
    expect(summary.byModel[0].total_nano_aiu).toBe(43175000)
  })

  test("returns paginated usage events with user id", async () => {
    recordTokenUsageEvent({
      endpoint: "chat_completions",
      input_tokens: 10,
      model: "gpt-a",
      output_tokens: 2,
      source: "copilot",
    })
    recordTokenUsageEvent({
      endpoint: "provider_messages",
      input_tokens: 20,
      model: "claude-a",
      output_tokens: 5,
      providerName: "anthropic",
      sessionId: "claude-session",
      source: "provider",
      traceId: "trace-provider",
    })

    const response = await createTokenUsageApp().request(
      "/token-usage/events?period=day&page=1&page_size=1",
    )
    expect(response.status).toBe(200)

    const page = (await response.json()) as TokenUsageEventsPage
    expect(page.total).toBe(2)
    expect(page.page).toBe(1)
    expect(page.page_size).toBe(1)
    expect(page.total_pages).toBe(2)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.user_id).toBe("anthropic")
    expect(page.items[0]?.trace_id).toBe("trace-provider")
    expect(page.items[0]?.session_id).toBe("claude-session")
    expect(page.items[0]?.total_tokens).toBe(25)
  })

  test("only falls back to interaction id when no real session id exists", async () => {
    const recordWithFallback = createCopilotTokenUsageRecorder({
      endpoint: "responses",
      fallbackSessionId: "interaction-session",
      model: "gpt-test",
    })
    const recordWithRealSession = createCopilotTokenUsageRecorder({
      endpoint: "responses",
      fallbackSessionId: "ignored-interaction-session",
      model: "gpt-test",
      sessionId: "real-session",
    })

    recordWithFallback({
      input_tokens: 5,
    })
    recordWithRealSession({
      input_tokens: 7,
    })

    const page = await fetchEventsPage(10)
    expect(page.items).toHaveLength(2)
    expect(page.items[0]?.session_id).toBe("real-session")
    expect(page.items[1]?.session_id).toBe("interaction-session")
  })
})

/**
 * Pricing signal migration (ADR-0016 divergence 1, issue #259).
 *
 * The persisted `is_premium` column is the paid/free signal (1/0/NULL). Its
 * *source* moved from the legacy `billing.is_premium` flag to Copilot's
 * per-token `billing.token_prices`; `is_premium` is now only the fallback used
 * when `token_prices` is absent (older catalogs / annual-plan accounts).
 */
function seedModel(id: string, billing: Model["billing"]): void {
  const model = {
    id,
    name: id,
    object: "model",
    vendor: "copilot",
    version: "1",
    model_picker_enabled: true,
    preview: false,
    capabilities: {
      family: id,
      object: "model_capabilities",
      type: "chat",
      tokenizer: "o200k_base",
      limits: {},
      supports: {},
    },
    billing,
  } as Model
  const models: ModelsResponse = { object: "list", data: [model] }
  state.models = models
}

async function recordAndReadPremium(model: string): Promise<boolean | null> {
  recordTokenUsageEvent({
    endpoint: "responses",
    input_tokens: 10,
    output_tokens: 5,
    model,
    source: "copilot",
  })
  // `is_premium` (the paid/free signal) is surfaced per-model in the summary,
  // not the events page — read it from there.
  const response = await createTokenUsageApp().request(
    "/token-usage?period=day",
  )
  expect(response.status).toBe(200)
  const summary = (await response.json()) as TokenUsageSummary
  return summary.byModel.find((m) => m.model === model)?.is_premium ?? null
}

describe("token usage pricing signal (token_prices)", () => {
  test("prices from token_prices when present (any non-zero rate ⇒ paid)", async () => {
    // gpt-5-mini: is_premium===false (legacy) but token_prices says paid.
    // token_prices must win, otherwise a paid model reads as free.
    seedModel("gpt-5-mini", {
      is_premium: false,
      token_prices: { input: 0.25, output: 2.0 },
    })
    expect(await recordAndReadPremium("gpt-5-mini")).toBe(true)
  })

  test("token_prices all-zero reads as free even if is_premium is true", async () => {
    seedModel("free-model", {
      is_premium: true,
      token_prices: { input: 0, output: 0 },
    })
    expect(await recordAndReadPremium("free-model")).toBe(false)
  })

  test("falls back to legacy is_premium when token_prices is absent", async () => {
    seedModel("legacy-premium", { is_premium: true })
    expect(await recordAndReadPremium("legacy-premium")).toBe(true)

    await closeUsageStore()
    seedModel("legacy-included", { is_premium: false })
    expect(await recordAndReadPremium("legacy-included")).toBe(false)
  })

  test("unknown when the model is absent from the catalog", async () => {
    seedModel("some-other-model", { token_prices: { input: 1 } })
    expect(await recordAndReadPremium("not-in-catalog")).toBeNull()
  })

  test("unknown when billing carries neither token_prices nor is_premium", async () => {
    seedModel("bare", {})
    expect(await recordAndReadPremium("bare")).toBeNull()
  })
})

describe("token usage client, cache and context columns", () => {
  let dir: string
  let dbPath: string

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-usage-cols-"))
    dbPath = path.join(dir, "usage.sqlite")
    await closeUsageStore()
    process.env[DB_PATH_ENV] = dbPath
  })

  afterEach(async () => {
    await closeUsageStore()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function readRows(): Promise<Array<Record<string, unknown>>> {
    await closeUsageStore()
    const db = await openSqliteDatabase(dbPath)
    try {
      return db
        .prepare("SELECT * FROM token_usage_events ORDER BY id")
        .all() as Array<Record<string, unknown>>
    } finally {
      db.close?.()
    }
  }

  test("migrates a version 1 database and reads old rows with defaults", async () => {
    const old = await openSqliteDatabase(dbPath)
    old.exec(`
      CREATE TABLE token_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at_ms INTEGER NOT NULL,
        created_at_utc TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        provider_name TEXT,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        total_nano_aiu INTEGER NOT NULL DEFAULT 0,
        is_premium INTEGER
      )
    `)
    old
      .prepare(
        `INSERT INTO token_usage_events
          (created_at_ms, created_at_utc, trace_id, source, endpoint, model, total_tokens)
         VALUES (?, ?, 'old-trace', 'copilot', 'messages', 'gpt-old', 9)`,
      )
      .run(Date.now(), new Date().toISOString())
    old.exec("PRAGMA user_version = 1")
    old.close?.()

    recordTokenUsageEvent({
      endpoint: "messages",
      input_tokens: 1,
      model: "gpt-new",
      source: "copilot",
    })

    const [oldRow, newRow] = await readRows()
    expect(oldRow).toMatchObject({
      model: "gpt-old",
      client: "other",
      client_label: null,
      cache_ttl_s: 0,
      cache_ttl_requested: 0,
      is_compact: 0,
      context_window_tokens: null,
      context_ceiling_tokens: null,
      compact_at_tokens: null,
      window_source: null,
    })
    expect(newRow.model).toBe("gpt-new")

    const db = await openSqliteDatabase(dbPath)
    const version = db.prepare("PRAGMA user_version").get() as {
      user_version: number
    }
    db.close?.()
    expect(version.user_version).toBe(2)
  })

  test("stores the client, cache lifetime and context window of the request", async () => {
    requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: undefined,
        startTime: Date.now(),
        traceId: "trace-ctx",
        usage: {
          apiKeyLabel: "codex",
          cacheTtlS: 300,
          cacheTtlRequested: true,
          isCompact: true,
          context: {
            windowTokens: 272_000,
            ceilingTokens: 258_000,
            compactAtTokens: 200_000,
            source: "codex-catalog",
          },
        },
        userAgent: "codex_cli_rs/0.1",
      },
      () => {
        recordTokenUsageEvent({
          endpoint: "responses",
          input_tokens: 10,
          model: "gpt-test",
          source: "copilot",
        })
      },
    )

    const [row] = await readRows()
    expect(row).toMatchObject({
      client: "codex",
      client_label: "codex",
      cache_ttl_s: 300,
      cache_ttl_requested: 1,
      is_compact: 1,
      context_window_tokens: 272_000,
      context_ceiling_tokens: 258_000,
      compact_at_tokens: 200_000,
      window_source: "codex-catalog",
    })
  })

  test("falls back to the user agent for the client when the key has no known label", async () => {
    requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: undefined,
        startTime: Date.now(),
        traceId: "trace-ua",
        usage: { apiKeyLabel: "my-key" },
        userAgent: "claude-cli/2.1.0 (external, cli)",
      },
      () => {
        recordTokenUsageEvent({
          endpoint: "messages",
          input_tokens: 1,
          model: "claude-test",
          source: "copilot",
        })
      },
    )

    const [row] = await readRows()
    expect(row).toMatchObject({
      client: "claude-code",
      client_label: "my-key",
      cache_ttl_s: 0,
      cache_ttl_requested: 0,
      is_compact: 0,
      context_window_tokens: null,
      window_source: null,
    })
  })

  test("persists an event recorded outside any request with defaults", async () => {
    recordTokenUsageEvent({
      endpoint: "embeddings",
      input_tokens: 4,
      model: "embed-test",
      source: "copilot",
    })

    const [row] = await readRows()
    expect(row).toMatchObject({
      client: "other",
      client_label: null,
      cache_ttl_s: 0,
      cache_ttl_requested: 0,
      is_compact: 0,
      context_window_tokens: null,
      context_ceiling_tokens: null,
      compact_at_tokens: null,
      window_source: null,
    })
  })
})
