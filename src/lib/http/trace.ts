import type { MiddlewareHandler } from "hono"

import {
  requestContext,
  resolveTraceId,
  type RequestContext,
} from "~/lib/http/request-context"

export const traceIdMiddleware: MiddlewareHandler = async (c, next) => {
  const traceId = resolveTraceId(c.req.header("x-trace-id"))

  c.header("x-trace-id", traceId)

  const context: RequestContext = {
    traceId,
    startTime: Date.now(),
    userAgent: c.req.header("user-agent") || "",
    sessionAffinity: c.req.header("x-session-affinity"),
    parentSessionId: c.req.header("x-parent-session-id"),
    usage: {},
  }

  await requestContext.run(context, async () => {
    await next()
  })
}
