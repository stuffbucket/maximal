/**
 * /settings/api/requests — MCP servers' requests for user input waiting for
 * an answer in Maximal (a form to fill in, or a URL to open).
 *
 * Auth-gated by the parent `/settings/api` middleware; never exposed on the
 * public `/status`, since requests carry server text. The list is also
 * pushed as `requests.changed` on `/settings/api/events`. The shell polls
 * only the summary, to notice a new request without reading its contents.
 */

import { Hono } from "hono"

import {
  PendingRequestAnswer,
  PendingRequestAnswerResponse,
  PendingRequestsResponse,
  PendingRequestsSummary,
} from "~/lib/config/settings-types"
import { forwardError, HTTPError } from "~/lib/errors/error"
import {
  type PendingRequests,
  pendingRequests,
} from "~/lib/mcp-broker/pending-requests"

import { respondValidated } from "./respond-validated"

function httpError(message: string, status: number): HTTPError {
  return new HTTPError(message, new Response(message, { status }))
}

export function createRequestsRoutes(store: PendingRequests): Hono {
  const routes = new Hono()

  routes.get("/", (c) =>
    respondValidated(
      c,
      { schema: PendingRequestsResponse, label: "Pending requests" },
      store.list(),
    ),
  )

  routes.get("/summary", (c) =>
    respondValidated(
      c,
      { schema: PendingRequestsSummary, label: "Pending requests summary" },
      store.summary(),
    ),
  )

  routes.post("/:id", async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => null)
      const parsed = PendingRequestAnswer.safeParse(body)
      if (!parsed.success) {
        throw httpError(
          'Expected { action: "accept" | "decline" | "cancel", content?: object }',
          400,
        )
      }
      const outcome = store.answer(c.req.param("id"), parsed.data)
      if (!outcome.ok) {
        switch (outcome.reason) {
          case "not-found": {
            throw httpError("This request is no longer waiting", 404)
          }
          case "answered": {
            throw httpError("This request was already answered", 409)
          }
          default: {
            throw httpError(outcome.problems.join("; "), 422)
          }
        }
      }
      return respondValidated(
        c,
        { schema: PendingRequestAnswerResponse, label: "Request answer" },
        { ok: true },
      )
    } catch (error) {
      return forwardError(c, error)
    }
  })

  return routes
}

export const requestsRoutes = createRequestsRoutes(pendingRequests)
