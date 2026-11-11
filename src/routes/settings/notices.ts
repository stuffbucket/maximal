/**
 * /settings/api/notices — one-time notices for the menu-bar shell to show.
 *
 * POST /working hands over the "Maximal is working" notice (see
 * ~/lib/working-notice) and clears it, so the shell's poll shows it once.
 * POST /plugins hands over the plugins' queued notices (see
 * ~/lib/plugins/notices), `{ notices: [{ plugin, name, code, message,
 * params }] }`, oldest first. POST, not GET: reading consumes them.
 */

import { Hono } from "hono"

import { takePluginNotices } from "~/lib/plugins/notices"
import { takeWorkingNotice } from "~/lib/working-notice"

export const noticesRoutes = new Hono()

noticesRoutes.post("/working", (c) => c.json({ notice: takeWorkingNotice() }))

noticesRoutes.post("/plugins", (c) => c.json({ notices: takePluginNotices() }))
