/** Safely read unvalidated upstream SSE frames without throwing on missing fields. */

/** `value` as an object record, or `undefined` when it is not an object. */
export const asRecord = (
  value: unknown,
): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ?
    (value as Record<string, unknown>)
  : undefined

/**
 * A usage object as it appears on an unvalidated frame. Every field is optional
 * because the upstream frame has not been checked yet.
 */
export interface FrameUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  total_tokens?: number
}

/** Read a usage object nested one level under `frame[key]`. */
export const readNestedUsage = (
  frame: unknown,
  key: string,
): FrameUsage | undefined => asRecord(asRecord(asRecord(frame)?.[key])?.usage)

/** Read the top-level usage object on an unvalidated frame. */
export const readUsage = (frame: unknown): FrameUsage | undefined =>
  asRecord(asRecord(frame)?.usage)
