/**
 * Multi-account roster endpoints — /settings/api/accounts/*.
 *
 * Quick-switch over maximal's PERSISTED accounts: list them, set the active
 * one, or forget one. Inherits the /settings/api auth gate. Switching and
 * removing only edit maximal's own on-disk registry — they never touch `gh`,
 * the keyring, or any GitHub session (the HARD ISOLATION INVARIANT). After a
 * switch/remove the shell reboots the sidecar so it boots into the new active
 * config; we don't mutate the running auth state here.
 *
 * Token values are never returned by any endpoint here.
 */

import { Hono } from "hono"

import { preflightCopilotError } from "~/lib/copilot-preflight"
import { forwardError } from "~/lib/error"
import {
  listAccounts,
  readDefaultRegistry,
  removeAccount,
  setActive,
  writeDefaultRegistry,
} from "~/lib/github-token-store"

export const accountsRoutes = new Hono()

/** Read `{ key }` from the JSON body, or null if it isn't a non-empty string. */
async function readKey(c: {
  req: { json: () => Promise<unknown> }
}): Promise<string | null> {
  const body = (await c.req.json().catch(() => null)) as {
    key?: unknown
  } | null
  const key = body?.key
  return typeof key === "string" && key ? key : null
}

accountsRoutes.get("/", async (c) => {
  try {
    const reg = await readDefaultRegistry()
    const accounts = listAccounts(reg).map((a) => ({
      key: a.key,
      login: a.login,
      host: a.host,
      added_via: a.addedVia,
      obtained_at: a.obtainedAt,
      active: a.active,
    }))
    return c.json({ accounts, active_key: reg.activeKey })
  } catch (error) {
    return await forwardError(c, error)
  }
})

/**
 * Set the active account. Pre-flights the target token against Copilot BEFORE
 * flipping the pointer (the token is already in the registry, so a bad switch
 * would otherwise cost a full reboot to discover) — returns a specific 422 if
 * the account is no longer usable. The shell reboots on a 2xx.
 */
accountsRoutes.post("/switch", async (c) => {
  try {
    const key = await readKey(c)
    if (!key) {
      return c.json({ error: { message: "Expected { key } string." } }, 400)
    }
    const reg = await readDefaultRegistry()
    if (!(key in reg.accounts)) {
      return c.json({ error: { message: `No account ${key}.` } }, 404)
    }
    const target = reg.accounts[key]
    const preflightError = await preflightCopilotError(
      target.token,
      target.login,
    )
    if (preflightError) {
      return c.json({ error: { message: preflightError } }, 422)
    }
    await writeDefaultRegistry(setActive(reg, key))
    return c.json({ ok: true, key })
  } catch (error) {
    return await forwardError(c, error)
  }
})

/**
 * Forget an account — deletes maximal's OWN copy of its token from the
 * registry. gh is untouched. If the removed account was active, `activeKey`
 * falls to null and the shell reboots into unauthenticated.
 */
accountsRoutes.post("/remove", async (c) => {
  try {
    const key = await readKey(c)
    if (!key) {
      return c.json({ error: { message: "Expected { key } string." } }, 400)
    }
    const reg = await readDefaultRegistry()
    if (!(key in reg.accounts)) {
      return c.json({ error: { message: `No account ${key}.` } }, 404)
    }
    const wasActive = reg.activeKey === key
    await writeDefaultRegistry(removeAccount(reg, key))
    return c.json({ ok: true, key, was_active: wasActive })
  } catch (error) {
    return await forwardError(c, error)
  }
})
