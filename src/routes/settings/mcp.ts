/**
 * /settings/api/mcp — turn brokered MCP endpoints on or off and choose which
 * client apps they reach.
 *
 * Auth-gated by the parent `/settings/api` middleware. Endpoints live in
 * `config.json`; this route lists them with the known servers found on this
 * machine, adds a found one, toggles, and removes. The work is in
 * `~/apps/mcp`, shared with the `maximal mcp` CLI. For Work IQ it also
 * reports where sign-in stands and runs the steps the user confirms
 * (`~/lib/mcp-broker/workiq`).
 */

import { type Context, Hono } from "hono"

import type { McpServerConfig } from "~/lib/config/config"

import {
  addMcpEndpoint,
  catalogServer,
  listMcpCatalog,
  listMcpEndpoints,
  mcpBrokerHealth,
  McpEndpointError,
  refreshCatalogCommands,
  removeMcpEndpoint,
  repairMcpClientKeys,
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
  WorkIqActionResponse,
  WorkIqSignInRequest,
} from "~/lib/config/settings-types"
import { forwardError, HTTPError } from "~/lib/errors/error"
import { reconfigureBroker } from "~/lib/mcp-broker/supervisor"
import {
  isWorkIqEndpoint,
  withWorkIqStatus,
  workIq,
} from "~/lib/mcp-broker/workiq"

import { respondValidated } from "./respond-validated"

function httpError(message: string, status: number): HTTPError {
  return new HTTPError(message, new Response(message, { status }))
}

export const mcpRoutes = new Hono()

const ENDPOINT_ERROR_STATUS = {
  exists: 409,
  "not-installed": 409,
  "unknown-catalog": 404,
  "unsupported-platform": 409,
} as const

// Each list re-scans, so the panel's "Check again" also finds a server that
// was just installed or upgraded. It also puts back any key a running Claude
// Code overwrote with the placeholder (a file check, no CLI).
mcpRoutes.get("/", async (c) => {
  try {
    const before = getConfig()
    const config = refreshCatalogCommands(before)
    if (config !== before) await reconfigureBroker(config.mcpBroker ?? {})
    repairMcpClientKeys(config)
    return respondValidated(
      c,
      { schema: McpEndpointsListResponse, label: "MCP endpoints" },
      {
        endpoints: await withWorkIqStatus(
          listMcpEndpoints(config),
          config.mcpBroker?.servers ?? [],
        ),
        broker: mcpBrokerHealth(),
        available: listMcpCatalog(config),
      },
    )
  } catch (error) {
    return forwardError(c, error)
  }
})

// ── Work IQ sign-in ─────────────────────────────────────────────────────
// Each step runs a Work IQ command only because the user asked for that
// step in Settings: accepting Microsoft's EULA, and signing in (optionally
// switching Work IQ to browser sign-in first).

/** The Work IQ endpoint `id`, or an HTTP error. */
function workIqServer(id: string): McpServerConfig {
  const server = getConfig().mcpBroker?.servers?.find((s) => s.id === id)
  if (!server) throw httpError("MCP endpoint not found", 404)
  if (!isWorkIqEndpoint(server)) {
    throw httpError("This MCP endpoint isn't Work IQ", 400)
  }
  return server
}

async function respondWithWorkIq(
  c: Context,
  server: McpServerConfig,
): Promise<Response> {
  return respondValidated(
    c,
    { schema: WorkIqActionResponse, label: "Work IQ status" },
    { workiq: await workIq.status(server) },
  )
}

mcpRoutes.get("/:id/workiq", async (c) => {
  try {
    return await respondWithWorkIq(c, workIqServer(c.req.param("id")))
  } catch (error) {
    return forwardError(c, error)
  }
})

mcpRoutes.post("/:id/workiq/accept-eula", async (c) => {
  try {
    const server = workIqServer(c.req.param("id"))
    const result = await workIq.acceptEula(server)
    if (!result.ok) {
      throw httpError(
        result.problem ?
          `Work IQ didn't record the EULA: ${result.problem}`
        : "Work IQ didn't record the EULA",
        502,
      )
    }
    return await respondWithWorkIq(c, server)
  } catch (error) {
    return forwardError(c, error)
  }
})

mcpRoutes.post("/:id/workiq/sign-in", async (c) => {
  try {
    const server = workIqServer(c.req.param("id"))
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = WorkIqSignInRequest.safeParse(body)
    if (!parsed.success) {
      throw httpError("Expected { useBrowserSignIn: boolean }", 400)
    }
    // Runs in the background; the status reports how it goes.
    workIq.startSignIn(server, parsed.data)
    return await respondWithWorkIq(c, server)
  } catch (error) {
    return forwardError(c, error)
  }
})

mcpRoutes.delete("/:id/workiq/sign-in", async (c) => {
  try {
    const server = workIqServer(c.req.param("id"))
    workIq.cancelSignIn(server.id)
    return await respondWithWorkIq(c, server)
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
        httpError(error.message, ENDPOINT_ERROR_STATUS[error.code]),
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
        unavailable: result.unavailable,
        updated: result.updated,
        broker: result.broker,
        ...(result.adoptedFrom === undefined ?
          {}
        : {
            adoptedFrom: result.adoptedFrom,
            droppedEnvironment: result.droppedEnvironment ?? [],
          }),
      },
    )
  } catch (error) {
    // Turning one on where the broker can't run (Windows).
    if (error instanceof McpEndpointError) {
      return forwardError(
        c,
        httpError(error.message, ENDPOINT_ERROR_STATUS[error.code]),
      )
    }
    return forwardError(c, error)
  }
})
