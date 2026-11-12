import { copilotBaseUrl, copilotHeaders } from "~/lib/config/api-config"
import { sendRequest } from "~/lib/http/send-request"
import { state } from "~/lib/runtime-state/state"

import { finishUpstreamResponse, requireCopilotToken } from "./upstream-request"

/** A Copilot endpoint body: JSON (sent as a string) or a multipart form. */
export type CopilotPostBody = Record<string, unknown> | FormData

/**
 * POST a body to a non-streaming Copilot endpoint (`path`, the catalog's
 * endpoint path, is appended to the Copilot base URL) and return its parsed
 * JSON, through the same error tail as the inference calls. A `FormData` body goes out without the base headers'
 * `content-type`, so `fetch` writes the multipart type with a fresh boundary.
 * No timeout: image generation can take minutes; `signal` ends the call when
 * the client goes away. `sendRequest` swaps the transport (tests, and the
 * Copilot provider's injected seam).
 */
export const postCopilotJson = async <T>(
  path: string,
  body: CopilotPostBody,
  {
    signal,
    errorMessage,
    sendRequest: send = sendRequest,
  }: {
    signal?: AbortSignal
    errorMessage: string
    sendRequest?: typeof sendRequest
  },
): Promise<T> => {
  requireCopilotToken()

  const isForm = body instanceof FormData
  const baseHeaders = copilotHeaders(state)
  const headers =
    isForm ?
      Object.fromEntries(
        Object.entries(baseHeaders).filter(
          ([name]) => name.toLowerCase() !== "content-type",
        ),
      )
    : baseHeaders

  const response = await send(`${copilotBaseUrl(state)}${path}`, {
    method: "POST",
    headers,
    body: isForm ? body : JSON.stringify(body),
    signal,
  })

  // `stream: false` always yields the parsed body.
  return (await finishUpstreamResponse<T>(response, {
    stream: false,
    errorMessage,
    call: { endpoint: path, model: bodyModel(body) },
  })) as T
}

/** The `model` the body names, for the error advice. */
function bodyModel(body: CopilotPostBody): string | undefined {
  const model = body instanceof FormData ? body.get("model") : body.model
  return typeof model === "string" ? model : undefined
}
