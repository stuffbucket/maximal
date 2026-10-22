/**
 * Anthropic-typed errors on the `/v1/messages` surface. Claude Code (the
 * Anthropic SDK) decides how to recover from the error's typed envelope:
 * `overloaded_error` / 529 is retried with backoff, and a `prompt is too
 * long: N tokens > M maximum` message triggers auto-compaction. These tests
 * pin the classification and the envelope so a regression shows up here
 * rather than as a dead-end error in the client.
 */

import { describe, expect, test } from "bun:test"

import {
  anthropicErrorType,
  classifyUpstreamError,
  contextOverflowMessage,
  isTransientUpstreamStatus,
} from "~/lib/errors/anthropic-error"
import { forwardAnthropicError, HTTPError } from "~/lib/errors/error"
import { messageRoutes } from "~/routes/messages/route"
import { providerMessageRoutes } from "~/routes/provider/messages/route"

describe("anthropicErrorType", () => {
  test.each([
    [400, "invalid_request_error"],
    [401, "authentication_error"],
    [402, "billing_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [413, "request_too_large"],
    [422, "invalid_request_error"],
    [429, "rate_limit_error"],
    [500, "api_error"],
    [529, "overloaded_error"],
  ] as const)("%i → %s", (status, type) => {
    expect(anthropicErrorType(status)).toBe(type)
  })
})

describe("isTransientUpstreamStatus", () => {
  test("gateway and availability failures are transient", () => {
    for (const s of [500, 502, 503, 504]) {
      expect(isTransientUpstreamStatus(s)).toBe(true)
    }
  })

  test("client errors and rate limits are not", () => {
    for (const s of [400, 401, 403, 404, 429, 501]) {
      expect(isTransientUpstreamStatus(s)).toBe(false)
    }
  })
})

describe("contextOverflowMessage", () => {
  test("keeps Anthropic's own wording", () => {
    expect(
      contextOverflowMessage(
        "prompt is too long: 210000 tokens > 200000 maximum",
      ),
    ).toBe("prompt is too long: 210000 tokens > 200000 maximum")
  })

  test("rewords Copilot's chat-completions limit message", () => {
    expect(
      contextOverflowMessage(
        "prompt token count of 135000 exceeds the limit of 128000",
      ),
    ).toBe("prompt is too long: 135000 tokens > 128000 maximum")
  })

  test("rewords OpenAI's maximum-context-length message", () => {
    expect(
      contextOverflowMessage(
        "This model's maximum context length is 400000 tokens. However, your messages resulted in 412345 tokens.",
      ),
    ).toBe("prompt is too long: 412345 tokens > 400000 maximum")
  })

  test("falls back to a prefixed message when the counts aren't stated", () => {
    expect(
      contextOverflowMessage(
        "Your input exceeds the context window of this model.",
      ),
    ).toBe(
      "prompt is too long: Your input exceeds the context window of this model.",
    )
  })

  test("returns null for unrelated errors", () => {
    expect(contextOverflowMessage("model is not supported")).toBeNull()
    expect(contextOverflowMessage("rate limit exceeded")).toBeNull()
  })
})

describe("classifyUpstreamError", () => {
  test("a transient upstream 5xx becomes 529 overloaded_error", () => {
    expect(classifyUpstreamError(502, "Bad gateway")).toEqual({
      status: 529,
      type: "overloaded_error",
      message: "Bad gateway",
    })
  })

  test("a context overflow becomes a 400 Claude Code can compact on", () => {
    expect(
      classifyUpstreamError(
        400,
        "prompt token count of 135000 exceeds the limit of 128000",
      ),
    ).toEqual({
      status: 400,
      type: "invalid_request_error",
      message: "prompt is too long: 135000 tokens > 128000 maximum",
    })
  })

  test("a token rate limit is never mistaken for an overflow", () => {
    expect(
      classifyUpstreamError(429, "context window token rate limit exceeded"),
    ).toEqual({
      status: 429,
      type: "rate_limit_error",
      message: "context window token rate limit exceeded",
    })
  })

  test("other statuses keep their status and get the matching type", () => {
    expect(classifyUpstreamError(429, "slow down")).toEqual({
      status: 429,
      type: "rate_limit_error",
      message: "slow down",
    })
  })
})

interface Captured {
  body: unknown
  status: number
  headers: Record<string, string>
}

function contextStub(): {
  ctx: {
    json: (body: unknown, status?: number) => Response
    header: (name: string, value: string) => void
  }
  captured: Captured
} {
  const captured: Captured = { body: undefined, status: 0, headers: {} }
  return {
    captured,
    ctx: {
      json(body, status = 200) {
        captured.body = body
        captured.status = status
        return new Response(JSON.stringify(body), { status })
      },
      header(name, value) {
        captured.headers[name] = value
      },
    },
  }
}

function upstream(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): HTTPError {
  return new HTTPError("upstream", new Response(body, { status, headers }))
}

describe("forwardAnthropicError", () => {
  test("wraps upstream errors in Anthropic's typed envelope", async () => {
    const { ctx, captured } = contextStub()
    await forwardAnthropicError(
      ctx as never,
      upstream(404, JSON.stringify({ error: { message: "no such route" } })),
    )
    expect(captured.status).toBe(404)
    expect(captured.body).toEqual({
      type: "error",
      error: { type: "not_found_error", message: "no such route" },
    })
  })

  test("promotes a transient 503 to 529 and relays Retry-After", async () => {
    const { ctx, captured } = contextStub()
    await forwardAnthropicError(
      ctx as never,
      upstream(503, "Service Unavailable", { "retry-after": "7" }),
    )
    expect(captured.status).toBe(529)
    expect(captured.headers["retry-after"]).toBe("7")
    expect(captured.body).toEqual({
      type: "error",
      error: { type: "overloaded_error", message: "Service Unavailable" },
    })
  })

  test("rewords a context overflow so Claude Code auto-compacts", async () => {
    const { ctx, captured } = contextStub()
    await forwardAnthropicError(
      ctx as never,
      upstream(
        400,
        JSON.stringify({
          error: {
            message: "prompt token count of 135000 exceeds the limit of 128000",
            code: "model_max_prompt_tokens_exceeded",
          },
        }),
      ),
    )
    expect(captured.status).toBe(400)
    expect(captured.body).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 135000 tokens > 128000 maximum",
      },
    })
  })

  test("a proxy-internal exception stays a 500 api_error", async () => {
    const { ctx, captured } = contextStub()
    await forwardAnthropicError(ctx as never, new Error("boom"))
    expect(captured.status).toBe(500)
    expect(captured.body).toEqual({
      type: "error",
      error: { type: "api_error", message: "boom" },
    })
  })
})

describe("Anthropic-wire routes use the typed envelope", () => {
  test("/v1/messages wraps a handler failure", async () => {
    const res = await messageRoutes.request("/", {
      method: "POST",
      body: "not json",
    })
    const body = (await res.json()) as { type?: string }
    expect(body.type).toBe("error")
  })

  test("an unknown provider is a typed not_found_error", async () => {
    const res = await providerMessageRoutes.request("/", {
      method: "POST",
      body: "{}",
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
      "not_found_error",
    )
  })
})
