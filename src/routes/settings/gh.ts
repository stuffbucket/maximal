/**
 * Local GitHub CLI endpoints — /settings/api/gh/*.
 *
 * Read-only hinting for the auth UI: is `gh` installed, and which accounts is
 * it already signed in to. Inherits the /settings/api auth gate. See
 * src/services/gh-cli.ts — no token is read or returned here.
 */

import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { makeRecord, writeDefaultRecord } from "~/lib/github-token-store"
import { detectGhCli, getGhAccountToken } from "~/services/gh-cli"

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

    await writeDefaultRecord(makeRecord(token))
    return c.json({ ok: true, login, host })
  } catch (error) {
    return await forwardError(c, error)
  }
})
