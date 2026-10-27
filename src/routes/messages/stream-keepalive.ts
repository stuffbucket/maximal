/**
 * SSE keep-alive `ping` heartbeat for `/v1/messages` streaming flows.
 *
 * Extracted into its own module (like `stream-error.ts`) so it can be
 * unit-tested directly without colliding with dispatch tests that mock
 * `api-flows.ts`.
 */

import type { SSEMessage, SSEStreamingApi } from "hono/streaming"

/**
 * Default idle interval before emitting an Anthropic `ping` SSE event.
 * Matches `HEARTBEAT_INTERVAL_MS` in `web-tools/stream.ts` so long-running
 * thinking blocks, tool-input buffering, or slow upstream turns don't trigger
 * client/proxy idle-stream timeouts.
 */
export const DEFAULT_STREAM_KEEPALIVE_MS = 5_000

const PING_SSE_MESSAGE: SSEMessage = {
  event: "ping",
  data: '{"type":"ping"}',
}

export interface StreamKeepAlive {
  writeSSE: (
    message: SSEMessage,
    options?: { isMessageStart?: boolean },
  ) => Promise<void>
  stop: () => void
}

/**
 * Wraps an `SSEStreamingApi` to emit periodic `event: ping` heartbeats while
 * awaiting silent upstream gaps after `message_start` has been sent.
 *
 * - Pings are suppressed before `message_start` (a ping before `message_start`
 *   is not a valid Anthropic stream).
 * - Every `writeSSE` call resets the idle timer so active streams emit no
 *   redundant pings.
 * - Overlapping writes are guarded so a heartbeat never interleaves with an
 *   in-flight event write.
 */
export const createStreamKeepAlive = (
  stream: SSEStreamingApi,
  intervalMs: number = DEFAULT_STREAM_KEEPALIVE_MS,
): StreamKeepAlive => {
  let messageStartSent = false
  let stopped = false
  let writing = false
  let inFlightWrite: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const scheduleNextPing = (): void => {
    clearTimer()
    if (stopped || !messageStartSent || intervalMs <= 0) {
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      if (stopped || !messageStartSent) {
        return
      }
      if (writing) {
        scheduleNextPing()
        return
      }
      writing = true
      const writePromise = Promise.resolve(stream.writeSSE(PING_SSE_MESSAGE))
        .catch(() => {
          // Best-effort heartbeat: if the socket closed, let the main stream
          // loop observe the failure on its next write.
        })
        .finally(() => {
          if (inFlightWrite === writePromise) {
            inFlightWrite = undefined
            writing = false
            scheduleNextPing()
          }
        })
      inFlightWrite = writePromise
    }, intervalMs)
  }

  const isBeforeMessageStart = (): boolean => !messageStartSent

  return {
    writeSSE: async (message, options) => {
      if (message.event === "ping" && isBeforeMessageStart()) {
        return
      }
      clearTimer()
      const pendingPing = inFlightWrite
      if (pendingPing) {
        inFlightWrite = undefined
        await pendingPing
      }
      writing = true
      try {
        await stream.writeSSE(message)
        if (options?.isMessageStart || message.event === "message_start") {
          messageStartSent = true
        }
        if (message.event === "message_stop" || message.event === "error") {
          stopped = true
        }
      } finally {
        writing = false
        scheduleNextPing()
      }
    },
    stop: () => {
      stopped = true
      clearTimer()
    },
  }
}
