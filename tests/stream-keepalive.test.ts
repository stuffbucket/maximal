import type { SSEMessage, SSEStreamingApi } from "hono/streaming"

import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import { prepareMessagesApiPayload } from "~/routes/messages/preprocess"
import { createStreamKeepAlive } from "~/routes/messages/stream-keepalive"

const waitMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const createMockStream = () => {
  const written: Array<SSEMessage> = []
  const stream = {
    writeSSE: (msg: SSEMessage) => {
      written.push(msg)
      return Promise.resolve()
    },
  } as unknown as SSEStreamingApi
  return { stream, written }
}

describe("prepareMessagesApiPayload message-block cache_control.scope stripping", () => {
  test("strips cache_control.scope on message content blocks while preserving cache_control markers", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "prompt prefix",
              cache_control: {
                type: "ephemeral",
                scope: "user",
              },
            } as never,
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              cache_control: {
                type: "ephemeral",
                scope: "session",
              },
              content: [
                {
                  type: "text",
                  text: "result text",
                  cache_control: {
                    type: "ephemeral",
                  },
                } as never,
              ],
            } as never,
          ],
        },
      ],
    }

    prepareMessagesApiPayload(payload, {
      capabilities: { supports: { adaptive_thinking: true } },
    } as never)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "prompt prefix",
          cache_control: {
            type: "ephemeral",
          },
        } as never,
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          cache_control: {
            type: "ephemeral",
          },
          content: [
            {
              type: "text",
              text: "result text",
            },
          ],
        } as never,
      ],
    })
  })
})

describe("createStreamKeepAlive SSE ping heartbeat", () => {
  test("suppresses pings before message_start and emits pings during idle gap after message_start", async () => {
    const { stream, written } = createMockStream()
    const keepAlive = createStreamKeepAlive(stream, 20)

    try {
      await keepAlive.writeSSE({
        event: "ping",
        data: '{"type":"ping"}',
      })
      await waitMs(35)
      expect(written).toEqual([])

      await keepAlive.writeSSE({
        event: "message_start",
        data: '{"type":"message_start"}',
      })
      await waitMs(55)
    } finally {
      keepAlive.stop()
    }

    expect(written[0]).toEqual({
      event: "message_start",
      data: '{"type":"message_start"}',
    })
    const pings = written.filter((msg) => msg.event === "ping")
    expect(pings.length).toBeGreaterThanOrEqual(1)
    expect(pings[0]).toEqual({
      event: "ping",
      data: '{"type":"ping"}',
    })

    const countAfterStop = written.length
    await waitMs(35)
    expect(written.length).toBe(countAfterStop)
  })

  test("stops scheduling pings automatically once message_stop is written", async () => {
    const { stream, written } = createMockStream()
    const keepAlive = createStreamKeepAlive(stream, 20)

    try {
      await keepAlive.writeSSE({
        event: "message_start",
        data: '{"type":"message_start"}',
      })
      await keepAlive.writeSSE({
        event: "message_stop",
        data: '{"type":"message_stop"}',
      })
      await waitMs(45)
    } finally {
      keepAlive.stop()
    }

    expect(written.map((msg) => msg.event)).toEqual([
      "message_start",
      "message_stop",
    ])
  })
})
