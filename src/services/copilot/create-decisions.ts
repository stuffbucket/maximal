/**
 * Copilot's decision endpoints, served by `decisions`-type models:
 * `/v1/decisions` (the OpenAI Decisions API) and `/v1/systemone`. Both answer
 * one JSON body (no streaming) that Maximal relays unchanged.
 */

import { postCopilotJson } from "./post-copilot-json"

/** A JSON request body. Only `model` is read; the rest goes upstream as is. */
export interface DecisionsPayload {
  model?: unknown
  [key: string]: unknown
}

/** The fields Maximal reads from a `/v1/decisions` reply. */
export interface DecisionsResult {
  usage?: {
    input_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens?: number
    total_tokens?: number
  }
  [key: string]: unknown
}

/** The fields Maximal reads from a `/v1/systemone` reply. */
export interface SystemOneResult {
  usage?: { input_tokens?: number; output_tokens?: number }
  [key: string]: unknown
}

interface DecisionsCallOptions {
  signal?: AbortSignal
}

export const createDecisions = (
  payload: DecisionsPayload,
  { signal }: DecisionsCallOptions = {},
): Promise<DecisionsResult> =>
  postCopilotJson<DecisionsResult>("/v1/decisions", payload, {
    signal,
    errorMessage: "Failed to create decisions",
  })

export const createSystemOne = (
  payload: DecisionsPayload,
  { signal }: DecisionsCallOptions = {},
): Promise<SystemOneResult> =>
  postCopilotJson<SystemOneResult>("/v1/systemone", payload, {
    signal,
    errorMessage: "Failed to create SystemOne decisions",
  })
