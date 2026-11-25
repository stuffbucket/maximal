/**
 * A held streaming request against the wire contracts: keepalives while it
 * waits (Anthropic's `ping` event before `message_start`; SSE comment lines on
 * the OpenAI wires), the reply's own events untouched once it is let through,
 * an error event where a status code can no longer go, and the slot freed when
 * the client leaves.
 */

import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { BudgetExceededError } from "~/lib/budget/errors"
import { withPause } from "~/lib/budget/pause-hold"
import { getPauseGate } from "~/lib/budget/runtime"
import { writeConfig } from "~/lib/config/config"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"
import { traceIdMiddleware } from "~/lib/http/trace"

import { AIU } from "./helpers/budget-service-harness"
import {
  chatApp,
  post,
  putRule,
  spend,
  transcript,
  until,
  useFlowHooks,
} from "./helpers/pause-flow"

useFlowHooks()

describe("a held request that streams", () => {
  test("anthropic: pings before message_start while held, then the reply's own events", async () => {
    await putRule()
    spend(2 * AIU)
    const response = await post(chatApp("anthropic", { pingMs: 15 }), {
      model: "m",
      stream: true,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(response.headers.get("cache-control")).toBe("no-cache")

    const reading = transcript(response)
    await until(() => getPauseGate().heldCount("agents") === 1)
    await Bun.sleep(60)
    getPauseGate().resume()
    const text = await reading

    const ping = 'event: ping\ndata: {"type":"ping"}\n\n'
    const start = text.indexOf("event: message_start")
    expect(start).toBeGreaterThan(0)
    // Several pings, all ahead of the reply, then the reply untouched.
    const before = text.slice(0, start)
    expect(before.startsWith(ping)).toBe(true)
    expect(before.split(ping).filter(Boolean)).toEqual([])
    expect(before.split(ping).length - 1).toBeGreaterThanOrEqual(2)
    expect(text.slice(start)).toBe(
      'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    )
  })

  test("openai: comment lines while held, which a client skips, then the reply", async () => {
    await putRule()
    spend(2 * AIU)
    const response = await post(chatApp("openai", { pingMs: 15 }), {
      model: "m",
      stream: true,
    })
    const reading = transcript(response)
    await until(() => getPauseGate().heldCount("agents") === 1)
    await Bun.sleep(50)
    getPauseGate().resume()
    const text = await reading
    const start = text.indexOf("event: message_start")
    const before = text.slice(0, start)
    expect(before.startsWith(": paused\n\n")).toBe(true)
    expect(before.split(": paused\n\n").join("")).toBe("")
    // Nothing a client would parse as an event or data before the reply.
    expect(before).not.toContain("data:")
    expect(before).not.toContain("event:")
  })

  test("let through when the limit is raised, with no reply lost", async () => {
    await putRule()
    spend(2 * AIU)
    const response = await post(chatApp("anthropic", { pingMs: 1000 }), {
      model: "m",
      stream: true,
    })
    const reading = transcript(response)
    await until(() => getPauseGate().heldCount("agents") === 1)
    await putRule({ limit: 10 * AIU })
    const text = await reading
    expect(text).toContain("event: message_stop")
  })

  test("anthropic: cancelled, it ends with an error event in the 402's body", async () => {
    await putRule()
    spend(2 * AIU)
    const response = await post(chatApp("anthropic", { pingMs: 1000 }), {
      model: "m",
      stream: true,
    })
    const reading = transcript(response)
    await until(() => getPauseGate().heldCount("agents") === 1)
    getPauseGate().cancel()
    const text = await reading
    const error = text.slice(text.indexOf("event: error"))
    expect(error.startsWith("event: error\ndata: ")).toBe(true)
    const data = JSON.parse(error.split("\n")[1].slice("data: ".length)) as {
      type: string
      error: { type: string; message: string }
    }
    expect(data).toMatchObject({
      type: "error",
      error: { type: "billing_error" },
    })
    expect(data.error.message).toContain(
      'Maximal rule "Agents" blocked this request',
    )
  })

  test("openai: cancelled, it ends with a data line carrying the error", async () => {
    await putRule()
    spend(2 * AIU)
    const response = await post(chatApp("openai", { pingMs: 1000 }), {
      model: "m",
      stream: true,
    })
    const reading = transcript(response)
    await until(() => getPauseGate().heldCount("agents") === 1)
    getPauseGate().cancel()
    const text = await reading
    const line = text.split("\n").find((l) => l.startsWith("data: "))
    expect(line).toBeDefined()
    expect(JSON.parse((line ?? "").slice(6))).toMatchObject({
      error: { type: "insufficient_quota", code: "budget_exceeded" },
    })
  })

  test("a stream that waits the maximum ends with the error event", async () => {
    writeConfig({ budget: { pause: { maxWaitSeconds: 1 } } })
    await putRule()
    spend(2 * AIU)
    const response = await post(chatApp("anthropic", { pingMs: 200 }), {
      model: "m",
      stream: true,
    })
    const text = await transcript(response)
    expect(text).toContain("event: ping")
    expect(text).toContain("event: error")
    expect(text).not.toContain("message_start")
  })

  test("a client that disconnects mid-hold frees its slot", async () => {
    await putRule()
    spend(2 * AIU)
    const response = await post(chatApp("anthropic", { pingMs: 15 }), {
      model: "m",
      stream: true,
    })
    const reading = transcript(response, (text) => text.includes("event: ping"))
    await until(() => getPauseGate().heldCount("agents") === 1)
    await reading
    await until(() => getPauseGate().heldCount() === 0)
  })
})

describe("a held stream that cannot be answered as a stream", () => {
  test("the cap refuses a stream with the 402, before any stream starts", async () => {
    writeConfig({ budget: { pause: { maxHeld: 1 } } })
    await putRule()
    spend(2 * AIU)
    const route = chatApp("anthropic", { pingMs: 1000 })
    const first = post(route, { model: "m", stream: true })
    await until(() => getPauseGate().heldCount("agents") === 1)
    const second = await post(route, { model: "m", stream: true })
    expect(second.status).toBe(402)
    getPauseGate().cancel()
    await transcript(await first)
  })

  test("a stream the handler can't start becomes an error event, not a status", async () => {
    await putRule()
    spend(2 * AIU)
    const failing = new Hono()
    const onError = proxyErrorHandler("anthropic")
    failing.onError(onError)
    failing.use(traceIdMiddleware)
    failing.post(
      "/",
      withPause({
        wire: "anthropic",
        operation: "messages",
        pingMs: 1000,
        onError,
        handler: async (c) => {
          await c.req.json()
          // A JSON failure, as a handler answers a bad request.
          return c.json(
            {
              type: "error",
              error: { type: "invalid_request_error", message: "bad" },
            },
            400,
          )
        },
      }),
    )
    const response = await post(failing, { model: "m", stream: true })
    const reading = transcript(response)
    await until(() => getPauseGate().heldCount("agents") === 1)
    getPauseGate().resume()
    const text = await reading
    expect(text).toContain(
      'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}',
    )

    const throwing = new Hono()
    throwing.onError(onError)
    throwing.use(traceIdMiddleware)
    throwing.post(
      "/",
      withPause({
        wire: "anthropic",
        operation: "messages",
        pingMs: 1000,
        onError,
        handler: () =>
          Promise.reject(
            new BudgetExceededError({
              limitId: "x",
              label: null,
              scope: { kind: "global" },
              unit: "nano_aiu",
              limit: 1,
              used: 1,
              held: 0,
              requested: 0,
              resetsAtMs: null,
              resetEstimated: false,
              inFlight: false,
              message: "thrown",
              creditUsd: 0.01,
            }),
          ),
      }),
    )
    const second = post(throwing, { model: "m", stream: true })
    const reading2 = transcript(await second)
    await until(() => getPauseGate().heldCount("agents") === 1)
    getPauseGate().resume()
    expect(await reading2).toContain("event: error")
  })
})
