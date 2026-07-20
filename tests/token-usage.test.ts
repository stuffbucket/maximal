import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { requestContext } from "~/lib/http/request-context"
import { traceIdMiddleware } from "~/lib/http/trace"
import { state } from "~/lib/runtime-state/state"
import {
  closeUsageStore,
  createCopilotTokenUsageRecorder,
  pruneTokenUsageEvents,
  recordTokenUsageEvent,
  type TokenUsageEventsPage,
  type TokenUsageSeries,
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

  test("events page carries per-event total_nano_aiu and is_premium", async () => {
    // Paid catalog entry so is_premium resolves to 1 (token_prices wins).
    seedModel("gpt-a", {
      is_premium: false,
      token_prices: { input: 0.25, output: 2.0 },
    })
    recordTokenUsageEvent({
      endpoint: "responses",
      input_tokens: 10,
      output_tokens: 5,
      model: "gpt-a",
      source: "copilot",
      total_nano_aiu: 22775000,
    })

    const page = await fetchEventsPage()
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.total_nano_aiu).toBe(22775000)
    expect(page.items[0]?.is_premium).toBe(true)
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
 * Provider dimension, time-series, and the `all` period — the additions that
 * power the reworked Usage view (§4). Providers/series are computed by the store
 * and surfaced over the same route.
 */
describe("token usage provider dimension + series + all period", () => {
  test("summary groups by provider (copilot + external)", async () => {
    recordTokenUsageEvent({
      endpoint: "chat_completions",
      input_tokens: 10,
      model: "gpt-a",
      output_tokens: 5,
      source: "copilot",
    })
    recordTokenUsageEvent({
      endpoint: "provider_messages",
      input_tokens: 20,
      model: "claude-a",
      output_tokens: 7,
      providerName: "anthropic",
      source: "provider",
    })

    const response = await createTokenUsageApp().request(
      "/token-usage?period=day",
    )
    expect(response.status).toBe(200)
    const summary = (await response.json()) as TokenUsageSummary

    expect(summary.byProvider).toHaveLength(2)
    const byKey = new Map(summary.byProvider.map((row) => [row.provider, row]))
    expect(byKey.get("copilot")?.total_tokens).toBe(15)
    expect(byKey.get("copilot")?.source).toBe("copilot")
    expect(byKey.get("anthropic")?.total_tokens).toBe(27)
    expect(byKey.get("anthropic")?.source).toBe("provider")
    expect(byKey.get("anthropic")?.provider_name).toBe("anthropic")
    // Totals across providers reconcile with the grand total.
    const providerSum = summary.byProvider.reduce(
      (acc, row) => acc + row.total_tokens,
      0,
    )
    expect(providerSum).toBe(summary.totals.total_tokens)
  })

  test("series buckets sum to the summary total (day → hourly, zero-filled)", async () => {
    recordTokenUsageEvent({
      endpoint: "responses",
      input_tokens: 30,
      model: "gpt-a",
      output_tokens: 12,
      source: "copilot",
    })

    const response = await createTokenUsageApp().request(
      "/token-usage/series?period=day",
    )
    expect(response.status).toBe(200)
    const series = (await response.json()) as TokenUsageSeries

    // Day defaults to hourly buckets; the axis is zero-filled across the day.
    expect(series.bucket_ms).toBe(3_600_000)
    expect(series.buckets.length).toBeGreaterThanOrEqual(23)
    expect(series.buckets.length).toBeLessThanOrEqual(25)
    const bucketSum = series.buckets.reduce((acc, b) => acc + b.total_tokens, 0)
    expect(bucketSum).toBe(42)
    // Exactly one bucket carries the traffic; the rest are zero-fill.
    expect(series.buckets.filter((b) => b.total_tokens > 0)).toHaveLength(1)
  })

  test("series honours an explicit bucket width shorthand", async () => {
    const response = await createTokenUsageApp().request(
      "/token-usage/series?period=day&bucket=15m",
    )
    expect(response.status).toBe(200)
    const series = (await response.json()) as TokenUsageSeries
    expect(series.bucket_ms).toBe(15 * 60_000)
  })

  test("all period is a real range (start at epoch), not coerced to day", async () => {
    recordTokenUsageEvent({
      endpoint: "responses",
      input_tokens: 10,
      model: "gpt-a",
      output_tokens: 5,
      source: "copilot",
    })

    const response = await createTokenUsageApp().request(
      "/token-usage?period=all",
    )
    expect(response.status).toBe(200)
    const summary = (await response.json()) as TokenUsageSummary
    // Regression: "all" previously fell through to "day" (start = midnight).
    // The all-time range starts at the epoch.
    expect(summary.period).toBe("all")
    expect(summary.range.start_ms).toBe(0)
    expect(summary.totals.total_tokens).toBe(15)
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

describe("token usage retention", () => {
  test("pruneTokenUsageEvents deletes only rows older than the cutoff", async () => {
    for (const input_tokens of [10, 8]) {
      recordTokenUsageEvent({
        endpoint: "chat_completions",
        input_tokens,
        model: "gpt-test",
        output_tokens: 2,
        source: "copilot",
      })
    }

    // The range is half-open (`created_at_ms < cutoff`): nothing predates the
    // epoch, so a cutoff of 0 removes nothing.
    expect(await pruneTokenUsageEvents(0)).toBe(0)
    expect((await fetchEventsPage()).total).toBe(2)

    // Every row predates a far-future cutoff, so all are pruned and counted.
    expect(await pruneTokenUsageEvents(Date.now() + 60_000)).toBe(2)
    expect((await fetchEventsPage()).total).toBe(0)
  })
})
