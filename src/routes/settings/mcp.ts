/**
 * /settings/api/mcp — turn brokered MCP endpoints on or off and choose which
 * client apps they reach.
 *
 * Auth-gated by the parent `/settings/api` middleware. Endpoints live in
 * `config.json`; this route lists them with the known servers found on this
 * machine, adds a found one, toggles, and removes. The work is in
 * `~/apps/mcp`, shared with the `maximal mcp` CLI.
 */

import { Hono } from "hono"

import {
  addMcpEndpoint,
  catalogServer,
  listMcpCatalog,
  listMcpEndpoints,
  mcpBrokerHealth,
  McpEndpointError,
  refreshCatalogCommands,
  removeMcpEndpoint,
  setMcpEndpoint,
} from "~/apps/mcp"
import { getConfig } from "~/lib/config/config"
import {
  McpEndpointAddRequest,
  McpEndpointAddResponse,
  McpEndpointRemoveResponse,
  McpEndpointsListResponse,
  McpEndpointToggleRequest,
  McpEndpointToggleResponse,
} from "~/lib/config/settings-types"
import { forwardError, HTTPError } from "~/lib/errors/error"
import { reconfigureBroker } from "~/lib/mcp-broker/supervisor"
import { npmGlobalPrefix } from "~/lib/system/run-file"

import { respondValidated } from "./respond-validated"

function httpError(message: string, status: number): HTTPError {
  return new HTTPError(message, new Response(message, { status }))
}

export const mcpRoutes = new Hono()

const ADD_ERROR_STATUS = {
  exists: 409,
  "not-installed": 409,
  "unknown-catalog": 404,
} as const

// Each list re-scans, so the panel's "Check again" also finds a server that
// was just installed or upgraded.
mcpRoutes.get("/", async (c) => {
  try {
    // Catalog detection reads npm's prefix from a cache it never fills
    // itself; this fills it once, without blocking, and is instant after.
    await npmGlobalPrefix()
    const before = getConfig()
    const config = refreshCatalogCommands(before)
    if (config !== before) await reconfigureBroker(config.mcpBroker ?? {})
    return respondValidated(
      c,
      { schema: McpEndpointsListResponse, label: "MCP endpoints" },
      {
        endpoints: await listMcpEndpoints(config),
        broker: mcpBrokerHealth(),
        available: listMcpCatalog(config),
      },
    )
  } catch (error) {
    return forwardError(c, error)
  }
})

mcpRoutes.post("/", async (c) => {
  try {
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = McpEndpointAddRequest.safeParse(body)
    if (!parsed.success) throw httpError("Expected { catalogId: string }", 400)
    const { endpoint } = await addMcpEndpoint(
      catalogServer(parsed.data.catalogId),
    )
    return respondValidated(
      c,
      { schema: McpEndpointAddResponse, label: "MCP endpoint" },
      { endpoint },
    )
  } catch (error) {
    if (error instanceof McpEndpointError) {
      return forwardError(
        c,
        httpError(error.message, ADD_ERROR_STATUS[error.code]),
      )
    }
    return forwardError(c, error)
  }
})

mcpRoutes.delete("/:id", async (c) => {
  try {
    const result = await removeMcpEndpoint(c.req.param("id"))
    if (!result) throw httpError("MCP endpoint not found", 404)
    return respondValidated(
      c,
      { schema: McpEndpointRemoveResponse, label: "MCP endpoint" },
      { removedFrom: result.removedFrom },
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
