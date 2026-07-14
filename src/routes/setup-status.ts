import { createRoute, OpenAPIHono } from "@hono/zod-openapi"

import { evaluateSetup, SetupStatusSchema } from "~/lib/config/setup-status"
import { forwardError } from "~/lib/errors/error"

// Unauthenticated by design — this is the endpoint a fresh install
// (no API keys yet) polls to find out what's missing. Registered in
// server.ts's allowUnauthenticatedPaths.
//
// The route is defined via `createRoute` so its OpenAPI operation is
// generated FROM the same `SetupStatusSchema` the handler returns. That
// binding is deliberate: the published spec (served at /openapi.json)
// cannot drift from the runtime response, because both are the one
// schema. See docs ADR-0018 (OpenAPI client-facing scope).
export const setupStatusRoute = new OpenAPIHono()

const getSetupStatus = createRoute({
  method: "get",
  path: "/",
  summary: "Report first-run / runtime setup status",
  description:
    "Unauthenticated snapshot of the local install's readiness "
    + "(app dir, config, db, GitHub auth) that a fresh install polls to "
    + "discover what is still missing.",
  responses: {
    200: {
      description: "Current setup status.",
      content: {
        "application/json": {
          schema: SetupStatusSchema,
        },
      },
    },
  },
})

setupStatusRoute.openapi(getSetupStatus, async (c) => {
  return c.json(await evaluateSetup(), 200)
})

// `openapi()` requires the handler to return a schema-typed response, so
// the error path can't route through it. Fall back to the shared
// `forwardError` shape via a plain handler registered under the same
// route, catching anything `evaluateSetup` throws.
setupStatusRoute.onError((error, c) => forwardError(c, error))
