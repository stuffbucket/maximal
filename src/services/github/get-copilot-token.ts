import consola from "consola"

import { getGitHubApiBaseUrl, githubHeaders } from "~/lib/api-config"
import { authFetch } from "~/lib/auth-fetch"
import { parseCopilotErrorBody } from "~/lib/copilot-error-parser"
import { CopilotAuthFatalError, HTTPError } from "~/lib/error"
import { COPILOT_TOKEN_TIMEOUT_MS } from "~/lib/http-timeouts"
import { state } from "~/lib/state"

export const getCopilotToken = async () => {
  const response = await authFetch(
    `${getGitHubApiBaseUrl()}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(state),
      timeoutMs: COPILOT_TOKEN_TIMEOUT_MS,
    },
  )

  if (!response.ok) {
    const errorText = await response.clone().text()
    consola.error("Failed to get Copilot token response body", errorText)

    // /copilot_internal/v2/token never returns "your model isn't allowed"
    // — every 401/403 from this endpoint means the underlying GitHub
    // identity can no longer mint a Copilot token. Apply the strict
    // (legacy) policy: any 401/403 is auth-fatal, regardless of body
    // markers. Other endpoints (completion services) use the shared
    // body-marker discriminator via isAuthFatal().
    if (response.status === 401 || response.status === 403) {
      // The raw upstream body (a gRPC string like "unauthorized:
      // AuthenticateToken authentication failed") is already logged above
      // and is unreadable in the UI. Map to a friendly, actionable message
      // by status — mirroring the wording in preflightCopilotError. The raw
      // remediationUrl still flows through to power the UI's remediation link.
      const parsed = parseCopilotErrorBody(errorText)
      const who = state.userName ?? "your account"
      const friendlyMessage =
        response.status === 401 ?
          `GitHub rejected ${who}'s token — it may be expired or revoked. Run \`gh auth login\` and try again, or sign in with a code.`
        : `${who} doesn't have access to GitHub Copilot. Pick another account with an active Copilot subscription, or sign in with a code.`
      throw new CopilotAuthFatalError(
        friendlyMessage,
        response.status,
        parsed.remediationUrl,
      )
    }

    throw new HTTPError("Failed to get Copilot token", response)
  }

  return (await response.json()) as GetCopilotTokenResponse
}

/**
 * Back-compat re-export. Older test files import `parseCopilotAuthFailure`
 * from this module; the implementation moved to `~/lib/copilot-error-parser`
 * as `parseCopilotErrorBody`. New callers should import directly from there.
 *
 * Preserves the auth-specific default message ("Copilot rejected this
 * token.") that the shared parser doesn't use — the shared parser's
 * default is generic ("Copilot returned an error.") so the same module
 * can serve non-auth completion-endpoint failures.
 */
export function parseCopilotAuthFailure(body: string): {
  message: string
  remediationUrl: string | null
} {
  const parsed = parseCopilotErrorBody(body)
  if (parsed.message === "Copilot returned an error.") {
    return { ...parsed, message: "Copilot rejected this token." }
  }
  return parsed
}

// Trimmed for the sake of simplicity
interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  // The authoritative completion host for THIS token. GitHub can migrate an
  // account between hosts (e.g. individual → enterprise on a plan/billing
  // change); the bearer minted here is only valid against its own
  // `endpoints.api`, and POSTing it elsewhere is rejected with 421 Misdirected
  // Request. We re-read this on every mint/refresh so the host self-heals.
  endpoints?: {
    api: string
    "origin-tracker"?: string
    proxy?: string
    telemetry?: string
  }
}
