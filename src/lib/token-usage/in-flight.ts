import type { MiddlewareHandler } from "hono"

import { requestContext, type RequestContext } from "~/lib/http/request-context"

import { deriveUsageClient, type UsageClient } from "./client"

/** A request whose response is still being produced or streamed. */
export interface InFlight {
  traceId: string
  sessionId: string
  client: UsageClient
  model: string
  startedAtMs: number
  streamedBytes: number
}

/**
 * Rough bytes of SSE framing plus JSON per text token. It only feeds the
 * dashboard's streaming-speed estimate, so it need not be exact.
 */
export const STREAM_BYTES_PER_TOKEN = 16

interface Entry {
  /** Live context: routes fill `usage.sessionId` and `usage.model` after the
   *  middleware has already registered, so these are read at list time. */
  context: RequestContext
  streamedBytes: number
}

const entries = new Set<Entry>()

export function listInFlight(): Array<InFlight> {
  return [...entries].map(({ context, streamedBytes }) => ({
    traceId: context.traceId,
    sessionId: context.usage.sessionId ?? "",
    client: deriveUsageClient(context.usage.apiKeyLabel, context.userAgent),
    model: context.usage.model ?? "",
    startedAtMs: context.startTime,
    streamedBytes,
  }))
}

export function __resetInFlightForTests(): void {
  entries.clear()
}

/**
 * Pass the body through chunk by chunk, counting bytes, and drop the entry
 * when it ends, errors or the client cancels. Pull-based, so backpressure
 * and incremental delivery are the source stream's own.
 */
function observeBody(
  body: ReadableStream<Uint8Array>,
  entry: Entry,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          entries.delete(entry)
          controller.close()
          return
        }
        entry.streamedBytes += value.byteLength
        controller.enqueue(value)
      } catch (error) {
        entries.delete(entry)
        controller.error(error)
      }
    },
    async cancel(reason) {
      entries.delete(entry)
      await reader.cancel(reason)
    },
  })
}

/**
 * Registers the request as in flight for as long as its response is being
 * produced or streamed. Mount after auth, on the routes that call upstream.
 */
export const trackInFlight: MiddlewareHandler = async (c, next) => {
  const context = requestContext.getStore()
  if (!context) {
    await next()
    return
  }

  const entry: Entry = { context, streamedBytes: 0 }
  entries.add(entry)
  let streaming = false
  try {
    await next()
    const { body } = c.res
    if (body) {
      streaming = true
      c.res = new Response(observeBody(body, entry), {
        status: c.res.status,
        statusText: c.res.statusText,
        headers: c.res.headers,
      })
    }
  } finally {
    if (!streaming) entries.delete(entry)
  }
}
