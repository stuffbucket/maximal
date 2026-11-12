import { Hono } from "hono"

import { requireGithubAuth } from "~/lib/auth/request-auth"
import { withPause } from "~/lib/budget/pause-hold"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"

import { handleCountTokens } from "./count-tokens-handler"
import { handleCompletion } from "./handler"

// Errors propagate to the error handler, which answers in this route's wire
// format; the token gate's "not signed in" goes the same way.
export const messageRoutes = new Hono()
messageRoutes.onError(proxyErrorHandler("anthropic"))
messageRoutes.use(requireGithubAuth)

// A pause rule at its limit holds the request here rather than refusing it.
messageRoutes.post(
  "/",
  withPause({
    wire: "anthropic",
    operation: "messages",
    handler: handleCompletion,
    onError: proxyErrorHandler("anthropic"),
  }),
)

messageRoutes.post("/count_tokens", (c) => handleCountTokens(c))
