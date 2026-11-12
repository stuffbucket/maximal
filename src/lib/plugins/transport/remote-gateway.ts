/* eslint-disable max-params -- PluginGateway method arity is fixed by the SDK contract */
import type {
  ModelBinding,
  ModelOperation,
  OperationDispatch,
  PluginGateway,
  PluginGatewayEvent,
  PluginGenerationLease,
  PluginSettings,
  PluginSnapshot,
  PluginToolListing,
  PluginToolView,
  PreparedOperation,
  PreparedServerTool,
  ServerToolCall,
  ServerToolSpend,
  ServerToolView,
  ToolCallContext,
  ToolPermission,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import {
  WireRemoteError,
  type JsonValue,
} from "@stuffbucket/maximal-plugin-protocol"
import {
  OperationUnavailableError,
  PluginGatewayError,
} from "@stuffbucket/maximal-plugin-sdk/gateway"
import { randomUUID } from "node:crypto"

import type { DuplexRpcDispatcher } from "~/lib/plugins/transport/dispatcher"
import type { GatewayProjectionDto } from "~/lib/plugins/transport/gateway-codec"

import {
  encodeBody,
  exact,
  GATEWAY_RPC,
  json,
  parseBooleanResult,
  parseGatewayEvent,
  parseNull,
  parseOperationResult,
  parsePreparedServerTool,
  parseProjection,
  parseToolResult,
  record,
  stringValue,
} from "~/lib/plugins/transport/gateway-codec"

const MAX_PROVIDER_CALLS_PER_INVOCATION = 64
const clone = <T>(value: T): T => structuredClone(value)
const operationKey = (operation: ModelOperation, model: string): string =>
  JSON.stringify([operation, model])

function gatewayError(error: unknown): Error {
  if (!(error instanceof WireRemoteError))
    return error instanceof Error ? error : new Error(String(error))
  const { wire } = error
  if (wire.kind === "plugin-gateway" && wire.pluginId) {
    return new PluginGatewayError(
      wire.code as ConstructorParameters<typeof PluginGatewayError>[0],
      wire.pluginId,
      wire.message,
      wire.issues === undefined ? undefined : { issues: wire.issues },
    )
  }
  if (wire.kind === "operation-unavailable" && wire.operation && wire.model)
    return new OperationUnavailableError(wire.operation, wire.model)
  return error
}

function projectedList<T>(
  values: Readonly<Partial<Record<string, ReadonlyArray<T>>>>,
  pluginId: string,
): Array<T> {
  const found = values[pluginId]
  if (found) return found.map((value) => clone(value))
  throw new PluginGatewayError(
    "unknown-plugin",
    pluginId,
    `Unknown plugin "${pluginId}".`,
  )
}

/** Cordis-free parent facade over one authenticated runner generation. */
export class TransportPluginGateway implements PluginGateway {
  #dispatcher: DuplexRpcDispatcher
  readonly #generationId: string
  readonly #listeners = new Set<(event: PluginGatewayEvent) => void>()
  readonly #spend = new Map<
    string,
    NonNullable<ServerToolCall["reportSpend"]>
  >()
  readonly #operations: OperationDispatch
  readonly #onDispose: (() => Promise<void>) | undefined
  #projection: GatewayProjectionDto
  #disposed = false
  #refresh = Promise.resolve()

  constructor(
    dispatcher: DuplexRpcDispatcher,
    generationId: string,
    projection: GatewayProjectionDto,
    onDispose?: () => Promise<void>,
  ) {
    this.#dispatcher = dispatcher
    this.#generationId = generationId
    this.#projection = clone(projection)
    this.#onDispose = onDispose
    this.#operations = this.#operationView()
  }

  handleStateEvent(value: JsonValue): void {
    let event: PluginGatewayEvent
    try {
      event = parseGatewayEvent(value)
    } catch {
      return
    }
    this.#refresh = this.#refresh
      .then(async () => {
        await this.refresh()
        for (const listener of this.#listeners) listener(clone(event))
      })
      .catch(() => undefined)
  }

  handleSpend(
    invocationId: string,
    providerCallId: string,
    evidence?: JsonValue,
  ): void {
    if (evidence === undefined)
      throw new Error("Server tool spend has no evidence.")
    const input = exact(evidence, "Server tool spend", [
      "invocationId",
      "providerCallId",
      "sequence",
      "operation",
      "model",
      "provider",
      "result",
    ])
    if (stringValue(input.invocationId, "Spend invocation id") !== invocationId)
      throw new Error("Server tool spend invocation identity changed.")
    if (
      stringValue(input.providerCallId, "Spend provider call id")
      !== providerCallId
    )
      throw new Error("Server tool spend provider-call identity changed.")
    const report = this.#spend.get(invocationId)
    if (!report) throw new Error("Server tool spend has no active invocation.")
    const spend = clone(input) as unknown as ServerToolSpend
    report(spend)
  }

  /**
   * Point this facade at a restarted runner process of the same generation.
   * Calls already in flight on the dead process have failed; new calls use the
   * replacement and its fresh snapshot.
   */
  rebind(
    dispatcher: DuplexRpcDispatcher,
    projection: GatewayProjectionDto,
  ): void {
    if (this.#disposed) return
    this.#dispatcher = dispatcher
    this.#projection = clone(projection)
  }

  /** Deliver a synthetic event (for example after a runner restart). */
  announce(event: PluginGatewayEvent): void {
    for (const listener of this.#listeners) listener(clone(event))
  }

  /** The current parent-side projection as the wire snapshot value. */
  projectionJson(): JsonValue {
    return json(this.#projection, "Gateway projection")
  }

  async refresh(): Promise<void> {
    const value = await this.#call(GATEWAY_RPC.snapshot, {})
    this.#projection = parseProjection(value)
  }

  acquireGeneration(): PluginGenerationLease {
    let released = false
    const live = (): void => {
      if (released) throw new Error("Plugin generation lease was released.")
    }
    const projection = clone(this.#projection)
    return {
      generationId: this.#generationId,
      get: (id) => {
        live()
        const found = projection.plugins.find((plugin) => plugin.id === id)
        return found === undefined ? undefined : clone(found)
      },
      listTools: (pluginId) => {
        live()
        return projectedList(projection.listings, pluginId)
      },
      toolViews: (pluginId) => {
        live()
        return projectedList(projection.toolViews, pluginId)
      },
      serverTools: () => {
        live()
        return projection.serverTools.map((value) => clone(value))
      },
      operations: () => this.#operationView(projection, live),
      callTool: async (pluginId, name, input, call) => {
        live()
        return await this.#callTool(pluginId, name, input, call)
      },
      prepareServerTool: async (pluginId, name, input) => {
        live()
        return await this.#prepareServerTool(pluginId, name, input)
      },
      release: () => {
        released = true
      },
    }
  }

  async reconcile(settings: PluginSettings | undefined): Promise<void> {
    await this.#call(GATEWAY_RPC.reconcile, {
      settings: json(settings ?? null, "Plugin settings"),
    })
    await this.refresh()
  }

  list(): Array<PluginSnapshot> {
    return this.#projection.plugins.map((value) => clone(value))
  }

  get(id: string): PluginSnapshot | undefined {
    const found = this.#projection.plugins.find((plugin) => plugin.id === id)
    return found === undefined ? undefined : clone(found)
  }

  listTools(pluginId: string): Array<PluginToolListing> {
    return projectedList(this.#projection.listings, pluginId)
  }

  toolViews(pluginId: string): Array<PluginToolView> {
    return projectedList(this.#projection.toolViews, pluginId)
  }

  async callTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    return await this.#callTool(pluginId, name, input, call)
  }

  operations(): OperationDispatch {
    return this.#operations
  }

  serverTools(): Array<ServerToolView> {
    return this.#projection.serverTools.map((value) => clone(value))
  }

  async prepareServerTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<PreparedServerTool> {
    return await this.#prepareServerTool(pluginId, name, input)
  }

  async callServerTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
    call: ServerToolCall,
  ): Promise<ToolResult> {
    const prepared = await this.prepareServerTool(pluginId, name, input)
    return await prepared.execute(call)
  }

  async runAction(
    pluginId: string,
    actionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    parseNull(
      await this.#call(
        GATEWAY_RPC.runAction,
        { pluginId, actionId },
        { signal },
      ),
      "Run action",
    )
    await this.refresh()
  }

  async updateConfig(pluginId: string, config: unknown): Promise<void> {
    parseNull(
      await this.#call(GATEWAY_RPC.updateConfig, {
        pluginId,
        config: json(config, "Plugin config"),
      }),
      "Update config",
    )
    await this.refresh()
  }

  async setToolPermissions(
    pluginId: string,
    changes: Record<string, ToolPermission | null>,
  ): Promise<void> {
    parseNull(
      await this.#call(GATEWAY_RPC.setToolPermissions, {
        pluginId,
        changes: json(changes, "Tool permission changes"),
      }),
      "Set tool permissions",
    )
    await this.refresh()
  }

  async importLegacyConfig(
    pluginId: string,
    config: unknown,
  ): Promise<boolean> {
    const result = parseBooleanResult(
      await this.#call(GATEWAY_RPC.importLegacyConfig, {
        pluginId,
        config: json(config, "Legacy plugin config"),
      }),
      "Import legacy config",
    )
    await this.refresh()
    return result
  }

  subscribe(listener: (event: PluginGatewayEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    this.#spend.clear()
    await this.#onDispose?.()
  }

  async #callTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    const elicit = call.elicit?.bind(call)
    const progress = call.progress?.bind(call)
    const value = await this.#call(
      GATEWAY_RPC.callTool,
      {
        pluginId,
        name,
        input: json(input, "Tool input"),
        ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
        ...(call.approved === undefined ? {} : { approved: call.approved }),
        canElicit: elicit !== undefined,
      },
      {
        signal: call.signal,
        onProgress:
          progress === undefined ? undefined : (event) => progress(event),
        onElicit:
          elicit === undefined ? undefined : (
            async (message, requestedSchema) => {
              const schema = record(requestedSchema, "Elicitation schema")
              if (schema.type !== "object")
                throw new Error("Elicitation schema must describe an object.")
              const result = await elicit({
                message,
                requestedSchema: structuredClone(
                  schema,
                ) as unknown as import("@stuffbucket/maximal-plugin-sdk/gateway").JsonSchemaObject,
              })
              return {
                action: result.action,
                ...(result.content === undefined ?
                  {}
                : {
                    content: json(result.content, "Elicitation reply"),
                  }),
              }
            }
          ),
      },
    )
    return parseToolResult(value)
  }

  /**
   * A lease passes its own frozen projection; the facade's own view follows
   * the current one, so it stays correct across refreshes and rebinds.
   */
  #operationView(
    pinned?: GatewayProjectionDto,
    live: () => void = () => undefined,
  ): OperationDispatch {
    const current = (): GatewayProjectionDto => pinned ?? this.#projection
    const resolve = (
      operation: ModelOperation,
      model: string,
    ): { pluginId: string; binding: ModelBinding } | undefined => {
      live()
      const target = current().operationTargets.find(
        (candidate) =>
          operationKey(candidate.operation, candidate.model)
          === operationKey(operation, model),
      )
      return target === undefined ? undefined : clone(target)
    }
    const prepare = (
      operation: ModelOperation,
      model: string,
    ): PreparedOperation | undefined => {
      const target = resolve(operation, model)
      if (!target) return undefined
      const operationRevision = current().operationRevision
      let released = false
      return {
        operation,
        model,
        pluginId: target.pluginId,
        binding: clone(target.binding),
        execute: async (request) => {
          if (released) throw new Error("Prepared operation was released.")
          const body = await encodeBody(request.body)
          const result = parseOperationResult(
            await this.#call(
              GATEWAY_RPC.executeOperation,
              json(
                {
                  operationRevision,
                  operation,
                  model,
                  pluginId: target.pluginId,
                  binding: target.binding,
                  body,
                  invocationId: request.invocationId,
                  providerCallId: request.providerCallId,
                  sequence: request.sequence,
                  origin: request.origin,
                },
                "Operation execution",
              ),
              { signal: request.signal },
            ),
          )
          return result
        },
        release: () => {
          released = true
        },
      }
    }
    return {
      resolve,
      prepare,
      dispatch: async (request) => {
        const prepared = prepare(request.operation, request.model)
        if (!prepared)
          throw new OperationUnavailableError(request.operation, request.model)
        try {
          return await prepared.execute(request)
        } finally {
          prepared.release()
        }
      },
      servedModels: () => current().servedModels.map((value) => clone(value)),
      subscribe: (listener) =>
        this.subscribe((event) => {
          if (event.type === "lifecycle" || event.type === "inventory")
            listener()
        }),
    }
  }

  async #prepareServerTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<PreparedServerTool> {
    const prepared = parsePreparedServerTool(
      await this.#call(GATEWAY_RPC.prepareServerTool, {
        pluginId,
        name,
        input: json(input, "Server tool input"),
      }),
    )
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      void this.#call(GATEWAY_RPC.releaseServerTool, {
        preparedId: prepared.preparedId,
      }).catch(() => undefined)
    }
    return {
      pluginId: prepared.pluginId,
      name: prepared.name,
      estimate:
        prepared.estimate === undefined ?
          undefined
        : {
            operation: prepared.estimate.operation,
            ...(prepared.estimate.provider === undefined ?
              {}
            : { provider: prepared.estimate.provider }),
            body: decodePreparedBody(prepared.estimate.body),
          },
      execute: async (call) => {
        if (released)
          throw new Error("Prepared server tool was already consumed.")
        released = true
        if (call.reportSpend)
          this.#spend.set(call.invocationId, call.reportSpend)
        try {
          const result = await this.#call(
            GATEWAY_RPC.executeServerTool,
            {
              preparedId: prepared.preparedId,
              call: json(
                {
                  invocationId: call.invocationId,
                  sessionId: call.sessionId,
                  model: call.model,
                  client: call.client,
                  budget: call.budget,
                  providerCallIds: Array.from(
                    { length: MAX_PROVIDER_CALLS_PER_INVOCATION },
                    () => randomUUID(),
                  ),
                },
                "Server tool call",
              ),
            },
            { signal: call.signal },
          )
          return parseToolResult(result)
        } finally {
          this.#spend.delete(call.invocationId)
        }
      },
      release,
    }
  }

  async #call(
    method: string,
    params: JsonValue | Record<string, JsonValue>,
    options: Parameters<DuplexRpcDispatcher["call"]>[2] = {},
  ): Promise<JsonValue> {
    if (this.#disposed) throw new Error("Remote plugin gateway is disposed.")
    try {
      return await this.#dispatcher.call(
        method,
        json(params, `${method} request`),
        options,
      )
    } catch (error) {
      throw gatewayError(error)
    }
  }
}

function decodePreparedBody(
  body: import("~/lib/plugins/transport/gateway-codec").BodyDto,
): Record<string, unknown> | FormData {
  if (body.kind === "json") return clone(body.value)
  const form = new FormData()
  for (const part of body.parts) {
    if (part.kind === "text") form.append(part.name, part.value)
    else {
      const bytes = Uint8Array.from(Buffer.from(part.bytesBase64, "base64"))
      const blob = new Blob([bytes], { type: part.mediaType })
      if (part.filename === undefined) form.append(part.name, blob)
      else form.append(part.name, blob, part.filename)
    }
  }
  return form
}

export function projectionFromJson(value: JsonValue): GatewayProjectionDto {
  return parseProjection(value)
}
