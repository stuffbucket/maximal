/**
 * Anthropic's typed error envelope for the `/v1/messages` surface.
 *
 * Claude Code runs on the Anthropic SDK, which decides how to recover from
 * an error by its type, not its text:
 *
 *   - `overloaded_error` (529) and other 5xx are retried with backoff that
 *     honors `Retry-After`. A transient Copilot 502/503/504 surfaced as a
 *     plain error instead kills the turn (or a long-running subagent).
 *   - A `prompt is too long: N tokens > M maximum` message makes Claude Code
 *     compact the conversation and resend. Copilot words its overflow
 *     differently per endpoint, so it is reworded here.
 *
 * The OpenAI-shaped surfaces (`/v1/chat/completions`, `/v1/responses`) and
 * the Settings API keep `forwardError`'s envelope; only Anthropic-wire routes
 * use this module.
 */

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "billing_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error"

export interface AnthropicErrorBody {
  type: "error"
  error: { type: AnthropicErrorType; message: string }
}

export interface ClassifiedError {
  status: number
  type: AnthropicErrorType
  message: string
}

const TYPE_BY_STATUS: Readonly<Partial<Record<number, AnthropicErrorType>>> = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "billing_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  529: "overloaded_error",
}

/** Anthropic's error type for an HTTP status. Unlisted 4xx are request
 *  errors; everything else is a server error. */
export function anthropicErrorType(status: number): AnthropicErrorType {
  const listed = TYPE_BY_STATUS[status]
  if (listed) return listed
  return status >= 400 && status < 500 ? "invalid_request_error" : "api_error"
}

/** Upstream statuses worth a client retry. 501 is deliberately absent — a
 *  missing capability won't appear on retry. */
export function isTransientUpstreamStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504
}

/** Overflow wordings with extractable counts, as `[pattern, actual, limit]`
 *  capture-group indexes. */
const OVERFLOW_WITH_COUNTS: ReadonlyArray<readonly [RegExp, number, number]> = [
  // Anthropic (Copilot's native /v1/messages passes it through).
  [/prompt is too long:\s*(\d+)\s*tokens\s*>\s*(\d+)\s*maximum/i, 1, 2],
  // Copilot /chat/completions (`model_max_prompt_tokens_exceeded`).
  [/prompt token count of (\d+) exceeds the limit of (\d+)/i, 1, 2],
  // OpenAI `context_length_exceeded`.
  [/maximum context length is (\d+) tokens.*?resulted in (\d+) tokens/is, 2, 1],
]

// Deliberately narrow: "token limit" / "too many tokens" also appear in
// per-minute rate-limit messages, which must not trigger a compaction.
const OVERFLOW_TEXT =
  /prompt is too long|input is too long|context window|context length|maximum context/i

/**
 * Reword a context-overflow message into the form Claude Code compacts on,
 * or `null` when the message isn't an overflow. Counts are kept when the
 * upstream states them; otherwise the original text follows the prefix.
 */
export function contextOverflowMessage(message: string): string | null {
  for (const [pattern, actual, limit] of OVERFLOW_WITH_COUNTS) {
    const match = pattern.exec(message)
    if (match) {
      return `prompt is too long: ${match[actual]} tokens > ${match[limit]} maximum`
    }
  }
  return OVERFLOW_TEXT.test(message) ? `prompt is too long: ${message}` : null
}

/**
 * Classify an upstream failure for an Anthropic client: overflows (a 4xx
 * other than 429) become a compactable 400, transient 5xx become a retryable 529, and everything else
 * keeps its status with the matching type.
 */
export function classifyUpstreamError(
  status: number,
  message: string,
): ClassifiedError {
  // A rate limit or server error is never an overflow, whatever its text.
  const overflow =
    status >= 400 && status < 500 && status !== 429 ?
      contextOverflowMessage(message)
    : null
  if (overflow !== null) {
    return { status: 400, type: "invalid_request_error", message: overflow }
  }
  if (isTransientUpstreamStatus(status)) {
    return { status: 529, type: "overloaded_error", message }
  }
  return { status, type: anthropicErrorType(status), message }
}

export function anthropicErrorBody(
  type: AnthropicErrorType,
  message: string,
): AnthropicErrorBody {
  return { type: "error", error: { type, message } }
}
