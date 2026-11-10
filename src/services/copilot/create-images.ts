/**
 * Copilot's image endpoints (`/v1/images/generations`, `/v1/images/edits`),
 * served by `image`-type models. Both answer one JSON body (no streaming) that
 * Maximal relays unchanged.
 */

import { postCopilotJson } from "./post-copilot-json"

/** A JSON request body. Only `model` is read; the rest goes upstream as is. */
export interface ImagesPayload {
  model?: unknown
  [key: string]: unknown
}

/** An image edit: the parsed JSON body or the client's multipart form. */
export type ImageEditBody = ImagesPayload | FormData

export interface ImagesUsage {
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens?: number
  total_tokens?: number
}

/** The fields Maximal reads from an images reply; the rest is relayed as is.
 *  The reply has no top-level `model`. */
export interface ImagesResult {
  usage?: ImagesUsage
  copilot_usage?: { total_nano_aiu?: unknown }
  [key: string]: unknown
}

interface ImagesCallOptions {
  signal?: AbortSignal
}

export const createImageGeneration = (
  payload: ImagesPayload,
  { signal }: ImagesCallOptions = {},
): Promise<ImagesResult> =>
  postCopilotJson<ImagesResult>("/v1/images/generations", payload, {
    signal,
    errorMessage: "Failed to generate images",
  })

export const createImageEdit = (
  body: ImageEditBody,
  { signal }: ImagesCallOptions = {},
): Promise<ImagesResult> =>
  postCopilotJson<ImagesResult>("/v1/images/edits", body, {
    signal,
    errorMessage: "Failed to edit images",
  })
