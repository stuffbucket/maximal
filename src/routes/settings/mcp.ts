/**
 * /settings/api/mcp — turn brokered MCP endpoints on or off and choose which
 * client apps they reach.
 *
 * Auth-gated by the parent `/settings/api` middleware. Endpoints themselves
 * are defined in `config.json`; this route only toggles them. The work is in
 * `~/apps/mcp`, shared with the `maximal mcp` CLI.
 */

import { Hono } from "hono"

import { listMcpEndpoints, mcpBrokerHealth, setMcpEndpoint } from "~/apps/mcp"
import {
  McpEndpointsListResponse,
  McpEndpointToggleRequest,
  McpEndpointToggleResponse,
} from "~/lib/config/settings-types"
import { forwardError, HTTPError } from "~/lib/errors/error"

import { respondValidated } from "./respond-validated"

function httpError(message: string, status: number): HTTPError {
  return new HTTPError(message, new Response(message, { status }))
}

export const mcpRoutes = new Hono()

mcpRoutes.get("/", (c) => {
  try {
    return respondValidated(
      c,
      { schema: McpEndpointsListResponse, label: "MCP endpoints" },
      { endpoints: listMcpEndpoints(), broker: mcpBrokerHealth() },
    )
  } catch (error) {
    return forwardError(c, error)
  }
})

mcpRoutes.post("/:id", async (c) => {
  try {
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = McpEndpointToggleRequest.safeParse(body)
    if (!parsed.success) {
      throw httpError("Expected { enabled: boolean, clients?: string[] }", 400)
    }
    const result = await setMcpEndpoint(c.req.param("id"), parsed.data)
    if (!result) throw httpError("MCP endpoint not found", 404)
    return respondValidated(
      c,
      { schema: McpEndpointToggleResponse, label: "MCP endpoint" },
      {
        endpoint: result.endpoint,
        skipped: result.skipped,
        ...(result.adoptedFrom === undefined ?
          {}
        : {
            adoptedFrom: result.adoptedFrom,
            droppedEnvironment: result.droppedEnvironment ?? [],
          }),
      },
    )
  } catch (error) {
    return forwardError(c, error)
  }
})
