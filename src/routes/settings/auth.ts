/**
 * GitHub auth endpoints — /settings/api/auth/github/*.
 *
 * Thin HTTP wrappers over src/lib/auth-controller.ts. Lives under the
 * /settings/api prefix and inherits its auth gate (createAuthMiddleware
 * requires x-api-key / Bearer; the prefix is NOT in the unauth allowlist).
 *
 * No browser-opening, no clipboard, no blocking. The shell calls
 * /start, renders the user_code itself, then watches /status (live via
 * SSE, see ADR-0007) until the state flips to authenticated (or error).
 *
 * /cancel aborts an in-flight device flow WITHOUT signing out — it returns
 * to the prior signed-in account if there was one, else signed-out. /start
 * likewise preserves the current session (issuing a code does not sign you
 * out); only a successful poll or an explicit /sign-out replaces it.
 */

import { Hono } from "hono"

import {
  cancelDeviceFlow,
  getAuthStatus,
  signOut,
  startDeviceFlow,
} from "~/lib/auth-controller"
import { forwardError } from "~/lib/error"

export const authRoutes = new Hono()

authRoutes.get("/status", (c) => c.json(getAuthStatus()))

authRoutes.post("/start", async (c) => {
  try {
    const status = await startDeviceFlow()
    return c.json(status)
  } catch (error) {
    return await forwardError(c, error)
  }
})

authRoutes.post("/cancel", (c) => c.json(cancelDeviceFlow()))

authRoutes.post("/sign-out", async (c) => {
  try {
    await signOut()
    return c.json({ ok: true })
  } catch (error) {
    return await forwardError(c, error)
  }
})
