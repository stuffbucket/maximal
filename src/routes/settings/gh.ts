/**
 * Local GitHub CLI endpoints — /settings/api/gh/*.
 *
 * Read-only hinting for the auth UI: is `gh` installed, and which accounts is
 * it already signed in to. Inherits the /settings/api auth gate. See
 * src/services/gh-cli.ts — no token is read or returned here.
 */

import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { detectGhCli } from "~/services/gh-cli"

export const ghRoutes = new Hono()

ghRoutes.get("/status", async (c) => {
  try {
    return c.json(await detectGhCli())
  } catch (error) {
    return await forwardError(c, error)
  }
})
