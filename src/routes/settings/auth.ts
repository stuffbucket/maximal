/**
 * GitHub auth endpoints — /settings/api/auth/github/*.
 *
 * Thin HTTP wrappers over src/lib/auth-controller.ts. Lives under the
 * /settings/api prefix and inherits its auth gate (createAuthMiddleware
 * requires x-api-key / Bearer; the prefix is NOT in the unauth allowlist).
 *
 * No browser-opening, no clipboard, no blocking. The shell calls
 * /start, renders the user_code itself, then polls /status until the
 * state flips to authenticated (or error).
 */

import { Hono } from "hono"

import { getAuthStatus, signOut, startDeviceFlow } from "~/lib/auth-controller"
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

authRoutes.post("/sign-out", async (c) => {
  try {
    await signOut()
    return c.json({ ok: true })
  } catch (error) {
    return await forwardError(c, error)
  }
})
