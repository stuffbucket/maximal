import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import type { RearmOutcome } from "~/lib/auth/auth-controller"

import { markAuthDegraded, rearmCopilotAuth } from "~/lib/auth/auth-controller"
import { adviseUpstreamError } from "~/lib/errors/upstream-error-advice"
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
    // A Copilot 401/403 from a completion endpoint might be a merely-STALE
    // short-lived bearer (common after the laptop sleeps past the ~25-min
    // bearer TTL), NOT a dead GitHub identity. Try to re-mint from the retained
    // credential first — the mint is the discriminator (it 401s only if the
    // identity is genuinely bad). This is the antidote to the "wedged until you
    // switch accounts" bug: previously ANY completion 401 terminally degraded a
    // fully-recoverable session.
    let outcome: RearmOutcome = "auth_fatal"
    try {
      outcome = await rearmCopilotAuth()
    } catch (handlerErr) {
      consola.warn(
        "rearmCopilotAuth threw while forwarding upstream error:",
        handlerErr,
      )
    }

    if (outcome !== "auth_fatal") {
      // "online" → we re-minted a fresh bearer and the session is healthy again.
      // "offline" → the mint failed transiently; don't wedge the session over a
      // network blip. Either way, ask the client to retry rather than degrade:
      // the fresh bearer (online) or the next attempt (offline) serves it.
      return c.json(
        {
          error: {
            message:
              outcome === "online" ?
                "Re-authenticated with Copilot after a stale token; please retry the request."
              : "Reconnecting to Copilot; please retry the request.",
            type: "server_error",
          },
        },
        503,
      )
    }

    // Genuinely auth-fatal (the re-mint itself was rejected, or there is no
    // GitHub credential): degrade NON-DESTRUCTIVELY — drop the live token + flag
    // the account needs-reauth, but RETAIN the on-disk credential (a single
    // transient 401 here must never delete the saved account; that was the
    // bug). Stash the remediation reason so the Settings UI surfaces it.
    // Forward the error to the client with the upstream status — the client
    // likely renders it (e.g. Claude Code's "API error" surface). Best-effort:
    // failures inside the handler must not block the client response.
    try {
      await markAuthDegraded(error)
    } catch (handlerErr) {
      consola.warn(
        "markAuthDegraded failed while forwarding upstream error:",
        handlerErr,
      )
    }
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
    if (error.response.status === 429) {
      for (const [name, value] of error.response.headers) {
        const lowerName = name.toLowerCase()
        if (lowerName === "retry-after" || lowerName.startsWith("x-")) {
          c.header(name, value)
        }
      }
    }

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
