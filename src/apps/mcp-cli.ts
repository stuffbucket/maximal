/**
 * `maximal mcp` — manage brokered MCP endpoints from the terminal.
 *
 *   maximal mcp                                   # endpoints + servers to add
 *   maximal mcp <id> --enable [--clients a,b]     # on; prompt for clients
 *   maximal mcp <id> --disable                    # off; reverts every client
 *   maximal mcp workiq --add                      # add a known server found here
 *   maximal mcp <id> --add -- /abs/cmd [args…]    # add any stdio server
 *   maximal mcp <id> --remove                     # remove from Maximal + apps
 *
 * Without `--clients`, an interactive terminal is asked which clients should
 * get the endpoint, pre-checked from the last choice; otherwise the last
 * choice is kept. Adding and removing ask to confirm unless `--unattended`.
 * Same work as the Settings panel (`~/apps/mcp`).
 */

import { defineCommand } from "citty"
import consola from "consola"
import path from "node:path"

import type { McpServerConfig } from "~/lib/config/config"
import type { McpClientId } from "~/lib/mcp-broker/types"

import { getConfig } from "~/lib/config/config"
import { McpServerIdSchema } from "~/lib/config/config-schema"
import { MCP_CATALOG } from "~/lib/mcp-broker/catalog"
import { brokerRunsOn } from "~/lib/mcp-broker/platform"
import { currentProxyPort } from "~/lib/start/proxy-port"

import {
  addMcpEndpoint,
  catalogServer,
  listMcpCatalog,
  listMcpEndpoints,
  refreshCatalogCommands,
  removeMcpEndpoint,
  setMcpEndpoint,
  type McpCatalogView,
  type McpEndpointView,
  type SetMcpEndpointResult,
} from "./mcp"

const CLIENT_IDS = new Set<string>(["claude-code", "claude-desktop"])

function showEndpoints(endpoints: Array<McpEndpointView>): void {
  if (endpoints.length === 0) {
    consola.info("No MCP endpoints yet.")
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

function showCatalog(available: Array<McpCatalogView>): void {
  if (available.length === 0) return
  consola.info("Available to add:")
  for (const item of available) {
    if (item.status === "ready") {
      consola.info(
        `  ${item.label} (${item.id}): found at ${item.command}`
          + ` — add with \`maximal mcp ${item.id} --add\``,
      )
    } else {
      consola.info(
        `  ${item.label} (${item.id}): not installed — ${item.install.command}`
          + ` (downloads from ${item.install.registry})`,
      )
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
  for (const missing of result.unavailable) {
    consola.warn(
      `Couldn't add ${endpoint.label} to ${missing.name}: maximal-mcp-broker wasn't found. Reinstalling Maximal fixes this.`,
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

  if (!result.brokerReloaded) await applyToRunning(port)
}

/** Apply a change made here to the Maximal running on `port`, which keeps
 *  its own copy of config.json. */
async function applyToRunning(port: number): Promise<void> {
  const reload = await reloadRunningMaximal(port)
  if (reload === "reloaded") {
    consola.info("The running Maximal picked up the change.")
  } else if (reload === "failed") {
    consola.warn(
      "Couldn't reach the running Maximal to apply the change; restart it to apply.",
    )
  }
}

/** True to go ahead. `--unattended` and non-interactive runs don't ask. */
async function confirm(
  question: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  if (args.unattended === true || !process.stdin.isTTY) return true
  const answer = await consola.prompt(question, {
    type: "confirm",
    initial: true,
    cancel: "null",
  })
  return answer === true
}

/** The command after `--`, for adding a server that isn't in the catalog. */
function commandAfterSeparator(rawArgs: Array<string>): Array<string> {
  const at = rawArgs.indexOf("--")
  return at === -1 ? [] : rawArgs.slice(at + 1)
}

function serverToAdd(
  id: string,
  args: Record<string, unknown>,
  rawArgs: Array<string>,
): McpServerConfig {
  const given = commandAfterSeparator(rawArgs)
  if (given.length === 0) {
    if (MCP_CATALOG.some((entry) => entry.id === id)) return catalogServer(id)
    const known = MCP_CATALOG.map((entry) => entry.id).join(", ")
    throw new Error(
      `"${id}" isn't a known MCP server (${known}). To add another one, give`
        + ` its command: maximal mcp ${id} --add -- /path/to/server [args…]`,
    )
  }
  const [command, ...commandArgs] = given
  if (!McpServerIdSchema.safeParse(id).success) {
    throw new Error(
      `Invalid endpoint id "${id}": use lowercase letters and digits, separated by ".", "_" or "-".`,
    )
  }
  // Maximal runs servers without your shell's PATH, so a bare name may not
  // be found there.
  if (!path.isAbsolute(command)) {
    throw new Error(
      `Give the full path to "${command}" (for example, the output of \`which ${command}\`).`,
    )
  }
  const label = typeof args.label === "string" && args.label ? args.label : id
  return {
    id,
    label,
    transport: { type: "stdio", command, args: commandArgs },
  }
}

async function add(
  id: string,
  args: Record<string, unknown>,
  rawArgs: Array<string>,
): Promise<void> {
  const server = serverToAdd(id, args, rawArgs)
  const commandLine = [
    server.transport.command,
    ...(server.transport.args ?? []),
  ].join(" ")
  consola.info(`${server.label} runs: ${commandLine}`)
  if (!(await confirm(`Add ${server.label} to Maximal?`, args))) {
    consola.info("Not added.")
    return
  }
  const result = await addMcpEndpoint(server)
  consola.success(
    `Added ${server.label}. Turn it on with \`maximal mcp ${id} --enable\`.`,
  )
  if (!result.brokerReloaded) await applyToRunning(parsePort(args.port))
}

async function remove(
  endpoint: McpEndpointView,
  args: Record<string, unknown>,
): Promise<void> {
  const apps = endpoint.offered.filter((client) => client.configured)
  const from =
    apps.length > 0 ?
      ` and from ${apps.map((client) => client.name).join(" and ")}`
    : ""
  if (!(await confirm(`Remove ${endpoint.label} from Maximal${from}?`, args))) {
    consola.info("Not removed.")
    return
  }
  const result = await removeMcpEndpoint(endpoint.id)
  if (!result) throw new Error(`No MCP endpoint "${endpoint.id}"`)
  consola.success(`Removed ${endpoint.label}.`)
  for (const client of result.removedFrom) {
    consola.info(`  removed from ${client.name}`)
  }
  if (!result.brokerReloaded) await applyToRunning(parsePort(args.port))
}

export const mcpCommand = defineCommand({
  meta: {
    name: "mcp",
    description:
      "Add, remove, and turn on or off brokered MCP endpoints, and choose which client apps get them.",
  },
  args: {
    endpoint: {
      type: "positional",
      required: false,
      description:
        "Endpoint id from mcpBroker.servers in config.json, or a known server to add.",
    },
    add: {
      type: "boolean",
      default: false,
      description:
        "Add a known server found on this machine, or any stdio server given after `--`.",
    },
    remove: {
      type: "boolean",
      default: false,
      description: "Remove the endpoint from Maximal and every client app.",
    },
    label: {
      type: "string",
      description: "Display name for a server added with `--add -- <command>`.",
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
      description:
        "No prompts: keep the last client choice, add and remove without asking.",
    },
    port: {
      type: "string",
      description:
        "Port of the running Maximal to apply the change to (default: the one running, else 4141).",
    },
  },
  async run({ args, rawArgs }) {
    const actions = [args.enable, args.disable, args.add, args.remove]
    if (actions.filter(Boolean).length > 1) {
      throw new Error("Use only one of --enable, --disable, --add, --remove.")
    }
    // Same upgrade check as boot and Settings; the running Maximal reloads.
    const current = getConfig()
    if (refreshCatalogCommands(current) !== current) {
      await applyToRunning(parsePort(args.port))
    }
    const endpoints = listMcpEndpoints()
    if (!args.endpoint) {
      if (!brokerRunsOn()) {
        consola.warn(
          "MCP servers don't run on Windows yet. Your endpoints and choices are kept for when they do.",
        )
      }
      showEndpoints(endpoints)
      showCatalog(listMcpCatalog())
      return
    }
    if (args.add) {
      await add(args.endpoint, args, rawArgs)
      return
    }
    const endpoint = endpoints.find((view) => view.id === args.endpoint)
    if (!endpoint) {
      consola.error(`No MCP endpoint "${args.endpoint}".`)
      showEndpoints(endpoints)
      showCatalog(listMcpCatalog())
      process.exitCode = 1
      return
    }
    if (args.remove) {
      await remove(endpoint, args)
      return
    }
    if (!args.enable && !args.disable) {
      showEndpoints([endpoint])
      return
    }
    await toggle(endpoint, args)
  },
})
