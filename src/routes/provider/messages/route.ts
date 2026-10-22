import { Hono } from "hono"

import { forwardAnthropicError } from "~/lib/errors/error"

import { handleProviderCountTokens } from "./count-tokens-handler"
import { handleProviderMessages } from "./handler"

export const providerMessageRoutes = new Hono()

providerMessageRoutes.post("/", async (c) => {
  try {
    return await handleProviderMessages(c)
  } catch (error) {
    return await forwardAnthropicError(c, error)
  }
})

providerMessageRoutes.post("/count_tokens", async (c) => {
  try {
    return await handleProviderCountTokens(c)
  } catch (error) {
    return await forwardAnthropicError(c, error)
  }
})
