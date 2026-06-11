/**
 * Local GitHub CLI endpoints — /settings/api/gh/*.
 *
 * Read-only hinting for the auth UI: is `gh` installed, and which accounts is
 * it already signed in to. Inherits the /settings/api auth gate. See
 * src/services/gh-cli.ts — no token is read or returned here.
 */

import { Hono } from "hono"

import { forwardError, HTTPError } from "~/lib/error"
import {
  addAccountToDefaultRegistry,
  makeAccountRecord,
} from "~/lib/github-token-store"
import { detectGhCli, getGhAccountToken } from "~/services/gh-cli"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

/**
 * Verify a gh account's token actually works for Copilot BEFORE we adopt it.
 * Mirrors what boot does (the live identity check that was failing silently):
 * a stale/revoked token → GitHub rejects it; an account with no Copilot →
 * /copilot_internal/user 403/404. Returns a specific, user-facing message so
 * the UI can say WHY synchronously, instead of writing the token, rebooting,
 * and surfacing a generic "came back unauthenticated" 20s later. Returns null
 * when the token is usable.
 */
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

export const ghRoutes = new Hono()

ghRoutes.get("/status", async (c) => {
  try {
    return c.json(await detectGhCli())
  } catch (error) {
    return await forwardError(c, error)
  }
})

/**
 * Adopt a local `gh` account as the active GitHub identity: read its token via
 * the gh CLI and write it to the token store. The caller (shell) then reboots
 * the sidecar (`restart_sidecar`) so it boots signed-in to this account — we
 * don't mutate the running auth state here, just the on-disk config.
 *
 * The requested {login, host} MUST be one gh actually reports, so this can't
 * be used to fish for an arbitrary account's token.
 */
ghRoutes.post("/use", async (c) => {
  try {
    const body = (await c.req.json().catch(() => null)) as {
      login?: unknown
      host?: unknown
    } | null
    const login = body?.login
    const host = body?.host
    if (
      typeof login !== "string"
      || !login
      || typeof host !== "string"
      || !host
    ) {
      return c.json(
        { error: { message: "Expected { login, host } strings." } },
        400,
      )
    }

    const status = await detectGhCli()
    const known = status.accounts.some(
      (a) => a.login === login && a.host === host,
    )
    if (!known) {
      return c.json(
        { error: { message: `gh has no account ${login} on ${host}.` } },
        404,
      )
    }

    const token = await getGhAccountToken(login, host)
    if (!token) {
      return c.json(
        { error: { message: `Could not read the gh token for ${login}.` } },
        502,
      )
    }

    // Pre-flight: confirm the token works for Copilot BEFORE writing it +
    // rebooting, so a stale/no-subscription account fails fast with a specific
    // reason rather than a generic post-reboot "came back unauthenticated".
    const preflightError = await preflightCopilotError(token, login)
    if (preflightError) {
      return c.json({ error: { message: preflightError } }, 422)
    }

    // Persist as the active account (login+host from the validated request).
    // The shell reboots into this config; we don't mutate running state here.
    await addAccountToDefaultRegistry(
      makeAccountRecord({ login, host, token, addedVia: "gh-cli" }),
    )
    return c.json({ ok: true, login, host })
  } catch (error) {
    return await forwardError(c, error)
  }
})
