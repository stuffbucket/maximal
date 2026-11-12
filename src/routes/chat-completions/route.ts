import { Hono } from "hono"

import { requireGithubAuth } from "~/lib/auth/request-auth"
import { withPause } from "~/lib/budget/pause-hold"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"

import { handleCompletion } from "./handler"

// Errors propagate to the error handler, which answers in this route's wire
// format; the token gate's "not signed in" goes the same way.
export const completionRoutes = new Hono()
completionRoutes.onError(proxyErrorHandler("openai"))
completionRoutes.use(requireGithubAuth)

completionRoutes.post(
  "/",
  withPause({
    wire: "openai",
    operation: "chat_completions",
    handler: handleCompletion,
    onError: proxyErrorHandler("openai"),
  }),
)
