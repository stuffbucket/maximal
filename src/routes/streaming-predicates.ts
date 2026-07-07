/**
 * Shared runtime type-guards for the streaming vs non-streaming split
 * that every completions flow makes on `payload.stream`.
 *
 * These were previously copy-pasted across the messages, chat-completions
 * and responses handlers. Keeping one definition removes the silent-drift
 * risk the audit flagged (B10) — a change to how we detect a non-streaming
 * body now lands in exactly one place.
 */

import {
  createChatCompletions,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

/** A completions response is non-streaming iff it carries `choices`
 *  (the streaming path yields an async iterable of chunks instead). */
export const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

/** True when `value` is an async iterable (i.e. an SSE chunk stream). */
export const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
