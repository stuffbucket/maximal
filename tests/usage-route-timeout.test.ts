import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { forwardError } from "../src/lib/errors/error"
import { proxyErrorHandler } from "../src/lib/errors/proxy-errors"
import { state } from "../src/lib/runtime-state/state"
import { usageRoute } from "../src/routes/usage/route"

const originalFetch = globalThis.fetch
const originalGithubToken = state.githubToken

afterEach(() => {
  globalThis.fetch = originalFetch
  state.githubToken = originalGithubToken
})

/** What Bun's fetch rejects with when `AbortSignal.timeout` fires. */
function timeoutError(): DOMException {
  return new DOMException("The operation timed out.", "TimeoutError")
}

describe("a GitHub read that times out", () => {
  test("GET /usage answers 504 with a plain message", async () => {
    state.githubToken = "gho_test"
    globalThis.fetch = (() =>
      Promise.reject(timeoutError())) as unknown as typeof fetch
    const app = new Hono().route("/usage", usageRoute)

    const response = await app.request("/usage")

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({
      error: {
        message: "GitHub didn't respond in time. Try again in a moment.",
        type: "upstream_timeout",
      },
    })
  })

  test("forwardError maps any timeout to 504, other failures stay 500", async () => {
    const app = new Hono()
      .get("/timeout", (c) => forwardError(c, timeoutError()))
      .get("/abort", (c) =>
        forwardError(c, new DOMException("Aborted", "AbortError")),
      )
      .get("/other", (c) => forwardError(c, new Error("boom")))

    expect((await app.request("/timeout")).status).toBe(504)
    expect((await app.request("/abort")).status).toBe(500)
    const other = await app.request("/other")
    expect(other.status).toBe(500)
    expect(await other.json()).toEqual({
      error: { message: "boom", type: "error" },
    })
  })

  test("the inference routes' handler is unchanged", async () => {
    for (const wire of ["openai", "anthropic"] as const) {
      const app = new Hono()
      app.onError(proxyErrorHandler(wire))
      app.get("/", () => {
        throw timeoutError()
      })
      const response = await app.request("/")
      expect(response.status).toBe(500)
      expect(JSON.stringify(await response.json())).toContain(
        "The operation timed out.",
      )
    }
  })
})
