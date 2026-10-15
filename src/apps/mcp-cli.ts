/**
 * `maximal mcp` — turn brokered MCP endpoints on or off from the terminal.
 *
 *   maximal mcp                                   # list endpoints and clients
 *   maximal mcp <id> --enable [--clients a,b]     # on; prompt for clients
 *   maximal mcp <id> --disable                    # off; reverts every client
 *
 * Without `--clients`, an interactive terminal is asked which clients should
 * get the endpoint, pre-checked from the last choice; otherwise the last
 * choice is kept. Same work as the Settings toggle (`~/apps/mcp`).
 */

import { defineCommand } from "citty"
import consola from "consola"

import type { McpClientId } from "~/lib/mcp-broker/types"

import { currentProxyPort } from "~/lib/start/proxy-port"

import {
  listMcpEndpoints,
  setMcpEndpoint,
  type McpEndpointView,
  type SetMcpEndpointResult,
} from "./mcp"

const CLIENT_IDS = new Set<string>(["claude-code", "claude-desktop"])

function showEndpoints(endpoints: Array<McpEndpointView>): void {
  if (endpoints.length === 0) {
    consola.info(
      "No MCP endpoints are configured under mcpBroker in config.json.",
    )
    return
  }
  for (const endpoint of endpoints) {
    consola.info(
      `${endpoint.label} (${endpoint.id}): ${endpoint.enabled ? "on" : "off"}`,
    )
    for (const client of endpoint.offered) {
      const note = client.available ? "" : " (integration off)"
      consola.info(`  ${client.name}: ${clientState(endpoint, client)}${note}`)
    }
  }
}

function clientState(
  endpoint: McpEndpointView,
  client: McpEndpointView["offered"][number],
): string {
  if (client.configured) return "added"
  return endpoint.clients.includes(client.id) ? "chosen" : "not chosen"
}

function parseClients(value: unknown): Array<McpClientId> | undefined {
  if (typeof value !== "string") return undefined
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  const unknown = ids.filter((id) => !CLIENT_IDS.has(id))
  if (unknown.length > 0) {
    throw new Error(
      `Unknown client(s): ${unknown.join(", ")}. Use claude-code, claude-desktop.`,
    )
  }
  return ids as Array<McpClientId>
}

/** Ask which available clients get the endpoint. Undefined keeps the last
 *  choice (non-interactive or cancelled). */
export async function promptClients(
  endpoint: McpEndpointView,
): Promise<Array<McpClientId> | undefined> {
  const offered = endpoint.offered.filter((client) => client.available)
  if (offered.length === 0) {
    consola.info(
      "No client integration is on; turn on Claude Code or Claude Desktop in"
        + " `maximal app` to add this endpoint to it.",
    )
    return undefined
  }
  const answer = await consola.prompt(
    `Also add ${endpoint.label} to these clients?`,
    {
      type: "multiselect",
      required: false,
      cancel: "null",
      options: offered.map((client) => ({
        label: client.name,
        value: client.id,
      })),
      initial: endpoint.clients.filter((id) =>
        offered.some((client) => client.id === id),
      ),
    },
  )
  if (answer === null) return undefined
  const chosen = new Set(
    answer.map((option) =>
      typeof option === "string" ? option : option.value,
    ),
  )
  // Keep remembered choices for clients that can't be offered right now.
  const unavailable = endpoint.clients.filter(
    (id) => !offered.some((client) => client.id === id),
  )
  return [
    ...unavailable,
    ...offered.flatMap((c) => (chosen.has(c.id) ? [c.id] : [])),
  ]
}

/** Ask a running Maximal to re-read config.json and restart its broker.
 *  "not-running" when nothing answers on the port. */
async function reloadRunningMaximal(
  port: number,
): Promise<"reloaded" | "failed" | "not-running"> {
  const base = `http://127.0.0.1:${port}`
  try {
    await fetch(`${base}/status`, { signal: AbortSignal.timeout(1000) })
  } catch {
    return "not-running"
  }
  try {
    const response = await fetch(`${base}/_internal/reload`, {
      method: "POST",
      // Covers stopping the old broker and starting the new one.
      signal: AbortSignal.timeout(15_000),
    })
    return response.ok ? "reloaded" : "failed"
  } catch {
    return "failed"
  }
}

function parsePort(value: unknown): number {
  if (value === undefined || value === "") return currentProxyPort()
  const port = typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid --port: ${JSON.stringify(value)}`)
  }
  return port
}

function report(
  endpoint: McpEndpointView,
  enabled: boolean,
  result: SetMcpEndpointResult,
): void {
  consola.success(`${endpoint.label} is ${enabled ? "on" : "off"}.`)
  if (result.adoptedFrom) {
    consola.info(
      `Using the ${endpoint.label} setup already in ${result.adoptedFrom}.`,
    )
  }
  if (result.droppedEnvironment && result.droppedEnvironment.length > 0) {
    consola.warn(
      `Not copied (look like secrets): ${result.droppedEnvironment.join(", ")}`,
    )
  }
  for (const skip of result.skipped) {
    consola.warn(
      `${skip.name} already has an MCP server named "${endpoint.id}"; left unchanged.`,
    )
  }
  showEndpoints([result.endpoint])
}

async function toggle(
  endpoint: McpEndpointView,
  args: Record<string, unknown>,
): Promise<void> {
  const port = parsePort(args.port)
  const enabled = args.disable !== true
  let clients = parseClients(args.clients)
  const canPrompt = args.unattended !== true && process.stdin.isTTY
  if (enabled && clients === undefined && canPrompt) {
    clients = await promptClients(endpoint)
  }

  const result = await setMcpEndpoint(endpoint.id, {
    enabled,
    ...(clients === undefined ? {} : { clients }),
  })
  if (!result) throw new Error(`No MCP endpoint "${endpoint.id}"`)
  report(endpoint, enabled, result)

  if (result.brokerReloaded) return
  const reload = await reloadRunningMaximal(port)
  if (reload === "reloaded") {
    consola.info("The running Maximal picked up the change.")
  } else if (reload === "failed") {
    consola.warn(
      "Couldn't reach the running Maximal to apply the change; restart it to apply.",
    )
  }
}

export const mcpCommand = defineCommand({
  meta: {
    name: "mcp",
    description:
      "Turn brokered MCP endpoints on or off and choose which client apps get them.",
  },
  args: {
    endpoint: {
      type: "positional",
      required: false,
      description: "Endpoint id from mcpBroker.servers in config.json.",
    },
    enable: {
      type: "boolean",
      default: false,
      description: "Turn the endpoint on and add it to the chosen clients.",
    },
    disable: {
      type: "boolean",
      default: false,
      description: "Turn the endpoint off and remove it from every client.",
    },
    clients: {
      type: "string",
      description:
        "Comma-separated clients for --enable: claude-code, claude-desktop. Skips the prompt.",
    },
    unattended: {
      type: "boolean",
      default: false,
      description: "No prompt; keep the last client choice.",
    },
    port: {
      type: "string",
      description:
        "Port of the running Maximal to apply the change to (default: the one running, else 4141).",
    },
  },
  async run({ args }) {
    const endpoints = listMcpEndpoints()
    if (!args.endpoint) {
      showEndpoints(endpoints)
      return
    }
    const endpoint = endpoints.find((view) => view.id === args.endpoint)
    if (!endpoint) {
      consola.error(`No MCP endpoint "${args.endpoint}".`)
      showEndpoints(endpoints)
      process.exitCode = 1
      return
    }
    if (!args.enable && !args.disable) {
      showEndpoints([endpoint])
      return
    }
    await toggle(endpoint, args)
  },
})
