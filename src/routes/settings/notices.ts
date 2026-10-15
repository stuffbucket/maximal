/**
 * /settings/api/notices — one-time notices for the menu-bar shell to show.
 *
 * POST /working hands over the "Maximal is working" notice (see
 * ~/lib/working-notice) and clears it, so the shell's poll shows it once.
 * POST, not GET: reading it consumes it.
 */

import { Hono } from "hono"

import { takeWorkingNotice } from "~/lib/working-notice"

export const noticesRoutes = new Hono()

noticesRoutes.post("/working", (c) => c.json({ notice: takeWorkingNotice() }))
