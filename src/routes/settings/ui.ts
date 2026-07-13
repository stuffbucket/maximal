/**
 * /settings/api/ui — control where Maximal shows up in the OS.
 *
 * A single boolean, `config.ui.menuBarOnly`:
 *   - true  => menu-bar (macOS) / system-tray (Windows) ONLY.
 *   - absent/false => the default, which ALSO shows Maximal in the Dock
 *     on macOS / the taskbar on Windows.
 *
 * Auth-gated by the parent `/settings/api` middleware. Persistence is
 * `config.ui`, round-tripped through `writeConfig()`. The Rust shell
 * reads the same field to apply the activation policy at launch.
 */

import { Hono } from "hono"

import { getConfig, writeConfig, type AppConfig } from "~/lib/config/config"
import { forwardError, HTTPError } from "~/lib/errors/error"

/** Build an HTTPError whose body is a plain message, so `forwardError`
 *  surfaces a clean `{ error: { message } }` at the given status. */
function httpError(message: string, status: number): HTTPError {
  return new HTTPError(message, new Response(message, { status }))
}

export const uiRoutes = new Hono()

uiRoutes.get("/", (c) => {
  try {
    return c.json({ menuBarOnly: getConfig().ui?.menuBarOnly ?? false })
  } catch (error) {
    return forwardError(c, error)
  }
})

uiRoutes.post("/", async (c) => {
  try {
    const body: unknown = await c.req.json().catch(() => null)
    if (
      typeof body !== "object"
      || body === null
      || typeof (body as { menuBarOnly?: unknown }).menuBarOnly !== "boolean"
    ) {
      throw httpError("Expected { menuBarOnly: boolean }", 400)
    }
    const menuBarOnly = (body as { menuBarOnly: boolean }).menuBarOnly

    const config: AppConfig = getConfig()
    writeConfig({ ...config, ui: { ...config.ui, menuBarOnly } })

    return c.json({ menuBarOnly })
  } catch (error) {
    return forwardError(c, error)
  }
})
