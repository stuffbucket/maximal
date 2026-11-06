/**
 * The built-in rewrites of the inference routes' error replies
 * (`proxy-errors.ts`), in the order they run. Each looks at the error and
 * the reply so far and returns a replacement, or `undefined` to leave it.
 */

import type { ProxyErrorRewrite, ProxyWire } from "~/lib/errors/proxy-errors"

import {
  contextOverflowMessage,
  isTransientUpstreamStatus,
} from "~/lib/errors/anthropic-error"
import { NoUpstreamError } from "~/lib/errors/http-errors"
import { adviseUpstreamError } from "~/lib/errors/upstream-error-advice"
import { state } from "~/lib/runtime-state/state"

/** No GitHub sign-in: tell the person reading the client what to do. */
export const notSignedIn: ProxyErrorRewrite = (reply, { error }) =>
  // The only reason there's no upstream today.
  error instanceof NoUpstreamError ?
    {
      ...reply,
      message:
        "Maximal isn't signed in to GitHub, so it can't reach a model. Open Maximal → Settings → Account and sign in (or run `maximal auth`), then try again.",
      openai: { ...reply.openai, code: "maximal_not_signed_in" },
    }
  : undefined

/** Recognizable upstream errors (Copilot's opaque `model_not_supported`,
 *  say) get context and a recovery step, the original kept inline. */
export const upstreamAdvice: ProxyErrorRewrite = (reply, { upstream }) => {
  if (!upstream) return undefined
  const advice = adviseUpstreamError(
    upstream.status,
    upstream.text,
    state.models?.data ?? [],
  )
  return advice === null ? undefined : { ...reply, message: advice }
}

/** Copilot words a context overflow differently per endpoint; Claude Code
 *  compacts only on Anthropic's exact wording, so reword it (any 4xx but
 *  429). Runs after the advice so the overflow wording wins. */
export const contextOverflow: ProxyErrorRewrite = (reply, { upstream }) => {
  if (!upstream || upstream.status < 400 || upstream.status >= 500) {
    return undefined
  }
  if (upstream.status === 429) return undefined
  const message = contextOverflowMessage(upstream.message)
  return message === null ? undefined : (
      { ...reply, status: 400, type: "invalid_request_error", message }
    )
}

/** A transient upstream 5xx becomes Anthropic's retryable 529, which the
 *  SDK retries with backoff instead of ending the turn. */
export const transientToOverloaded: ProxyErrorRewrite = (
  reply,
  { upstream },
) =>
  upstream && isTransientUpstreamStatus(upstream.status) ?
    { ...reply, status: 529, type: "overloaded_error" }
  : undefined

/** Relay `Retry-After` and the upstream's `x-*` rate-limit headers when
 *  `relay(status)` says the client may retry. */
function retryHeaders(relay: (status: number) => boolean): ProxyErrorRewrite {
  return function relayRetryHeaders(reply, { upstream }) {
    if (!upstream || !relay(upstream.status)) return undefined
    const headers: Record<string, string> = {}
    for (const [name, value] of upstream.headers) {
      const lower = name.toLowerCase()
      if (lower === "retry-after" || lower.startsWith("x-")) {
        headers[name] = value
      }
    }
    return { ...reply, headers: { ...reply.headers, ...headers } }
  }
}

/** The rewrites for each wire, in order. */
export const PROXY_ERROR_REWRITES: Record<
  ProxyWire,
  ReadonlyArray<ProxyErrorRewrite>
> = {
  anthropic: [
    notSignedIn,
    upstreamAdvice,
    contextOverflow,
    transientToOverloaded,
    retryHeaders(
      (status) => status === 429 || isTransientUpstreamStatus(status),
    ),
  ],
  openai: [
    notSignedIn,
    upstreamAdvice,
    retryHeaders((status) => status === 429),
  ],
}
