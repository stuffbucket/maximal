import type { JsonValue } from "@stuffbucket/maximal-plugin-protocol"
import type {
  HostServices,
  ProviderCost,
  ProviderInvocation,
  ProviderModelInfo,
  ProviderQuotaWindow,
  PluginGenerationResourceLifecycle,
  ProviderRequestOptions,
  ServerToolCall,
  UpstreamProvider,
} from "@stuffbucket/maximal-plugin-sdk"
import type {
  PluginGateway,
  PreparedServerTool,
} from "@stuffbucket/maximal-plugin-sdk/gateway"
import type {
  PluginSettingsAuthority,
  PluginSettingsTransaction,
} from "@stuffbucket/maximal-plugin-sdk/runtime"

import { releaseUpstreamSession } from "@stuffbucket/maximal-connector-kit"
import { WireRemoteError } from "@stuffbucket/maximal-plugin-protocol"
import {
  isOperationUnavailableError,
  isPluginGatewayError,
  OperationUnavailableError,
} from "@stuffbucket/maximal-plugin-sdk/gateway"
import { randomUUID } from "node:crypto"

import type {
  DuplexRpcDispatcher,
  RpcContext,
} from "~/lib/plugins/transport/dispatcher"
import type {
  GatewayProjectionDto,
  OperationExecutionDto,
  ServerToolCallDto,
} from "~/lib/plugins/transport/gateway-codec"
import type { BunIpcTransport } from "~/lib/plugins/transport/ipc"

import {
  decodeBody,
  encodeBody,
  encodeEstimate,
  exact,
  GATEWAY_RPC,
  HOST_RPC,
  integerValue,
  json,
  optionalString,
  parseOperationResult,
  parsePermissionChanges,
  parsePluginSettings,
  parseProviderReply,
  PROVIDER_RPC,
  record,
  SETTINGS_RPC,
  spendEvidence,
  stringValue,
} from "~/lib/plugins/transport/gateway-codec"

interface ReverseServices {
  readonly settingsAuthority: PluginSettingsAuthority
  readonly provider: UpstreamProvider
  readonly host: HostServices
  flush(): Promise<void>
  dispose(): void
}

function authorityCall(
  dispatcher: DuplexRpcDispatcher,
  method: string,
  params: unknown,
): Promise<JsonValue> {
  return dispatcher.callHost(method, json(params, `${method} request`))
}

function createSettingsAuthority(
  dispatcher: DuplexRpcDispatcher,
  pending: Set<Promise<unknown>>,
): PluginSettingsAuthority {
  const transaction = (): PluginSettingsTransaction => {
    const transactionId = randomUUID()
    let closed = false
    const ensureOpen = (): void => {
      if (closed) throw new Error("Plugin settings transaction is closed.")
    }
    const tx: PluginSettingsTransaction = {
      async snapshot(pluginId) {
        ensureOpen()
        return structuredClone(
          await authorityCall(dispatcher, SETTINGS_RPC.transactionSnapshot, {
            transactionId,
            pluginId,
          }),
        ) as unknown as Awaited<ReturnType<PluginSettingsAuthority["snapshot"]>>
      },
      async commit(proposal) {
        ensureOpen()
        return structuredClone(
          await authorityCall(dispatcher, SETTINGS_RPC.transactionCommit, {
            transactionId,
            proposal,
          }),
        ) as unknown as Awaited<ReturnType<PluginSettingsAuthority["commit"]>>
      },
      async epoch() {
        ensureOpen()
        return integerValue(
          await authorityCall(dispatcher, SETTINGS_RPC.transactionEpoch, {
            transactionId,
          }),
          "Transaction epoch",
        )
      },
      beginTransaction() {
        throw new Error(
          "Nested plugin settings transactions are not supported.",
        )
      },
      async finish() {
        ensureOpen()
        closed = true
        const value = await authorityCall(
          dispatcher,
          SETTINGS_RPC.transactionFinish,
          {
            transactionId,
          },
        )
        if (!Array.isArray(value))
          throw new Error("Transaction commits must be an array.")
        return structuredClone(value) as unknown as Awaited<
          ReturnType<PluginSettingsTransaction["finish"]>
        >
      },
      rollback() {
        if (closed) return
        closed = true
        const operation = authorityCall(
          dispatcher,
          SETTINGS_RPC.transactionRollback,
          { transactionId },
        )
        pending.add(operation)
        void operation.finally(() => pending.delete(operation))
      },
    }
    return tx
  }
  return {
    async snapshot(pluginId) {
      return structuredClone(
        await authorityCall(dispatcher, SETTINGS_RPC.snapshot, { pluginId }),
      ) as unknown as Awaited<ReturnType<PluginSettingsAuthority["snapshot"]>>
    },
    async commit(proposal) {
      return structuredClone(
        await authorityCall(dispatcher, SETTINGS_RPC.commit, { proposal }),
      ) as unknown as Awaited<ReturnType<PluginSettingsAuthority["commit"]>>
    },
    async epoch() {
      return integerValue(
        await authorityCall(dispatcher, SETTINGS_RPC.epoch, {}),
        "Settings epoch",
      )
    },
    beginTransaction: transaction,
  }
}

interface ProviderSnapshotDto {
  id: string
  displayName: string
  revision: number
  available: boolean
  models: ReadonlyArray<ProviderModelInfo>
}

function providerModel(value: JsonValue, index: number): ProviderModelInfo {
  const input = exact(
    value,
    `Provider model ${index}`,
    ["id", "type", "endpoints", "preview"],
    ["prices"],
  )
  const id = stringValue(input.id, `Provider model ${index} id`)
  const type = stringValue(input.type, `Provider model ${index} type`)
  if (!Array.isArray(input.endpoints))
    throw new Error(`Provider model ${index} endpoints are invalid.`)
  const endpoints = input.endpoints.map((endpoint) =>
    stringValue(endpoint, `Provider model ${index} endpoint`),
  )
  if (typeof input.preview !== "boolean")
    throw new Error(`Provider model ${index} preview is invalid.`)
  let prices: Readonly<Record<string, number>> | undefined
  if (input.prices !== undefined) {
    const parsed = record(input.prices, `Provider model ${index} prices`)
    if (
      Object.values(parsed).some(
        (price) => typeof price !== "number" || !Number.isFinite(price),
      )
    )
      throw new Error(`Provider model ${index} prices are invalid.`)
    prices = structuredClone(parsed) as Readonly<Record<string, number>>
  }
  return {
    id,
    type,
    endpoints,
    preview: input.preview,
    ...(prices === undefined ? {} : { prices }),
  }
}

function providerSnapshot(value: JsonValue): ProviderSnapshotDto {
  const input = exact(value, "Provider snapshot", [
    "id",
    "displayName",
    "revision",
    "available",
    "models",
  ])
  const id = stringValue(input.id, "Provider id")
  const displayName = stringValue(input.displayName, "Provider display name")
  const revision = integerValue(input.revision, "Provider revision")
  if (revision < 0) throw new Error("Provider revision is invalid.")
  if (typeof input.available !== "boolean")
    throw new Error("Provider availability is invalid.")
  if (!Array.isArray(input.models))
    throw new Error("Provider models must be an array.")
  return {
    id,
    displayName,
    revision,
    available: input.available,
    models: input.models.map((model, index) => providerModel(model, index)),
  }
}

async function providerQuotaWindows(
  dispatcher: DuplexRpcDispatcher,
  method: string,
): Promise<ReadonlyArray<ProviderQuotaWindow>> {
  const value = await dispatcher.callProvider(method, {})
  if (!Array.isArray(value))
    throw new Error("Provider quota windows must be an array.")
  return structuredClone(value) as unknown as ReadonlyArray<ProviderQuotaWindow>
}

interface CreatedProvider {
  readonly provider: UpstreamProvider
  dispose(): void
}

async function createProvider(
  dispatcher: DuplexRpcDispatcher,
): Promise<CreatedProvider> {
  const listeners = new Set<() => void>()
  let snapshot: ProviderSnapshotDto | undefined
  const applySnapshot = (value: JsonValue, notify: boolean): void => {
    const next = providerSnapshot(value)
    if (
      snapshot !== undefined
      && (next.id !== snapshot.id || next.displayName !== snapshot.displayName)
    )
      throw new Error("Provider identity changed during a runner generation.")
    if (snapshot !== undefined && next.revision <= snapshot.revision) return
    snapshot = next
    if (notify) for (const listener of listeners) listener()
  }
  const unregisterUpdate = dispatcher.register(
    "provider",
    PROVIDER_RPC.catalogUpdate,
    (params) => {
      applySnapshot(params, true)
      return null
    },
  )
  try {
    applySnapshot(
      await dispatcher.callProvider(PROVIDER_RPC.snapshot, {}),
      false,
    )
  } catch (error) {
    unregisterUpdate()
    throw error
  }
  const initial = snapshot
  if (!initial) {
    unregisterUpdate()
    throw new Error("Provider snapshot is unavailable.")
  }
  const costs = new WeakMap<object, ProviderCost | undefined>()
  return {
    provider: {
      id: initial.id,
      displayName: initial.displayName,
      async postJson<T>(
        path: string,
        body: Record<string, unknown> | FormData,
        options: ProviderRequestOptions,
      ): Promise<T> {
        const encoded = await encodeBody(body)
        const value = parseProviderReply(
          await dispatcher.callProvider(
            PROVIDER_RPC.postJson,
            json(
              {
                path,
                body: encoded,
                options: {
                  errorMessage: options.errorMessage,
                  invocation: options.invocation,
                },
              },
              "Provider post request",
            ),
            { signal: options.signal },
          ),
        )
        const reply = structuredClone(value.reply)
        if (reply !== null && typeof reply === "object")
          costs.set(reply, value.cost)
        return reply as T
      },
      model: (id) => snapshot?.models.find((model) => model.id === id),
      onCatalogChange: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      available: () => snapshot?.available ?? false,
      cost: (reply) => costs.get(reply),
      quotaWindows: () =>
        providerQuotaWindows(dispatcher, PROVIDER_RPC.quotaWindows),
      refreshQuotaWindows: () =>
        providerQuotaWindows(dispatcher, PROVIDER_RPC.refreshQuotaWindows),
    },
    dispose() {
      unregisterUpdate()
      listeners.clear()
    },
  }
}

async function createHost(
  dispatcher: DuplexRpcDispatcher,
): Promise<HostServices> {
  const value = exact(
    await dispatcher.callHost(HOST_RPC.snapshot, {}),
    "Host snapshot",
    ["revision", "appVersion", "maximalPort"],
  )
  const appVersion = stringValue(value.appVersion, "Host app version")
  const maximalPort = integerValue(value.maximalPort, "Host port")
  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    args: ReadonlyArray<unknown>,
  ): void => {
    void dispatcher
      .callHost(HOST_RPC.log, json({ level, message, args }, "Host log"))
      .catch(() => undefined)
  }
  return {
    appVersion,
    maximalPort: () => maximalPort,
    openExternal: async (url) => {
      await dispatcher.callHost(HOST_RPC.openExternal, { url })
    },
    logger: {
      debug: (message, ...args) => log("debug", message, args),
      info: (message, ...args) => log("info", message, args),
      warn: (message, ...args) => log("warn", message, args),
      error: (message, ...args) => log("error", message, args),
    },
  }
}

export async function createReverseServices(
  dispatcher: DuplexRpcDispatcher,
): Promise<ReverseServices> {
  const pending = new Set<Promise<unknown>>()
  const [createdProvider, host] = await Promise.all([
    createProvider(dispatcher),
    createHost(dispatcher),
  ])
  return {
    settingsAuthority: createSettingsAuthority(dispatcher, pending),
    provider: createdProvider.provider,
    host,
    flush: async () => {
      await Promise.allSettled(pending)
    },
    dispose: () => createdProvider.dispose(),
  }
}

export function gatewayProjection(
  gateway: PluginGateway,
  operationRevision = 0,
): GatewayProjectionDto {
  const plugins = gateway.list()
  const listings = Object.fromEntries(
    plugins.map((plugin) => [plugin.id, gateway.listTools(plugin.id)]),
  )
  const toolViews = Object.fromEntries(
    plugins.map((plugin) => [plugin.id, gateway.toolViews(plugin.id)]),
  )
  const operations = gateway.operations()
  const servedModels = operations.servedModels()
  const operationTargets: Array<
    GatewayProjectionDto["operationTargets"][number]
  > = []
  for (const served of servedModels) {
    for (const operation of served.operations) {
      for (const model of [
        served.model,
        `${served.provider}/${served.model}`,
      ]) {
        const target = operations.resolve(operation, model)
        if (target) operationTargets.push({ operation, model, ...target })
      }
    }
  }
  return {
    operationRevision,
    plugins,
    listings,
    toolViews,
    serverTools: gateway.serverTools(),
    servedModels,
    operationTargets,
  }
}

function wireError(error: unknown): Error {
  if (isPluginGatewayError(error)) {
    return new WireRemoteError({
      kind: "plugin-gateway",
      code: error.code,
      message: error.message,
      retry: "never",
      pluginId: error.pluginId,
      ...(error.issues === undefined ?
        {}
      : {
          issues: error.issues.map((issue) => ({ ...issue })),
        }),
    })
  }
  if (isOperationUnavailableError(error)) {
    return new WireRemoteError({
      kind: "operation-unavailable",
      code: "operation-unavailable",
      message: error.message,
      retry: "never",
      operation: error.operation,
      model: error.model,
    })
  }
  return error instanceof Error ? error : new Error(String(error))
}

function handler(
  run: (params: JsonValue, context: RpcContext) => unknown,
): (params: JsonValue, context: RpcContext) => Promise<JsonValue> {
  return async (params, context) => {
    try {
      return json(await run(params, context), "Gateway RPC result")
    } catch (error) {
      throw wireError(error)
    }
  }
}

function operationExecution(value: JsonValue): OperationExecutionDto {
  const input = exact(value, "Operation execution", [
    "operationRevision",
    "operation",
    "model",
    "pluginId",
    "binding",
    "body",
    "invocationId",
    "providerCallId",
    "sequence",
    "origin",
  ])
  if (integerValue(input.operationRevision, "Operation revision") < 0)
    throw new Error("Operation revision must be non-negative.")
  stringValue(input.pluginId, "Operation plugin id")
  const binding = exact(input.binding ?? null, "Operation binding", [
    "provider",
    "upstreamModel",
  ])
  stringValue(binding.provider, "Operation binding provider")
  stringValue(binding.upstreamModel, "Operation binding model")
  return structuredClone(input) as unknown as OperationExecutionDto
}

function serverToolCall(value: JsonValue): ServerToolCallDto {
  const input = exact(
    value,
    "Server tool call",
    ["invocationId", "model", "client", "providerCallIds"],
    ["sessionId", "budget"],
  )
  if (
    !Array.isArray(input.providerCallIds)
    || input.providerCallIds.length === 0
    || input.providerCallIds.some(
      (providerCallId) =>
        typeof providerCallId !== "string" || providerCallId.length === 0,
    )
  )
    throw new Error("Provider call identities are invalid.")
  return structuredClone(input) as unknown as ServerToolCallDto
}

/** Bind a composed child gateway to finite, strict forward RPC methods. */
// eslint-disable-next-line max-lines-per-function, max-params -- finite method table is one audited protocol surface
export function registerRunnerGateway(
  dispatcher: DuplexRpcDispatcher,
  transport: BunIpcTransport,
  gateway: PluginGateway,
  resources?: PluginGenerationResourceLifecycle,
): () => Promise<void> {
  const prepared = new Map<string, PreparedServerTool>()
  const disposers: Array<() => void> = []
  const operations = gateway.operations()
  let operationRevision = 0
  disposers.push(
    operations.subscribe(() => {
      operationRevision += 1
    }),
  )
  let revision = -1
  let disposed = false
  const rpc = (
    method: string,
    run: (params: JsonValue, context: RpcContext) => unknown,
  ): void => {
    disposers.push(dispatcher.register("request", method, handler(run)))
  }

  rpc(GATEWAY_RPC.snapshot, () => gatewayProjection(gateway, operationRevision))
  rpc(GATEWAY_RPC.reconcile, async (params) => {
    const input = exact(params, "Gateway reconcile", ["settings"])
    await gateway.reconcile(parsePluginSettings(input.settings ?? null))
    return null
  })
  rpc(GATEWAY_RPC.callTool, async (params, context) => {
    const input = exact(
      params,
      "Tool call",
      ["pluginId", "name", "input", "canElicit"],
      ["sessionId", "approved"],
    )
    return await gateway.callTool(
      stringValue(input.pluginId, "Tool plugin id"),
      stringValue(input.name, "Tool name"),
      structuredClone(record(input.input ?? null, "Tool input")),
      {
        signal: context.signal,
        ...(optionalString(input.sessionId, "Tool session id") === undefined ?
          {}
        : {
            sessionId: optionalString(input.sessionId, "Tool session id"),
          }),
        ...(typeof input.approved === "boolean" ?
          { approved: input.approved }
        : {}),
        progress: (progress) => {
          void context.progress(progress)
        },
        ...(input.canElicit === true ?
          {
            elicit: async (request) => {
              const reply = await context.elicit(
                request.message,
                json(request.requestedSchema, "Elicitation schema"),
              )
              return {
                action: reply.action,
                ...(reply.content === undefined ?
                  {}
                : {
                    content: structuredClone(
                      record(reply.content, "Elicitation content"),
                    ),
                  }),
              }
            },
          }
        : {}),
      },
    )
  })
  rpc(GATEWAY_RPC.executeOperation, async (params, context) => {
    const request = operationExecution(params)
    if (request.operationRevision !== operationRevision)
      throw new Error("Prepared operation registry changed before execution.")
    const current = operations.prepare(request.operation, request.model)
    if (!current)
      throw new OperationUnavailableError(request.operation, request.model)
    try {
      if (
        current.pluginId !== request.pluginId
        || current.binding.provider !== request.binding.provider
        || current.binding.upstreamModel !== request.binding.upstreamModel
      )
        throw new Error("Prepared operation binding changed before execution.")
      return parseOperationResult(
        json(
          await current.execute({
            body: decodeBody(request.body),
            signal: context.signal,
            invocationId: request.invocationId,
            providerCallId: request.providerCallId,
            sequence: request.sequence,
            origin: request.origin,
          }),
          "Operation result",
        ),
      )
    } finally {
      current.release()
    }
  })
  rpc(GATEWAY_RPC.prepareServerTool, async (params) => {
    const input = exact(params, "Prepare server tool", [
      "pluginId",
      "name",
      "input",
    ])
    const value = await gateway.prepareServerTool(
      stringValue(input.pluginId, "Server tool plugin id"),
      stringValue(input.name, "Server tool name"),
      structuredClone(record(input.input ?? null, "Server tool input")),
    )
    const preparedId = randomUUID()
    prepared.set(preparedId, value)
    return {
      preparedId,
      pluginId: value.pluginId,
      name: value.name,
      ...(value.estimate === undefined ?
        {}
      : {
          estimate: await encodeEstimate(value.estimate),
        }),
    }
  })
  rpc(GATEWAY_RPC.executeServerTool, async (params, context) => {
    const input = exact(params, "Execute server tool", ["preparedId", "call"])
    const preparedId = stringValue(input.preparedId, "Prepared server tool id")
    const value = prepared.get(preparedId)
    if (!value) throw new Error("Prepared server tool is unavailable.")
    prepared.delete(preparedId)
    const call = serverToolCall(input.call ?? null)
    let sequence = 0
    const nextProviderCall = (
      operation: ProviderInvocation["operation"],
      model: string,
    ): ProviderInvocation => {
      const providerCallId = call.providerCallIds[sequence]
      if (!providerCallId)
        throw new Error("Provider call identity allocation is exhausted.")
      sequence += 1
      return {
        invocationId: call.invocationId,
        providerCallId,
        sequence,
        operation,
        model,
      }
    }
    const serverCall: ServerToolCall = {
      signal: context.signal,
      invocationId: call.invocationId,
      nextProviderCall,
      ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
      model: call.model,
      client: call.client,
      ...(call.budget === undefined ? {} : { budget: call.budget }),
      reportSpend: (spend) => {
        void context.reportSpend(
          spend.invocationId,
          spend.providerCallId,
          spend.result.cost?.amount ?? 0,
          spendEvidence(spend),
        )
      },
    }
    return await value.execute(serverCall)
  })
  rpc(GATEWAY_RPC.releaseServerTool, (params) => {
    const input = exact(params, "Release server tool", ["preparedId"])
    const id = stringValue(input.preparedId, "Prepared server tool id")
    prepared.get(id)?.release()
    prepared.delete(id)
    return null
  })
  rpc(GATEWAY_RPC.runAction, async (params, context) => {
    const input = exact(params, "Run action", ["pluginId", "actionId"])
    await gateway.runAction(
      stringValue(input.pluginId, "Action plugin id"),
      stringValue(input.actionId, "Action id"),
      context.signal,
    )
    return null
  })
  rpc(GATEWAY_RPC.updateConfig, async (params) => {
    const input = exact(params, "Update config", ["pluginId", "config"])
    await gateway.updateConfig(
      stringValue(input.pluginId, "Config plugin id"),
      structuredClone(input.config),
    )
    return null
  })
  rpc(GATEWAY_RPC.setToolPermissions, async (params) => {
    const input = exact(params, "Set tool permissions", ["pluginId", "changes"])
    await gateway.setToolPermissions(
      stringValue(input.pluginId, "Permissions plugin id"),
      parsePermissionChanges(input.changes ?? null),
    )
    return null
  })
  rpc(GATEWAY_RPC.importLegacyConfig, async (params) => {
    const input = exact(params, "Import legacy config", ["pluginId", "config"])
    return await gateway.importLegacyConfig(
      stringValue(input.pluginId, "Legacy config plugin id"),
      structuredClone(input.config),
    )
  })
  rpc(GATEWAY_RPC.resourceList, () => resources?.list() ?? [])
  for (const [method, step] of [
    [GATEWAY_RPC.resourcePrepare, "prepare"],
    [GATEWAY_RPC.resourceCommit, "commit"],
    [GATEWAY_RPC.resourceRevoke, "revoke"],
    [GATEWAY_RPC.resourceResume, "resume"],
  ] as const) {
    rpc(method, async (params, context) => {
      if (!resources)
        throw new Error("Runner resource lifecycle is unavailable.")
      const input = exact(params, "Resource lifecycle call", [
        "deadline",
        "purpose",
      ])
      const deadline = integerValue(input.deadline, "Resource deadline")
      const purpose = stringValue(input.purpose, "Resource purpose")
      if (
        purpose !== "activation"
        && purpose !== "handoff"
        && purpose !== "recovery"
      )
        throw new Error("Resource lifecycle purpose is invalid.")
      await resources[step]({ signal: context.signal, deadline, purpose })
      return null
    })
  }
  rpc(GATEWAY_RPC.releaseUpstreamSession, async (params, context) => {
    const input = exact(params, "Release upstream session", ["sessionId"])
    await releaseUpstreamSession(
      stringValue(input.sessionId, "Upstream session id"),
      context.signal,
    )
    return null
  })

  const unsubscribe = gateway.subscribe((event) => {
    revision += 1
    void transport
      .send({
        type: "state-event",
        revision,
        payload: { event: json(event, "Gateway event") },
      })
      .catch(() => undefined)
  })

  return () => {
    if (disposed) return Promise.resolve()
    disposed = true
    unsubscribe()
    for (const value of prepared.values()) value.release()
    prepared.clear()
    for (const dispose of disposers.reverse()) dispose()
    return Promise.resolve()
  }
}
