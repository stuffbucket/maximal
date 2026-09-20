/**
 * Pre-flight a GitHub token against Copilot BEFORE adopting it as the active
 * account — used by both the gh-reuse adopt path and the multi-account switch
 * path, so it lives here rather than in either route module.
 *
 * Mirrors what boot does (the live identity check): a stale/revoked token →
 * GitHub rejects it (401); an account with no Copilot entitlement →
 * /copilot_internal/user 403/404. Returns a specific, user-facing message so
 * the UI can say WHY synchronously — instead of writing the token, rebooting,
 * and surfacing a generic "came back unauthenticated" 20s later. Returns null
 * when the token is usable. The `usage` lookup is injectable for tests.
 */

import { HTTPError } from "~/lib/errors/error"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

export type PreflightCopilotErrorFn = (
  token: string,
  login: string,
) => Promise<string | null>

export async function preflightCopilotError(
  token: string,
  login: string,
  usage: (token: string) => Promise<unknown> = getCopilotUsage,
): Promise<string | null> {
  try {
    await usage(token)
    return null
  } catch (error) {
    const status = error instanceof HTTPError ? error.response.status : 0
    if (status === 401) {
      return `GitHub rejected ${login}'s token — it may be expired or revoked. Run \`gh auth login\` and try again, or sign in with a code.`
    }
    if (status === 403 || status === 404) {
      return `${login} doesn't have access to GitHub Copilot. Pick another account, or sign in with a code.`
    }
    return `Couldn't verify ${login} with GitHub${status ? ` (HTTP ${status})` : ""}. Check your connection and try again.`
  }
}
