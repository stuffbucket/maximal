import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import { isWarmupRequest, respondToWarmup } from "~/routes/messages/warmup"

const basePayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  model: "test-model",
  max_tokens: 128,
  messages: [{ role: "user", content: "Warmup" }],
  ...overrides,
})

// Parse a raw SSE body into ordered { event, data } records.
const parseSSE = (raw: string): Array<{ event: string; data: unknown }> =>
  raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n")
      const event =
        lines
          .find((l) => l.startsWith("event:"))
          ?.slice("event:".length)
          .trim() ?? ""
      const dataLine =
        lines
          .find((l) => l.startsWith("data:"))
          ?.slice("data:".length)
          .trim() ?? "null"
      return { event, data: JSON.parse(dataLine) as unknown }
    })

describe("isWarmupRequest", () => {
  test("matches string-content 'Warmup'", () => {
    expect(isWarmupRequest(basePayload())).toBe(true)
  })

  test("matches a single text-block 'Warmup' with surrounding whitespace", () => {
    const payload = basePayload({
      messages: [
        { role: "user", content: [{ type: "text", text: "  Warmup\n" }] },
      ],
    })
    expect(isWarmupRequest(payload)).toBe(true)
  })

  test("rejects two messages", () => {
    const payload = basePayload({
      messages: [
        { role: "user", content: "Warmup" },
        { role: "assistant", content: "OK" },
      ],
    })
    expect(isWarmupRequest(payload)).toBe(false)
  })

  test("rejects an assistant role", () => {
    const payload = basePayload({
      messages: [{ role: "assistant", content: "Warmup" }],
    })
    expect(isWarmupRequest(payload)).toBe(false)
  })

  test("rejects when tools are present", () => {
    const payload = basePayload({
      tools: [{ name: "x", input_schema: { type: "object" } }],
    })
    expect(isWarmupRequest(payload)).toBe(false)
  })

  test("rejects content 'Warm up the engine'", () => {
    const payload = basePayload({
      messages: [{ role: "user", content: "Warm up the engine" }],
    })
    expect(isWarmupRequest(payload)).toBe(false)
  })

  test("rejects empty content", () => {
    const payload = basePayload({
      messages: [{ role: "user", content: "" }],
    })
    expect(isWarmupRequest(payload)).toBe(false)
  })
})

describe("respondToWarmup (non-streaming)", () => {
  test("returns a well-formed canned AnthropicResponse", async () => {
    const app = new Hono()
    app.post("/", (c) => respondToWarmup(c, basePayload({ model: "echo-me" })))

    const response = await app.request("/", { method: "POST" })
    expect(response.status).toBe(200)

    const body = (await response.json()) as Record<string, unknown>
    expect(body.type).toBe("message")
    expect(body.role).toBe("assistant")
    expect(body.model).toBe("echo-me")
    expect(body.content).toEqual([{ type: "text", text: "OK" }])
    expect(body.stop_reason).toBe("end_turn")
    expect(body.stop_sequence).toBeNull()
    expect(body.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
    expect(typeof body.id).toBe("string")
    expect((body.id as string).startsWith("msg_warmup_")).toBe(true)
  })
})

describe("respondToWarmup (streaming)", () => {
  test("emits a valid minimal Anthropic SSE sequence", async () => {
    const app = new Hono()
    app.post("/", (c) =>
      respondToWarmup(c, basePayload({ model: "echo-me", stream: true })),
    )

    const response = await app.request("/", { method: "POST" })
    expect(response.status).toBe(200)

    const events = parseSSE(await response.text())
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])

    const start = events[0].data as {
      type: string
      message: { role: string; model: string; content: Array<unknown> }
    }
    expect(start.type).toBe("message_start")
    expect(start.message.role).toBe("assistant")
    expect(start.message.model).toBe("echo-me")
    expect(start.message.content).toEqual([])

    const delta = events[2].data as {
      delta: { type: string; text: string }
    }
    expect(delta.delta).toEqual({ type: "text_delta", text: "OK" })

    const msgDelta = events[4].data as {
      delta: { stop_reason: string }
      usage: { output_tokens: number }
    }
    expect(msgDelta.delta.stop_reason).toBe("end_turn")
    expect(msgDelta.usage.output_tokens).toBe(0)
  })
})
