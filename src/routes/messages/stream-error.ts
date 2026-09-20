/**
 * Mid-stream error reporting for the three `/v1/messages` upstream flows.
 *
 * Extracted into its own module (rather than living in `api-flows.ts`) so it
 * can be unit-tested directly: `api-flows.ts` is `mock.module`-replaced by
 * dispatch tests, and Bun installs those mocks at load time for the whole
 * worker — importing this helper through `api-flows` would yield the stub. A
 * dedicated module nobody mocks keeps the behavior testable in isolation.
 */

import type { ConsolaInstance } from "consola"
import type { SSEStreamingApi } from "hono/streaming"

import { buildErrorEvent } from "~/routes/messages/responses-stream-translation"

export type StreamFlow = "chat_completions" | "responses" | "messages"

/**
 * Emit a clean Anthropic-shaped `error` event when an upstream stream throws
 * or drops mid-flight (network reset, premature close, a JSON.parse on a
 * truncated chunk). Without this, the SSE response would just close with no
 * terminal event — the client (Claude Code / the SDK) sees a hung or silently
 * truncated message and can't tell a successful short reply from a failure.
 *
 * Best-effort: if even the error write fails (socket already gone), we log and
 * move on — there's nothing left to tell the client. `streamSSE` closes the
 * response when the calling callback returns.
 */
export const emitStreamError = async (
  stream: SSEStreamingApi,
  logger: ConsolaInstance,
  ctx: { error: unknown; flow: StreamFlow },
): Promise<void> => {
  const { error, flow } = ctx
  const message = error instanceof Error ? error.message : String(error)
  logger.error(`Upstream ${flow} stream failed mid-flight: ${message}`)
  const errorEvent = buildErrorEvent(
    `Upstream stream ended unexpectedly: ${message}`,
  )
  try {
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  } catch (writeError) {
    logger.warn(
      "Could not write stream-error event (client may have disconnected)",
      writeError,
    )
  }
}
