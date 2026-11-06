/**
 * Error replies on the inference routes, in each client's own wire format.
 *
 * An inference route module (`/v1/messages`, `/chat/completions`,
 * `/responses`, ...) registers `proxyErrorHandler(wire)` as its Hono
 * `onError` and lets errors propagate: an upstream error response
 * (`HTTPError`), an account the upstream rejected (`CopilotAuthFatalError`),
 * or a failure of our own. The handler turns the error into a wire-neutral
 * `ProxyErrorReply`, passes it through the wire's ordered rewrites (each may
 * return a replacement or leave it), and renders it: Anthropic's typed
 * envelope or OpenAI's `{ error }` object, with `retry: "never"` sent as
 * `x-should-retry: false`.
 *
 * Rules the handler keeps whatever the rewrites do:
 * - A reply is always an error (4xx/5xx); nothing here can pose as a model
 *   answer.
 * - A rewrite that throws is logged and skipped; the reply so far stands.
 * - Side effects belong to the error, not the rewrites: an account the
 *   upstream rejected is degraded once, before any rewrite runs.
 *
 * Mid-stream failures can't use this path (the response has started); see
 * `routes/messages/stream-error.ts`.
 */

import type { Context, ErrorHandler } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"
import { HTTPException } from "hono/http-exception"

import { markAuthDegraded } from "~/lib/auth/auth-controller"
import {
  anthropicErrorBody,
  anthropicErrorType,
  type AnthropicErrorType,
} from "~/lib/errors/anthropic-error"
import { CopilotAuthFatalError, HTTPError } from "~/lib/errors/http-errors"
import { PROXY_ERROR_REWRITES } from "~/lib/errors/proxy-error-rewrites"
import { parseUpstreamError } from "~/lib/errors/upstream-error-advice"

/** The client-facing format of an inference route. */
export type ProxyWire = "anthropic" | "openai"

/** What to send back, independent of the wire format. */
export interface ProxyErrorReply {
  /** Always 4xx or 5xx. */
  status: number
  /** Anthropic's error taxonomy, the most specific of the formats. */
  type: AnthropicErrorType
  message: string
  /** `"never"` tells the client not to retry (`x-should-retry: false`). */
  retry?: "never"
  /** Extra response headers, such as relayed rate-limit headers. */
  headers?: Record<string, string>
  /** OpenAI-format fields: `error.type` (default `"error"`), `error.code`,
   *  and any extra fields of the `error` object. */
  openai?: { type?: string; code?: string; extra?: Record<string, unknown> }
}

/** What the rewrites may look at. */
export interface ProxyErrorEvent {
  wire: ProxyWire
  error: unknown
  /** The upstream's error response, when there was one. */
  upstream?: {
    status: number
    headers: Headers
    /** The raw body text. */
    text: string
    /** The error message parsed out of the body. */
    message: string
  }
}

/** Returns a replacement reply, or `undefined` to keep the current one. */
export type ProxyErrorRewrite = (
  reply: ProxyErrorReply,
  event: ProxyErrorEvent,
) => ProxyErrorReply | undefined

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The reply before any rewrite: the error as it is. */
function baseReply(event: ProxyErrorEvent): ProxyErrorReply {
  const { error, upstream, wire } = event
  if (error instanceof CopilotAuthFatalError) {
    const withUrl =
      error.remediationUrl ?
        `${error.message} (${error.remediationUrl})`
      : error.message
    return {
      status: error.status,
      type: anthropicErrorType(error.status),
      message: wire === "anthropic" ? withUrl : error.message,
      openai: {
        type: "auth_fatal",
        ...(error.remediationUrl ?
          { extra: { remediation_url: error.remediationUrl } }
        : {}),
      },
    }
  }
  if (upstream) {
    return {
      status: upstream.status,
      type: anthropicErrorType(upstream.status),
      // OpenAI clients have always had the upstream body verbatim.
      message: wire === "anthropic" ? upstream.message : upstream.text,
    }
  }
  return { status: 500, type: "api_error", message: errorMessage(error) }
}

async function readUpstream(
  error: HTTPError,
): Promise<NonNullable<ProxyErrorEvent["upstream"]>> {
  const { status, headers } = error.response
  const text = await error.response.text()
  return {
    status,
    headers,
    text,
    message: parseUpstreamError(status, text).message,
  }
}

/** Build the event for `error`, with its side effects done once. */
async function toEvent(
  wire: ProxyWire,
  error: unknown,
): Promise<ProxyErrorEvent> {
  if (error instanceof CopilotAuthFatalError) await degradeAuth(error)
  if (!(error instanceof HTTPError)) return { wire, error }
  const upstream = await readUpstream(error)
  consola.error("HTTP error:", upstream.text)
  return { wire, error, upstream }
}

function isErrorStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status <= 599
}

/** Run the rewrites in order. A rewrite that throws, or returns a non-error
 *  status, is skipped. */
export function applyRewrites(
  reply: ProxyErrorReply,
  event: ProxyErrorEvent,
  rewrites: ReadonlyArray<ProxyErrorRewrite>,
): ProxyErrorReply {
  let current = reply
  for (const rewrite of rewrites) {
    let next: ProxyErrorReply | undefined
    try {
      next = rewrite(current, event)
    } catch (error) {
      consola.warn(
        `Error rewrite ${rewrite.name || "(anonymous)"} failed`,
        error,
      )
      continue
    }
    if (next === undefined) continue
    if (!isErrorStatus(next.status)) {
      consola.warn(
        `Error rewrite ${rewrite.name || "(anonymous)"} returned status ${next.status}; ignored`,
      )
      continue
    }
    current = next
  }
  return current
}

function replyHeaders(reply: ProxyErrorReply): Record<string, string> {
  return {
    ...reply.headers,
    ...(reply.retry === "never" ? { "x-should-retry": "false" } : {}),
  }
}

/** The reply in `wire`'s format. */
export function renderProxyError(
  c: Context,
  wire: ProxyWire,
  reply: ProxyErrorReply,
): Response {
  const status = reply.status as ContentfulStatusCode
  for (const [name, value] of Object.entries(replyHeaders(reply))) {
    c.header(name, value)
  }
  if (wire === "anthropic") {
    return c.json(anthropicErrorBody(reply.type, reply.message), status)
  }
  return c.json(
    {
      error: {
        message: reply.message,
        type: reply.openai?.type ?? "error",
        ...(reply.openai?.code === undefined ?
          {}
        : { code: reply.openai.code }),
        ...reply.openai?.extra,
      },
    },
    status,
  )
}

export interface ProxyErrorOptions {
  wire: ProxyWire
  /** Defaults to the wire's built-ins (`proxy-error-rewrites.ts`). */
  rewrites?: ReadonlyArray<ProxyErrorRewrite>
}

/** The response for `error` on a `wire` route. */
export async function proxyErrorResponse(
  c: Context,
  error: unknown,
  { wire, rewrites = PROXY_ERROR_REWRITES[wire] }: ProxyErrorOptions,
): Promise<Response> {
  consola.error("Error occurred:", error)
  const event = await toEvent(wire, error)
  return renderProxyError(
    c,
    wire,
    applyRewrites(baseReply(event), event, rewrites),
  )
}

/**
 * The Hono `onError` for an inference route module: register it with
 * `routes.onError(proxyErrorHandler(wire))` and let the handlers throw.
 * `rewrites` defaults to the wire's built-ins (`proxy-error-rewrites.ts`).
 * An `HTTPException` keeps its own response, as with Hono's default handler.
 */
export function proxyErrorHandler(
  wire: ProxyWire,
  rewrites: ReadonlyArray<ProxyErrorRewrite> = PROXY_ERROR_REWRITES[wire],
): ErrorHandler {
  return (error, c) => {
    if (error instanceof HTTPException) return error.getResponse()
    return proxyErrorResponse(c, error, { wire, rewrites })
  }
}

/** Best-effort: a failure inside the auth handler must not block the client
 *  response. */
async function degradeAuth(error: CopilotAuthFatalError): Promise<void> {
  try {
    await markAuthDegraded(error)
  } catch (handlerErr) {
    consola.warn(
      "markAuthDegraded failed while forwarding upstream error:",
      handlerErr,
    )
  }
}
