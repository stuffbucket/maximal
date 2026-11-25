/**
 * Holding a chat request at a `pause` rule's limit instead of refusing it.
 *
 * `withPause` wraps a chat route's handler. While no rule pauses, or the
 * request finds room, it is the handler. When a pause rule is at its limit
 * the request is held (`PauseGate`) until the limit clears or a person
 * resumes it, for at most the configured wait; then it runs the handler, or
 * fails with the usual 402.
 *
 * - A non-streaming request just waits.
 * - A streaming request answers at once (status 200, `text/event-stream`) and
 *   sends keepalives while it waits, so the client's connection and timeouts
 *   stay alive: Anthropic's `ping` event on `/v1/messages`, an SSE comment
 *   line on the OpenAI wires (clients skip those). Once let through, the
 *   handler's own stream is relayed byte for byte; a failure, which can no
 *   longer be a status code, is sent as the wire's error event.
 * - A client that disconnects while held frees its slot at once.
 */

import type { Context, ErrorHandler } from "hono"

import { Hono } from "hono"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"

import type { BudgetRefusal } from "./errors"
import type { HeldRequest } from "./pause"
import type { ChatBudgetOperation } from "./runtime"

import { BudgetExceededError } from "./errors"
import {
  checkChat,
  getApprovalCenter,
  getPauseGate,
  hasPauseRules,
  markBudgetCleared,
  pauseSettings,
} from "./runtime"

export type PauseWire = "anthropic" | "openai"

/** How often a held stream is told the connection is alive (ms). */
export const PING_INTERVAL_MS = 10_000

const TOO_MANY = "Too many requests are already paused."

export interface PauseHoldOptions {
  wire: PauseWire
  operation: ChatBudgetOperation
  /** The route's handler, run once the request is let through. */
  handler: (c: Context) => Promise<Response> | Response
  /** The route's error handler: words a failure as this wire does. */
  onError: ErrorHandler
  /** Keepalive interval for tests. */
  pingMs?: number
}

interface ChatRequest {
  model?: string
  maxTokens?: number
  stream: boolean
}

function chatRequestOf(payload: Record<string, unknown>): ChatRequest {
  const max = payload.max_tokens ?? payload.max_output_tokens
  return {
    ...(typeof payload.model === "string" ? { model: payload.model } : {}),
    ...(typeof max === "number" ? { maxTokens: max } : {}),
    stream: payload.stream === true,
  }
}

type Wait =
  | { kind: "go" }
  | { kind: "gone" }
  | { kind: "refused"; refusal: BudgetRefusal }

/** Park the held request until it is let through, refused or abandoned. */
async function waitForRoom(
  held: HeldRequest,
  waiting: {
    operation: ChatBudgetOperation
    request: ChatRequest
    first: BudgetRefusal
    signal: AbortSignal
  },
): Promise<Wait> {
  const { signal } = waiting
  const deadlineMs = Date.now() + pauseSettings().maxWaitMs
  let refusal = waiting.first
  while (true) {
    const outcome = await held.park({ deadlineMs, signal })
    if (outcome === "aborted") return { kind: "gone" }
    if (outcome === "resumed") {
      markBudgetCleared()
      return { kind: "go" }
    }
    if (outcome === "cancelled" || outcome === "timeout") {
      return { kind: "refused", refusal }
    }
    const next = await checkChat(waiting.operation, waiting.request)
    if (next.ok) return { kind: "go" }
    if (next.refusal.pause !== true) {
      return { kind: "refused", refusal: next.refusal }
    }
    refusal = next.refusal
  }
}

async function ping(stream: SSEStreamingApi, wire: PauseWire): Promise<void> {
  try {
    await (wire === "anthropic" ?
      stream.writeSSE({
        event: "ping",
        data: JSON.stringify({ type: "ping" }),
      })
    : stream.write(": paused\n\n"))
  } catch {
    // The client is gone; the abort handler is on its way.
  }
}

/** A failure as the wire's error event (the headers are already sent). */
async function writeError(
  stream: SSEStreamingApi,
  wire: PauseWire,
  response: Response,
): Promise<void> {
  const body: unknown = await response
    .json()
    .catch(() => ({ error: { message: "The request failed." } }))
  await (wire === "anthropic" ?
    stream.writeSSE({ event: "error", data: JSON.stringify(body) })
  : stream.write(`data: ${JSON.stringify(body)}\n\n`))
}

/** Pass the handler's own stream through; anything else is an error event. */
async function relay(
  target: { stream: SSEStreamingApi; wire: PauseWire },
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  const { stream, wire } = target
  const type = response.headers.get("content-type") ?? ""
  if (!response.body || !type.includes("text/event-stream")) {
    await writeError(stream, wire, response)
    return
  }
  const reader = response.body.getReader()
  signal.addEventListener(
    "abort",
    () => {
      void reader.cancel()
    },
    { once: true },
  )
  while (true) {
    const read: unknown = await reader.read()
    const { done, value } = read as { done?: unknown; value?: unknown }
    if (done === true || !(value instanceof Uint8Array)) return
    await stream.write(value)
  }
}

/** The route's handler, run for a stream that has already started: the
 *  request's own context is answering with the stream, so the handler gets
 *  its own, over a copy of the request (its body was read to look at it). */
async function runHandler(
  options: PauseHoldOptions,
  original: { c: Context; payload: unknown; signal: AbortSignal },
): Promise<Response> {
  const { c, payload, signal } = original
  const scratch = new Hono()
  scratch.onError(options.onError)
  scratch.post("*", (sc) => options.handler(sc))
  const headers = new Headers(c.req.raw.headers)
  headers.delete("content-length")
  return await scratch.request(c.req.url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  })
}

/** A failure worded by the route's error handler. The request's own context
 *  is already answering with the stream and can't build another response, so
 *  the handler runs in a scratch app. */
async function failureResponse(
  onError: ErrorHandler,
  error: unknown,
  c: Context,
): Promise<Response> {
  const scratch = new Hono()
  scratch.onError(onError)
  scratch.all("*", () => {
    throw error
  })
  return await scratch.request(c.req.url, { method: "POST" })
}

export function withPause(
  options: PauseHoldOptions,
): (c: Context) => Promise<Response> {
  return async (c) => {
    if (!hasPauseRules()) return await options.handler(c)
    const body: unknown = await c.req.json().catch(() => undefined)
    if (typeof body !== "object" || body === null) {
      return await options.handler(c)
    }
    const request = chatRequestOf(body as Record<string, unknown>)
    const first = await checkChat(options.operation, request)
    if (first.ok || first.refusal.pause !== true) {
      return await options.handler(c)
    }

    const gate = getPauseGate()
    const held = gate.enter(first.refusal.limitId)
    if (!held) {
      throw new BudgetExceededError({
        ...first.refusal,
        pause: false,
        message: `${first.refusal.message} ${TOO_MANY}`,
      })
    }
    getApprovalCenter().paused({
      limitId: first.refusal.limitId,
      periodKey: String(first.refusal.resetsAtMs),
      unit: first.refusal.unit,
      used: first.refusal.used,
      limit: first.refusal.limit,
      resetsAtMs: first.refusal.resetsAtMs,
    })

    const waiting = {
      operation: options.operation,
      request,
      first: first.refusal,
    }
    if (!request.stream) {
      let wait: Wait
      try {
        wait = await waitForRoom(held, {
          ...waiting,
          signal: c.req.raw.signal,
        })
      } finally {
        held.release()
      }
      if (wait.kind === "gone") return new Response(null, { status: 499 })
      if (wait.kind === "refused") throw new BudgetExceededError(wait.refusal)
      return await options.handler(c)
    }

    return streamSSE(c, async (stream) => {
      const abort = new AbortController()
      stream.onAbort(() => {
        abort.abort()
      })
      const signal = AbortSignal.any([abort.signal, c.req.raw.signal])
      await ping(stream, options.wire)
      const timer = setInterval(() => {
        void ping(stream, options.wire)
      }, options.pingMs ?? PING_INTERVAL_MS)
      let wait: Wait
      try {
        wait = await waitForRoom(held, { ...waiting, signal })
      } finally {
        clearInterval(timer)
        held.release()
      }
      if (wait.kind === "gone") return
      if (wait.kind === "refused") {
        const failure = await failureResponse(
          options.onError,
          new BudgetExceededError(wait.refusal),
          c,
        )
        await writeError(stream, options.wire, failure)
        return
      }
      const response = await runHandler(options, { c, payload: body, signal })
      await relay({ stream, wire: options.wire }, response, signal)
    })
  }
}
