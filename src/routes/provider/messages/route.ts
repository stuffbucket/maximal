import { Hono } from "hono"

import { requireGithubAuth } from "~/lib/auth/request-auth"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"

import { handleProviderCountTokens } from "./count-tokens-handler"
import { handleProviderMessages } from "./handler"

// Errors propagate to the error handler, which answers in this route's wire
// format; the token gate's "not signed in" goes the same way.
export const providerMessageRoutes = new Hono()
providerMessageRoutes.onError(proxyErrorHandler("anthropic"))
providerMessageRoutes.use(requireGithubAuth)

providerMessageRoutes.post("/", (c) => handleProviderMessages(c))

providerMessageRoutes.post("/count_tokens", (c) => handleProviderCountTokens(c))
