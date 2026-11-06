/**
 * Error replies for routes that catch errors themselves: the Settings API
 * and other non-inference routes (`forwardError`), and the Anthropic-wire
 * code paths that still answer from inside a handler
 * (`forwardAnthropicError`). Both go through the same rewrites as the
 * inference routes' `onError` (`proxy-errors.ts`).
 */

import type { Context } from "hono"

import { proxyErrorResponse } from "~/lib/errors/proxy-errors"

export {
  CopilotAuthFatalError,
  HTTPError,
  NoUpstreamError,
} from "~/lib/errors/http-errors"

/** An error as OpenAI's `{ error: { message, type } }`, with the upstream
 *  status. */
export function forwardError(c: Context, error: unknown): Promise<Response> {
  return proxyErrorResponse(c, error, { wire: "openai" })
}

/**
 * An error as Anthropic's typed envelope (`/v1/messages` and its
 * `count_tokens`), so Claude Code can retry transient failures and compact
 * on a context overflow. See `anthropic-error.ts`.
 */
export function forwardAnthropicError(
  c: Context,
  error: unknown,
): Promise<Response> {
  return proxyErrorResponse(c, error, { wire: "anthropic" })
}
