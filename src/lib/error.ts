import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import { markAuthFatalAndSignOut } from "./auth-controller"

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
    // upstream): clear the token and stash the remediation reason so
    // the Settings UI surfaces it as a banner. Forward the error to
    // the client with the upstream status — the client likely renders
    // it (e.g. Claude Code's "API error" surface), and the proxy's UI
    // signals the state change. Best-effort: failures inside the
    // handler must not block the client response.
    try {
      await markAuthFatalAndSignOut(error)
    } catch (handlerErr) {
      consola.warn(
        "markAuthFatalAndSignOut failed while forwarding upstream error:",
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
    return c.json(
      {
        error: {
          message: errorText,
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
