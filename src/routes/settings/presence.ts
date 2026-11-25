/**
 * /settings/api/presence — whether the person is at the machine.
 *
 * - `POST /` — the menu-bar shell's report (`PresenceReport`: `locked`,
 *   `idleSeconds`, `at`; anything else is refused). Replies with the status
 *   now in effect. Pushes `presence.changed` when the lock state changes.
 * - `GET /` — `PresenceStatus`, for debugging: unknown (`stale: true`) when
 *   there is no report or it is more than 30 s old.
 *
 * Local only; see `~/lib/presence`. Auth-gated by the parent
 * `/settings/api` middleware.
 */

import type { Context } from "hono"

import { Hono } from "hono"

import { PresenceReport, PresenceStatus } from "~/lib/config/settings-types"
import { currentPresence, recordPresence } from "~/lib/presence"

import { respondValidated } from "./respond-validated"

function respond(c: Context, status: PresenceStatus): Response {
  return respondValidated(
    c,
    { schema: PresenceStatus, label: "Presence" },
    status,
  )
}

export const presenceRoutes = new Hono()

presenceRoutes.get("/", (c) => respond(c, currentPresence()))

presenceRoutes.post("/", async (c) => {
  const body = PresenceReport.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json(
      {
        error: {
          message: "Invalid presence report",
          type: "validation_error",
          details: body.error.issues,
        },
      },
      400,
    )
  }
  return respond(c, recordPresence(body.data))
})
