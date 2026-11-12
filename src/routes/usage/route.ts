import { Hono } from "hono"

import { observeCopilotUsage } from "~/lib/budget/copilot-windows"
import { forwardError } from "~/lib/errors/error"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

export const usageRoute = new Hono()

usageRoute.get("/", async (c) => {
  try {
    const usage = await getCopilotUsage()
    observeCopilotUsage(usage)
    return c.json(usage)
  } catch (error) {
    return forwardError(c, error)
  }
})
