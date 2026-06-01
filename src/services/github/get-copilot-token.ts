import consola from "consola"

import { getGitHubApiBaseUrl, githubHeaders } from "~/lib/api-config"
import { CopilotAuthFatalError, HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const getCopilotToken = async () => {
  const response = await fetch(
    `${getGitHubApiBaseUrl()}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(state),
    },
  )

  if (!response.ok) {
    const errorText = await response.clone().text()
    consola.error("Failed to get Copilot token response body", errorText)

    // 401/403 from this endpoint means the GitHub token can no longer
    // mint a Copilot token — license revoked, org policy changed, or
    // the user must accept an updated Copilot TOS. There is no point
    // retrying; the only resolution is re-auth (after the user takes
    // whatever upstream action GHCP describes in the body).
    if (response.status === 401 || response.status === 403) {
      const { message, remediationUrl } = parseCopilotAuthFailure(errorText)
      throw new CopilotAuthFatalError(message, response.status, remediationUrl)
    }

    throw new HTTPError("Failed to get Copilot token", response)
  }

  return (await response.json()) as GetCopilotTokenResponse
}

/**
 * Pull a human message and a remediation URL out of GHCP's 401/403 body.
 *
 * The response shape isn't documented as a stable contract — observed
 * forms include `{message, documentation_url}` and `{notification:
 * {message, url}}`. We try a small set of structured fields first,
 * then fall back to a regex sweep for any github.com URL in the body.
 * Falls through cleanly when nothing is found: the caller will still
 * have the raw text in `message` to display.
 */
export function parseCopilotAuthFailure(body: string): {
  message: string
  remediationUrl: string | null
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // Non-JSON body. Use the raw text as the message; try to find a
    // URL in it anyway.
    return {
      message: body.trim() || "Copilot rejected this token.",
      remediationUrl: findGithubUrl(body),
    }
  }

  const message = extractMessage(parsed) ?? "Copilot rejected this token."
  const remediationUrl = extractRemediationUrl(parsed) ?? findGithubUrl(body)

  return { message, remediationUrl }
}

function extractMessage(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.message === "string") return obj.message
  const notif = obj.notification
  if (typeof notif === "object" && notif !== null) {
    const m = (notif as Record<string, unknown>).message
    if (typeof m === "string") return m
  }
  if (typeof obj.error === "string") return obj.error
  if (typeof obj.error_description === "string") return obj.error_description
  return null
}

function extractRemediationUrl(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const candidates = [
    obj.documentation_url,
    obj.message_url,
    obj.url,
    (obj.notification as Record<string, unknown> | undefined)?.url,
  ]
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//.test(c)) return c
  }
  return null
}

function findGithubUrl(text: string): string | null {
  const match = /https:\/\/github\.com\/[^\s"<>)]+/.exec(text)
  return match ? match[0] : null
}

// Trimmed for the sake of simplicity
interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
}
