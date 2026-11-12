import { Hono } from "hono"

import { requireGithubAuth } from "~/lib/auth/request-auth"
import { withPause } from "~/lib/budget/pause-hold"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"

import { handleResponses } from "./handler"

// Errors propagate to the error handler, which answers in this route's wire
// format; the token gate's "not signed in" goes the same way.
export const responsesRoutes = new Hono()
responsesRoutes.onError(proxyErrorHandler("openai"))
responsesRoutes.use(requireGithubAuth)

responsesRoutes.post(
  "/",
  withPause({
    wire: "openai",
    operation: "responses",
    handler: handleResponses,
    onError: proxyErrorHandler("openai"),
  }),
)
