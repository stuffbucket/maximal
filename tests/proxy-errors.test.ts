/**
 * The inference routes' error handler (`proxy-errors.ts`): rewrites run in
 * order and can't break the reply or turn it into a success, replies render
 * in each wire's format, and a route module's `onError` answers for errors
 * its handlers throw, including "not signed in" from the token gate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { requireGithubAuth } from "~/lib/auth/request-auth"
import { HTTPError } from "~/lib/errors/http-errors"
import {
  applyRewrites,
  proxyErrorHandler,
  type ProxyErrorEvent,
  type ProxyErrorReply,
  type ProxyErrorRewrite,
  renderProxyError,
} from "~/lib/errors/proxy-errors"
import { state } from "~/lib/runtime-state/state"
import { completionRoutes } from "~/routes/chat-completions/route"
import { messageRoutes } from "~/routes/messages/route"
import { providerMessageRoutes } from "~/routes/provider/messages/route"
import { responsesRoutes } from "~/routes/responses/route"

const event: ProxyErrorEvent = { wire: "anthropic", error: new Error("x") }
const base: ProxyErrorReply = { status: 500, type: "api_error", message: "x" }

const broken: ProxyErrorRewrite = () => {
  throw new Error("bug")
}
const setOk: ProxyErrorRewrite = (reply) => ({ ...reply, message: "ok" })
const toSuccess: ProxyErrorRewrite = (reply) => ({ ...reply, status: 200 })
const toRedirect: ProxyErrorRewrite = (reply) => ({ ...reply, status: 302 })

/** A route module whose only handler throws `error`. */
function routes(wire: "anthropic" | "openai", error: unknown): Hono {
  const app = new Hono()
  app.onError(proxyErrorHandler(wire))
  app.post("/", () => {
    throw error
  })
  return app
}

function upstream429(): HTTPError {
  return new HTTPError(
    "upstream",
    new Response(JSON.stringify({ error: { message: "slow down" } }), {
      status: 429,
      headers: { "retry-after": "3", "x-ratelimit-remaining": "0" },
    }),
  )
}

describe("applyRewrites", () => {
  test("runs in order, each seeing the reply so far", () => {
    const seen: Array<string> = []
    const first: ProxyErrorRewrite = (reply) => {
      seen.push(reply.message)
      return { ...reply, message: "first" }
    }
    const keep: ProxyErrorRewrite = (reply) => {
      seen.push(reply.message)
      return undefined
    }
    const second: ProxyErrorRewrite = (reply) => {
      seen.push(reply.message)
      return { ...reply, status: 503, message: "second" }
    }
    const reply = applyRewrites(base, event, [first, keep, second])
    expect(seen).toEqual(["x", "first", "first"])
    expect(reply).toMatchObject({ status: 503, message: "second" })
  })

  test("a rewrite that throws is skipped", () => {
    expect(applyRewrites(base, event, [broken, setOk]).message).toBe("ok")
  })

  test("a rewrite can't turn the reply into a success", () => {
    expect(applyRewrites(base, event, [toSuccess, toRedirect]).status).toBe(500)
  })
})

async function render(
  wire: "anthropic" | "openai",
  reply: ProxyErrorReply,
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const app = new Hono()
  app.get("/", (c) => renderProxyError(c, wire, reply))
  const res = await app.request("/")
  return { status: res.status, headers: res.headers, body: await res.json() }
}

describe("renderProxyError", () => {
  const reply: ProxyErrorReply = {
    status: 503,
    type: "api_error",
    message: "Sign in first.",
    retry: "never",
    headers: { "retry-after": "5" },
    openai: { type: "service_unavailable", code: "maximal_x" },
  }

  test("Anthropic's typed envelope", async () => {
    const res = await render("anthropic", reply)
    expect(res.status).toBe(503)
    expect(res.body).toEqual({
      type: "error",
      error: { type: "api_error", message: "Sign in first." },
    })
    expect(res.headers.get("x-should-retry")).toBe("false")
    expect(res.headers.get("retry-after")).toBe("5")
  })

  test("OpenAI's error object, with its type and code", async () => {
    const res = await render("openai", reply)
    expect(res.body).toEqual({
      error: {
        message: "Sign in first.",
        type: "service_unavailable",
        code: "maximal_x",
      },
    })
    expect(res.headers.get("x-should-retry")).toBe("false")
  })

  test("OpenAI's type defaults to error; no retry header unless asked", async () => {
    const res = await render("openai", {
      status: 400,
      type: "invalid_request_error",
      message: "bad",
    })
    expect(res.body).toEqual({ error: { message: "bad", type: "error" } })
    expect(res.headers.get("x-should-retry")).toBeNull()
  })
})

describe("proxyErrorHandler on a route module", () => {
  const savedToken = state.githubToken
  beforeEach(() => {
    state.githubToken = "test-github-token"
  })
  afterEach(() => {
    state.githubToken = savedToken
  })

  test("an Anthropic route answers a thrown upstream error in its envelope", async () => {
    const res = await routes("anthropic", upstream429()).request("/", {
      method: "POST",
    })
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("3")
    expect(res.headers.get("x-ratelimit-remaining")).toBe("0")
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "slow down" },
    })
  })

  test("an OpenAI route keeps the upstream body as the message", async () => {
    const res = await routes("openai", upstream429()).request("/", {
      method: "POST",
    })
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("3")
    expect(await res.json()).toEqual({
      error: { message: '{"error":{"message":"slow down"}}', type: "error" },
    })
  })

  test("custom rewrites replace the built-ins", async () => {
    const app = new Hono()
    app.onError(
      proxyErrorHandler("anthropic", [
        (reply) => ({ ...reply, message: "rewritten" }),
      ]),
    )
    app.post("/", () => {
      throw new Error("boom")
    })
    const res = await app.request("/", { method: "POST" })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "api_error", message: "rewritten" },
    })
  })
})

describe("no GitHub sign-in on the inference routes", () => {
  const savedToken = state.githubToken
  beforeEach(() => {
    state.githubToken = undefined
  })
  afterEach(() => {
    state.githubToken = savedToken
  })

  const post = { method: "POST", body: "{}" }

  test.each([
    ["/v1/messages", messageRoutes],
    ["/:provider/v1/messages", providerMessageRoutes],
  ] as const)("%s: 503, no retry, Anthropic envelope", async (_path, app) => {
    const res = await app.request("/", post)
    expect(res.status).toBe(503)
    expect(res.headers.get("x-should-retry")).toBe("false")
    expect(await res.json()).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: expect.stringContaining("Settings → Account") as string,
      },
    })
  })

  test.each([
    ["/chat/completions", completionRoutes],
    ["/responses", responsesRoutes],
  ] as const)("%s: 503, no retry, OpenAI error object", async (_path, app) => {
    const res = await app.request("/", post)
    expect(res.status).toBe(503)
    expect(res.headers.get("x-should-retry")).toBe("false")
    expect(await res.json()).toEqual({
      error: {
        type: "service_unavailable",
        code: "maximal_not_signed_in",
        message: expect.stringContaining("maximal auth") as string,
      },
    })
  })

  test("a plain route keeps the 401 not_authenticated contract", async () => {
    const app = new Hono()
    app.use(requireGithubAuth)
    app.get("/usage", (c) => c.text("ok"))
    const res = await app.request("/usage")
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: "not_authenticated",
      hint: "Open Settings → Account to sign in, or run `maximal auth`.",
    })
  })
})
