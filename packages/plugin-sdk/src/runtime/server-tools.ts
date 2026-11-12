import { Service, type Context } from "@deepseek-ai/cordis"

import type { ServerToolDefinition, ServerToolRegistry } from "../server-tools"
import type { PluginDisposer } from "../types"
import type { PluginServiceFactory } from "./services"
import type { PluginRuntime } from "./state"

import { PluginContractError } from "../errors"
import {
  DEFAULT_SERVER_TOOL_CLIENTS,
  SERVER_TOOL_NAME_PATTERN,
  SERVER_TOOL_OFFERS,
  SERVER_TOOL_RENDERS,
} from "../server-tools"

// See services.ts: internals live under module-private symbols because
// `#private` fields do not survive cordis' tracing proxy.
const kRuntime = Symbol("maximal.plugin.server-tools.runtime")

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Why `definition` cannot be a server tool, or `undefined` when it can. */
function definitionProblem(
  definition: Record<string, unknown>,
  where: string,
): string | undefined {
  const { description, input_schema, render, offer, clients, estimate } =
    definition
  if (typeof description !== "string" || description === "")
    return `${where} needs a description.`
  if (!isRecord(input_schema) || input_schema.type !== "object")
    return `${where} input_schema must be a JSON Schema with type "object".`
  if (!(SERVER_TOOL_RENDERS as ReadonlyArray<unknown>).includes(render))
    return `${where} render must be one of ${SERVER_TOOL_RENDERS.join(", ")}.`
  if (!(SERVER_TOOL_OFFERS as ReadonlyArray<unknown>).includes(offer))
    return `${where} offer must be one of ${SERVER_TOOL_OFFERS.join(", ")}.`
  if (offer === "when-client-declares" && render === "hidden")
    return `${where} cannot be offered "when-client-declares" and rendered "hidden": a client declares Anthropic's own server tools, which render as such.`
  if (clients !== undefined && !isClientList(clients))
    return `${where} clients must be a non-empty list of client names.`
  if (estimate !== undefined && typeof estimate !== "function")
    return `${where} estimate must be a function.`
  if (typeof definition.execute !== "function")
    return `${where} needs an execute function.`
  return undefined
}

function isClientList(value: unknown): value is Array<string> {
  return (
    Array.isArray(value)
    && value.length > 0
    && value.every((client) => typeof client === "string" && client !== "")
  )
}

/** Validate and copy a server tool definition (frozen; schema cloned). */
function normalizeServerToolDefinition(
  pluginId: string,
  definition: unknown,
): Readonly<ServerToolDefinition> {
  const invalid = (message: string, cause?: unknown): never => {
    throw new PluginContractError("invalid-server-tool", message, {
      pluginId,
      ...(cause === undefined ? {} : { cause }),
    })
  }
  if (!isRecord(definition)) {
    return invalid(
      `Plugin "${pluginId}" registered a server tool that is not an object.`,
    )
  }
  const name = definition.name
  if (typeof name !== "string" || !SERVER_TOOL_NAME_PATTERN.test(name)) {
    return invalid(
      `Plugin "${pluginId}" registered a server tool with invalid name ${JSON.stringify(name)}.`,
    )
  }
  const where = `Server tool "${pluginId}/${name}"`
  const problem = definitionProblem(definition, where)
  if (problem !== undefined) return invalid(problem)
  const source = definition as unknown as ServerToolDefinition
  let inputSchema: ServerToolDefinition["input_schema"]
  try {
    inputSchema = structuredClone(source.input_schema)
  } catch (cause) {
    return invalid(`${where} input_schema must be plain JSON.`, cause)
  }
  // Captured now so later mutation of `source` cannot swap the handler.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const execute = source.execute
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const estimate = source.estimate
  return Object.freeze({
    name,
    description: source.description,
    input_schema: inputSchema,
    render: source.render,
    offer: source.offer,
    clients: Object.freeze([
      ...(source.clients ?? DEFAULT_SERVER_TOOL_CLIENTS),
    ]),
    ...(estimate === undefined ?
      {}
    : {
        estimate: (input: Record<string, unknown>) =>
          estimate.call(source, input),
      }),
    execute: (
      input: Record<string, unknown>,
      call: Parameters<ServerToolDefinition["execute"]>[1],
    ) => execute.call(source, input, call),
  })
}

class ServerToolsService extends Service implements ServerToolRegistry {
  declare [kRuntime]: PluginRuntime

  constructor(ctx: Context, runtime: PluginRuntime) {
    super(ctx, "serverTools")
    this[kRuntime] = runtime
  }

  register(definition: ServerToolDefinition): PluginDisposer {
    const runtime = this[kRuntime]
    const slot = runtime.slotOf(this.ctx, "serverTools")
    const tool = normalizeServerToolDefinition(slot.id, definition)
    return runtime.bind(
      slot,
      this.ctx,
      `serverTools.register(${tool.name})`,
      (registration) => {
        runtime.addServerTool(slot, tool, registration)
      },
    ).dispose
  }
}

/**
 * The `serverTools` service (`ctx.serverTools`): pass it in
 * `PluginHostOptions.services.extra`. Without it no plugin can inject
 * `serverTools`, and the gateway lists no server tools.
 */
export const serverToolsService: PluginServiceFactory = (root, runtime) =>
  new ServerToolsService(root, runtime)
