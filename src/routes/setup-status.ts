import { Hono } from "hono"

import { evaluateSetup } from "~/lib/setup-status"

export const setupStatusRoute = new Hono()

// Unauthenticated by design — this is the endpoint a fresh install
// (no API keys yet) polls to find out what's missing. Registered in
// server.ts's allowUnauthenticatedPaths.
setupStatusRoute.get("/", async (c) => c.json(await evaluateSetup()))
