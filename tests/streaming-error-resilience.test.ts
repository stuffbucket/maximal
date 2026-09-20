/**
 * Streaming resilience: when an upstream Copilot stream throws or drops
 * mid-flight, the flow must emit a clean Anthropic `error` event before the
 * SSE response closes — never leave the client with a hung or silently
 * truncated stream. Regression guard for the mid-stream dead-end.
 *
 * We unit-test `emitStreamError` (the helper all three flows call in their
 * catch blocks) directly against a fake SSE stream. It lives in its own
 * module precisely so this test is immune to the `mock.module` swap that
 * dispatch tests apply to `api-flows.ts`.
 */

import { describe, expect, mock, test } from "bun:test"

import { emitStreamError } from "~/routes/messages/stream-error"

interface CapturedSSE {
  event?: string
  data: string
}

function fakeStream(opts: { failWrite?: boolean } = {}): {
  writes: Array<CapturedSSE>
  stream: { writeSSE: (m: CapturedSSE) => Promise<void> }
} {
  const writes: Array<CapturedSSE> = []
  return {
    writes,
    stream: {
      writeSSE: (m: CapturedSSE) => {
        if (opts.failWrite) throw new Error("socket gone")
        writes.push(m)
        return Promise.resolve()
      },
    },
  }
}

function quietLogger() {
  return {
    error: mock(() => {}),
    warn: mock(() => {}),
  }
}

describe("emitStreamError", () => {
  test("writes an Anthropic-shaped error event carrying the cause", async () => {
    const { writes, stream } = fakeStream()
    const logger = quietLogger()

    await emitStreamError(stream as never, logger as never, {
      error: new Error("upstream reset"),
      flow: "messages",
    })

    expect(writes).toHaveLength(1)
    expect(writes[0].event).toBe("error")
    const payload = JSON.parse(writes[0].data) as {
      type: string
      error: { type: string; message: string }
    }
    expect(payload.type).toBe("error")
    expect(payload.error.type).toBe("api_error")
    expect(payload.error.message).toContain("upstream reset")
    // The mid-flight failure was logged for operators.
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  test("coerces non-Error throwables to a message", async () => {
    const { writes, stream } = fakeStream()
    await emitStreamError(stream as never, quietLogger() as never, {
      error: "raw string boom",
      flow: "chat_completions",
    })
    const payload = JSON.parse(writes[0].data) as {
      error: { message: string }
    }
    expect(payload.error.message).toContain("raw string boom")
  })

  test("swallows a write failure (client already disconnected)", async () => {
    const { stream } = fakeStream({ failWrite: true })
    const logger = quietLogger()
    // Must not throw — there's nothing left to tell the client.
    await emitStreamError(stream as never, logger as never, {
      error: new Error("mid-stream"),
      flow: "responses",
    })
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})
