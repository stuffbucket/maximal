import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"

import type { BudgetHold } from "~/lib/budget/service"
import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"
import type { PersistedTokenUsageEvent } from "~/lib/token-usage/store"

import { state } from "~/lib/runtime-state/state"
import { handleWithMessagesApi } from "~/routes/messages/api-flows"

import { noopBudgetHold } from "./helpers/budget-hold"

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  manualApprove: state.manualApprove,
  models: state.models,
  vsCodeVersion: state.vsCodeVersion,
}

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.manualApprove = false
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  Object.assign(state, originalState)
})

function interruptedBilledStream(): Response {
  const start = {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "gpt-test",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
      copilot_usage: { total_nano_aiu: 250_000_000 },
    },
  }
  const bytes = new TextEncoder().encode(
    `event: message_start\ndata: ${JSON.stringify(start)}\n\n`,
  )
  let sent = false
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(bytes)
          return
        }
        controller.error(new Error("stream dropped"))
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

test("an interrupted Messages stream settles authoritative cost", async () => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
    Promise.resolve(interruptedBilledStream())) as unknown as typeof fetch

  const settled: Array<{
    events: ReadonlyArray<PersistedTokenUsageEvent>
    nanoAiu: number | undefined
  }> = []
  let unreconciled = 0
  const hold: BudgetHold = {
    ...noopBudgetHold(),
    id: "held-chat",
    estimateNanoAiu: 600_000_000,
    persisted: true,
    settle(events, actual) {
      settled.push({ events, nanoAiu: actual?.nanoAiu })
      return Promise.resolve()
    },
    unreconcile() {
      unreconciled += 1
      return Promise.resolve()
    },
  }
  const payload: AnthropicMessagesPayload = {
    model: "gpt-test",
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithMessagesApi(c, payload, {
      hold,
      logger: { debug() {}, warn() {}, error() {} } as never,
      requestId: "req-1",
      sessionId: "sess-1",
    }),
  )

  await (await app.request("/", { method: "POST" })).text()

  expect(unreconciled).toBe(0)
  expect(settled).toHaveLength(1)
  expect(settled[0]?.nanoAiu).toBe(250_000_000)
  expect(settled[0]?.events).toHaveLength(1)
  expect(settled[0]?.events[0]).toMatchObject({
    input_tokens: 10,
    total_nano_aiu: 250_000_000,
  })
})
