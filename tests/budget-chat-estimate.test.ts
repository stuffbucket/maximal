import { afterEach, describe, expect, test } from "bun:test"

import { admitChat, estimateChatNanoAiu } from "~/lib/budget/runtime"
import { requestContext } from "~/lib/http/request-context"
import { state } from "~/lib/runtime-state/state"

import { event, harness, limit } from "./helpers/budget-service-harness"

const originalModels = state.models

afterEach(() => {
  state.models = originalModels
})

function setPrices(tokenPrices: Record<string, unknown>): void {
  state.models = {
    object: "list",
    data: [
      {
        id: "priced-model",
        billing: { token_prices: tokenPrices },
      },
    ],
  } as typeof state.models
}

describe("provisional chat cost", () => {
  test("prices the maximum output tokens from the catalog's default tier", () => {
    setPrices({ default: { input_price: 0.25, output_price: 2 } })

    expect(estimateChatNanoAiu("priced-model", 1_000)).toBe(2_000_000)
  })

  test("supports the legacy flat output price", () => {
    setPrices({ input: 0.25, output: 1.5 })

    expect(estimateChatNanoAiu("priced-model", 2_000)).toBe(3_000_000)
  })

  test("does not invent an estimate without a usable model ceiling or price", () => {
    setPrices({ default: { input_price: 0.25 } })

    expect(estimateChatNanoAiu("priced-model", 1_000)).toBe(0)
    expect(estimateChatNanoAiu("missing", 1_000)).toBe(0)
    expect(estimateChatNanoAiu("priced-model", undefined)).toBe(0)
    expect(estimateChatNanoAiu("priced-model", 0)).toBe(0)
  })

  test("a resumed request still opens its durable provisional hold", async () => {
    setPrices({ default: { output_price: 2 } })
    const h = harness([limit({ id: "all", limit: 1 })])
    h.emit(event({ nanoAiu: 1 }))

    const hold = await requestContext.run(
      {
        traceId: "resumed",
        startTime: 0,
        userAgent: "",
        sessionAffinity: undefined,
        parentSessionId: undefined,
        usage: {},
        budgetCleared: true,
      },
      () =>
        admitChat(
          "messages",
          { model: "priced-model", maxTokens: 1_000 },
          h.service,
        ),
    )

    expect(hold.persisted).toBe(true)
    expect(h.calls.opened).toHaveLength(1)
    expect(h.calls.opened[0]?.estimateNanoAiu).toBe(2_000_000)
  })
})
