import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import { markAuthDegraded } from "~/lib/auth/auth-controller"
import {
  anthropicErrorBody,
  anthropicErrorType,
  classifyUpstreamError,
  isTransientUpstreamStatus,
} from "~/lib/errors/anthropic-error"
import {
  adviseUpstreamError,
  parseUpstreamError,
} from "~/lib/errors/upstream-error-advice"
import { state } from "~/lib/runtime-state/state"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

/**
 * Thrown when GHCP rejects our GitHub token at the Copilot exchange
 * (401/403). Carries the upstream message and any remediation URL
 * (e.g. updated Copilot TOS, license-management page) so the auth
 * controller can stash both for the Settings UI to render.
 *
 * Distinct from HTTPError because the action is fixed: clear the
 * token, stop the refresh loop, show the user how to recover. The
 * refresh loop and setup path discriminate on this type.
 */
export class CopilotAuthFatalError extends Error {
  status: number
  remediationUrl: string | null

  constructor(message: string, status: number, remediationUrl: string | null) {
    super(message)
    this.status = status
    this.remediationUrl = remediationUrl
  }
}

export async function forwardError(
  c: Context,
  error: unknown,
): Promise<Response> {
  consola.error("Error occurred:", error)

  if (error instanceof CopilotAuthFatalError) {
    // Auth-fatal from a completion endpoint (or any other Copilot
    // upstream): degrade NON-DESTRUCTIVELY — drop the live token + flag the
    // account needs-reauth, but RETAIN the on-disk credential (a single
    // transient 401 here must never delete the saved account; that was the
    // bug). Stash the remediation reason so the Settings UI surfaces it.
    // Forward the error to the client with the upstream status — the client
    // likely renders it (e.g. Claude Code's "API error" surface). Best-effort:
    // failures inside the handler must not block the client response.
    await degradeAuth(error)
    return c.json(
      {
        error: {
          message: error.message,
          type: "auth_fatal",
          ...(error.remediationUrl ?
            { remediation_url: error.remediationUrl }
          : {}),
        },
      },
      error.status as ContentfulStatusCode,
    )
  }

  if (error instanceof HTTPError) {
    if (error.response.status === 429) relayRetryHeaders(c, error.response)

    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)

    // Recognizable upstream errors (e.g. Copilot's opaque
    // `model_not_supported` 400) get reframed into context + a recovery
    // step, with the original error preserved inline. Unrecognized errors
    // forward the raw body unchanged.
    const message =
      adviseUpstreamError(
        error.response.status,
        errorText,
        state.models?.data ?? [],
      ) ?? errorText
    return c.json(
      {
        error: {
          message,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}

/**
 * `forwardError` for the Anthropic-wire routes (`/v1/messages` and its
 * `count_tokens`). Same side effects — auth-fatal degrades the account,
 * rate-limit headers are relayed, recognizable errors get advice — but the
 * body is Anthropic's typed envelope, transient upstream 5xx become a
 * retryable 529 `overloaded_error`, and a context overflow is reworded so
 * Claude Code compacts instead of stopping. See `anthropic-error.ts`.
 */
export async function forwardAnthropicError(
  c: Context,
  error: unknown,
): Promise<Response> {
  consola.error("Error occurred:", error)

  if (error instanceof CopilotAuthFatalError) {
    await degradeAuth(error)
    const message =
      error.remediationUrl ?
        `${error.message} (${error.remediationUrl})`
      : error.message
    return c.json(
      anthropicErrorBody(anthropicErrorType(error.status), message),
      error.status as ContentfulStatusCode,
    )
  }

  if (error instanceof HTTPError) {
    const status = error.response.status
    if (status === 429 || isTransientUpstreamStatus(status)) {
      relayRetryHeaders(c, error.response)
    }

    const errorText = await error.response.text()
    consola.error("HTTP error:", errorText)

    const upstream = parseUpstreamError(status, errorText)
    const classified = classifyUpstreamError(status, upstream.message)
    // A reworded overflow must reach the client verbatim — Claude Code
    // matches on its exact prefix — so advice only frames the other errors.
    const reworded = classified.message !== upstream.message
    const message =
      reworded ?
        classified.message
      : (adviseUpstreamError(status, errorText, state.models?.data ?? [])
        ?? classified.message)
    return c.json(
      anthropicErrorBody(classified.type, message),
      classified.status as ContentfulStatusCode,
    )
  }

  return c.json(anthropicErrorBody("api_error", (error as Error).message), 500)
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

/** Relay `Retry-After` and the upstream's `x-*` rate-limit headers. */
function relayRetryHeaders(c: Context, response: Response): void {
  for (const [name, value] of response.headers) {
    const lowerName = name.toLowerCase()
    if (lowerName === "retry-after" || lowerName.startsWith("x-")) {
      c.header(name, value)
    }
  }
}
