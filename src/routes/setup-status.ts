import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { evaluateSetup } from "~/lib/setup-status"

export const setupStatusRoute = new Hono()

// Unauthenticated by design — this is the endpoint a fresh install
// (no API keys yet) polls to find out what's missing. Registered in
// server.ts's allowUnauthenticatedPaths.
setupStatusRoute.get("/", async (c) => {
  try {
    return c.json(await evaluateSetup())
  } catch (error) {
    return forwardError(c, error)
  }
})
