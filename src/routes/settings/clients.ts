/**
 * /settings/api/clients — "who's connected to Maximal right now?"
 *
 * Auth-gated by the parent middleware (the `/settings/api` group is in
 * `requireAuthPrefixes`, so even when the static settings bundle is
 * unauth-served, this data endpoint isn't). Returns the in-memory
 * tracker filtered by a caller-supplied freshness window.
 *
 * The menu-bar shell uses this on quit to render "N apps are using
 * Maximal" — purely informational, no load-bearing decisions hang
 * off the response.
 */

import { Hono } from "hono"
import { z } from "zod"

import { listActiveClients } from "~/lib/active-clients"
import { forwardError } from "~/lib/error"

const QuerySchema = z.object({
  maxAgeSeconds: z.coerce.number().int().min(5).max(600).default(60),
})

export const clientsRoutes = new Hono()

clientsRoutes.get("/", (c) => {
  try {
    const parsed = QuerySchema.safeParse({
      maxAgeSeconds: c.req.query("maxAgeSeconds"),
    })
    if (!parsed.success) {
      return c.json(
        {
          error: {
            message: "Invalid query parameters",
            type: "validation_error",
          },
        },
        400,
      )
    }
    const clients = listActiveClients(parsed.data.maxAgeSeconds)
    return c.json({ clients, total: clients.length })
  } catch (error) {
    return forwardError(c, error)
  }
})
