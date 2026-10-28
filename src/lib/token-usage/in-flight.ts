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
  /** Characters of delta text (reply, thinking, tool arguments) streamed so
   *  far, as written in the JSON. */
  streamedChars: number
}

/**
 * Characters of streamed text per token, the usual rough figure for English
 * and code. It only feeds the dashboard's flow estimate, so it need not be
 * exact.
 */
export const STREAM_CHARS_PER_TOKEN = 4

/** The string fields that carry streamed text in a delta event: Anthropic
 *  (`text`, `thinking`, `partial_json`), Responses (`delta`) and chat
 *  completions (`content`, `arguments`). */
const DELTA_TEXT =
  /"(?:text|thinking|partial_json|delta|content|arguments)":"((?:[^"\\]|\\.)*)"/g

/** Longest unfinished line kept between chunks. */
const MAX_PARTIAL_LINE = 65_536

/**
 * Counts the delta text in an SSE stream, so the estimate follows tokens
 * rather than framing: one delta event is about a hundred bytes of event name
 * and JSON around a few characters of text. Only `data:` lines with a `delta`
 * field count; events that repeat finished text (`*.done`,
 * `response.completed`) have none. A line split across chunks counts once it
 * is complete.
 */
export class DeltaTextCounter {
  readonly #decoder = new TextDecoder()
  #partial = ""

  /** Feed one chunk; returns the delta characters it completed. */
  feed(chunk: Uint8Array): number {
    const text = this.#partial + this.#decoder.decode(chunk, { stream: true })
    const end = text.lastIndexOf("\n")
    // A body that isn't SSE (one JSON reply) has no lines to count: don't
    // hold on to it.
    const rest = text.slice(end + 1)
    this.#partial = rest.length > MAX_PARTIAL_LINE ? "" : rest
    let chars = 0
    for (const line of text.slice(0, end + 1).split("\n")) {
      if (!line.startsWith("data:") || !line.includes('"delta":')) continue
      for (const match of line.matchAll(DELTA_TEXT)) chars += match[1].length
    }
    return chars
  }
}

interface Entry {
  /** Live context: routes fill `usage.sessionId` and `usage.model` after the
   *  middleware has already registered, so these are read at list time. */
  context: RequestContext
  counter: DeltaTextCounter
  streamedChars: number
}

/** An entry older than this is assumed leaked (a response never read to the
 *  end) and is dropped, so a stuck request cannot mark a session streaming. */
export const IN_FLIGHT_MAX_AGE_MS = 600_000

const entries = new Set<Entry>()
/** Contexts already tracked, so overlapping route matches register once. */
const registered = new WeakSet<RequestContext>()

/** Drop entries older than the max age. */
function prune(now: number): void {
  for (const entry of entries) {
    if (now - entry.context.startTime > IN_FLIGHT_MAX_AGE_MS) {
      entries.delete(entry)
    }
  }
}

export function listInFlight(now = Date.now()): Array<InFlight> {
  prune(now)
  return [...entries].map(({ context, streamedChars }) => ({
    traceId: context.traceId,
    sessionId: context.usage.sessionId ?? "",
    client: deriveUsageClient(context.usage.apiKeyLabel, context.userAgent),
    model: context.usage.model ?? "",
    startedAtMs: context.startTime,
    streamedChars,
  }))
}

export function __resetInFlightForTests(): void {
  entries.clear()
}

/** Entries held now, without the pruning a list does. */
export function __inFlightCountForTests(): number {
  return entries.size
}

/**
 * Pass the body through chunk by chunk, counting delta text, and drop the entry
 * when it ends, errors or the client cancels. Pull-based, so backpressure
 * and incremental delivery are the source stream's own.
 */
function observeBody(
  body: ReadableStream<Uint8Array>,
  entry: Entry,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let cancelled = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (cancelled) return
        if (done) {
          entries.delete(entry)
          controller.close()
          return
        }
        entry.streamedChars += entry.counter.feed(value)
        controller.enqueue(value)
      } catch (error) {
        entries.delete(entry)
        if (!cancelled) controller.error(error)
      }
    },
    async cancel(reason) {
      cancelled = true
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
  if (!context || registered.has(context)) {
    await next()
    return
  }
  registered.add(context)

  // Pruning here too keeps a leaked entry from waiting for a sessions read.
  prune(Date.now())
  const entry: Entry = {
    context,
    counter: new DeltaTextCounter(),
    streamedChars: 0,
  }
  entries.add(entry)
  let streaming = false
  try {
    await next()
    const { body } = c.res
    if (body) {
      c.res = new Response(observeBody(body, entry), {
        status: c.res.status,
        statusText: c.res.statusText,
        headers: c.res.headers,
      })
      streaming = true
    }
  } finally {
    if (!streaming) entries.delete(entry)
  }
}
