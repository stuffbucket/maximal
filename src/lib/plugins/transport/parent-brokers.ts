import type { JsonValue } from "@stuffbucket/maximal-plugin-protocol"

import { ProtocolError } from "@stuffbucket/maximal-plugin-protocol"
import consola from "consola"

import type { ParentHostServiceBroker } from "~/lib/plugins/host-service-broker"
import type { ParentProviderBroker } from "~/lib/plugins/provider-broker"
import type { PluginStateBroker } from "~/lib/plugins/state-broker"
import type { DuplexRpcDispatcher } from "~/lib/plugins/transport/dispatcher"
import type { BodyDto } from "~/lib/plugins/transport/gateway-codec"

import { providerInvocationJournal } from "~/lib/plugins/provider-broker"
import {
  decodeBody,
  exact,
  HOST_RPC,
  integerValue,
  json,
  optionalString,
  PROVIDER_RPC,
  record,
  SETTINGS_RPC,
  stringValue,
} from "~/lib/plugins/transport/gateway-codec"

type ProviderRequestOptions = Parameters<ParentProviderBroker["postJson"]>[2]
type ProviderInvocation = ProviderRequestOptions["invocation"]
type PluginSettingsProposal = Parameters<PluginStateBroker["commit"]>[0]
type PluginSettingsTransaction = ReturnType<
  PluginStateBroker["beginTransaction"]
>

const MODEL_OPERATIONS = new Set<ProviderInvocation["operation"]>([
  "systemone",
  "decisions",
  "images.generations",
  "images.edits",
])

interface ParentBrokerOptions {
  readonly state: PluginStateBroker
  readonly provider: ParentProviderBroker
  readonly host: ParentHostServiceBroker
}

function proposal(value: JsonValue): PluginSettingsProposal {
  const input = exact(value, "Settings proposal", [
    "pluginId",
    "baseRevision",
    "baseEpoch",
    "kind",
    "text",
  ])
  stringValue(input.pluginId, "Settings plugin id")
  integerValue(input.baseRevision, "Settings base revision")
  integerValue(input.baseEpoch, "Settings base epoch")
  stringValue(input.kind, "Settings proposal kind")
  if (typeof input.text !== "string")
    throw new Error("Settings text must be a string.")
  return structuredClone(input) as unknown as PluginSettingsProposal
}

function transaction(
  transactions: Map<string, PluginSettingsTransaction>,
  state: PluginStateBroker,
  id: string,
): PluginSettingsTransaction {
  let found = transactions.get(id)
  if (!found) {
    found = state.beginTransaction()
    transactions.set(id, found)
  }
  return found
}

function bodyDto(value: JsonValue): BodyDto {
  const input = record(value, "Provider body")
  if (input.kind !== "json" && input.kind !== "multipart")
    throw new Error("Provider body kind is invalid.")
  return structuredClone(input) as unknown as BodyDto
}

function requestOptions(
  value: JsonValue,
  signal: AbortSignal,
): ProviderRequestOptions {
  const input = exact(value, "Provider request options", [
    "errorMessage",
    "invocation",
  ])
  const invocationInput = exact(
    input.invocation ?? null,
    "Provider invocation",
    ["invocationId", "providerCallId", "sequence", "operation", "model"],
  )
  const operation = stringValue(invocationInput.operation, "Provider operation")
  if (!MODEL_OPERATIONS.has(operation as ProviderInvocation["operation"]))
    throw new Error("Provider operation is invalid.")
  return {
    signal,
    errorMessage: stringValue(input.errorMessage, "Provider error message"),
    invocation: {
      invocationId: stringValue(
        invocationInput.invocationId,
        "Provider invocation id",
      ),
      providerCallId: stringValue(
        invocationInput.providerCallId,
        "Provider call id",
      ),
      sequence: integerValue(
        invocationInput.sequence,
        "Provider call sequence",
      ),
      operation: operation as ProviderInvocation["operation"],
      model: stringValue(invocationInput.model, "Provider model"),
    },
  }
}

// eslint-disable-next-line max-lines-per-function -- settings transaction methods share one authority map
function registerSettings(
  dispatcher: DuplexRpcDispatcher,
  state: PluginStateBroker,
  transactions: Map<string, PluginSettingsTransaction>,
): Array<() => void> {
  const host = (
    method: string,
    handler: Parameters<DuplexRpcDispatcher["register"]>[2],
  ) => dispatcher.register("host", method, handler)
  return [
    host(SETTINGS_RPC.snapshot, async (params) => {
      const input = exact(
        params,
        "Settings snapshot",
        ["pluginId"],
        ["transactionId"],
      )
      const pluginId = stringValue(input.pluginId, "Settings plugin id")
      const transactionId = optionalString(
        input.transactionId,
        "Settings transaction id",
      )
      const authority =
        transactionId === undefined ? state : (
          transaction(transactions, state, transactionId)
        )
      return json(
        await authority.snapshot(pluginId),
        "Settings snapshot result",
      )
    }),
    host(SETTINGS_RPC.commit, async (params) => {
      const input = exact(
        params,
        "Settings commit",
        ["proposal"],
        ["transactionId"],
      )
      const transactionId = optionalString(
        input.transactionId,
        "Settings transaction id",
      )
      const authority =
        transactionId === undefined ? state : (
          transaction(transactions, state, transactionId)
        )
      return json(
        await authority.commit(proposal(input.proposal ?? null)),
        "Settings commit result",
      )
    }),
    host(SETTINGS_RPC.epoch, async (params) => {
      const input = exact(params, "Settings epoch", [], ["transactionId"])
      const transactionId = optionalString(
        input.transactionId,
        "Settings transaction id",
      )
      const authority =
        transactionId === undefined ? state : (
          transaction(transactions, state, transactionId)
        )
      return await authority.epoch()
    }),
    host(SETTINGS_RPC.transactionSnapshot, async (params) => {
      const input = exact(params, "Transaction snapshot", [
        "transactionId",
        "pluginId",
      ])
      return json(
        await transaction(
          transactions,
          state,
          stringValue(input.transactionId, "Settings transaction id"),
        ).snapshot(stringValue(input.pluginId, "Settings plugin id")),
        "Transaction snapshot result",
      )
    }),
    host(SETTINGS_RPC.transactionCommit, async (params) => {
      const input = exact(params, "Transaction commit", [
        "transactionId",
        "proposal",
      ])
      return json(
        await transaction(
          transactions,
          state,
          stringValue(input.transactionId, "Settings transaction id"),
        ).commit(proposal(input.proposal ?? null)),
        "Transaction commit result",
      )
    }),
    host(SETTINGS_RPC.transactionEpoch, async (params) => {
      const input = exact(params, "Transaction epoch", ["transactionId"])
      return await transaction(
        transactions,
        state,
        stringValue(input.transactionId, "Settings transaction id"),
      ).epoch()
    }),
    host(SETTINGS_RPC.transactionFinish, async (params) => {
      const input = exact(params, "Transaction finish", ["transactionId"])
      const id = stringValue(input.transactionId, "Settings transaction id")
      const current = transaction(transactions, state, id)
      try {
        return json(await current.finish(), "Transaction finish result")
      } finally {
        transactions.delete(id)
      }
    }),
    host(SETTINGS_RPC.transactionRollback, (params) => {
      const input = exact(params, "Transaction rollback", ["transactionId"])
      const id = stringValue(input.transactionId, "Settings transaction id")
      transactions.get(id)?.rollback()
      transactions.delete(id)
      return null
    }),
  ]
}

function registerProvider(
  dispatcher: DuplexRpcDispatcher,
  provider: ParentProviderBroker,
): Array<() => void> {
  const rpc = (
    method: string,
    handler: Parameters<DuplexRpcDispatcher["register"]>[2],
  ) => dispatcher.register("provider", method, handler)
  const snapshot = (): JsonValue =>
    json(
      {
        id: provider.id,
        displayName: provider.displayName,
        ...provider.snapshot(),
      },
      "Provider snapshot",
    )
  let unsubscribe: (() => void) | undefined
  const ensureSubscribed = (): void => {
    if (unsubscribe) return
    unsubscribe = provider.subscribe(() => {
      void dispatcher
        .callProvider(PROVIDER_RPC.catalogUpdate, snapshot())
        .catch((error: unknown) => {
          if (error instanceof ProtocolError && error.code === "closed") return
          consola.warn("Could not publish provider catalog update", error)
        })
    })
  }
  const disposers = [
    rpc(PROVIDER_RPC.snapshot, () => {
      ensureSubscribed()
      return snapshot()
    }),
    rpc(PROVIDER_RPC.postJson, async (params, context) => {
      const input = exact(params, "Provider post", ["path", "body", "options"])
      const path = stringValue(input.path, "Provider path")
      const options = requestOptions(input.options ?? null, context.signal)
      const invocation = options.invocation
      providerInvocationJournal.begin(invocation, provider.id)
      const reply = await provider.postJson<JsonValue>(
        path,
        decodeBody(bodyDto(input.body ?? null)),
        options,
      )
      const cost =
        reply !== null && typeof reply === "object" && !Array.isArray(reply) ?
          provider.cost(reply, {
            operation: invocation.operation,
            model: invocation.model,
          })
        : undefined
      providerInvocationJournal.observeSuccess(invocation, provider.id, cost)
      return json(
        { reply, ...(cost === undefined ? {} : { cost }) },
        "Provider reply",
      )
    }),
    rpc(PROVIDER_RPC.quotaWindows, async () =>
      json((await provider.quotaWindows?.()) ?? [], "Provider quota windows"),
    ),
    rpc(PROVIDER_RPC.refreshQuotaWindows, async () =>
      json(
        (await provider.refreshQuotaWindows?.()) ?? [],
        "Provider refreshed quota windows",
      ),
    ),
  ]
  disposers.push(() => {
    unsubscribe?.()
    unsubscribe = undefined
  })
  return disposers
}

function registerHost(
  dispatcher: DuplexRpcDispatcher,
  host: ParentHostServiceBroker,
): Array<() => void> {
  const rpc = (
    method: string,
    handler: Parameters<DuplexRpcDispatcher["register"]>[2],
  ) => dispatcher.register("host", method, handler)
  return [
    rpc(HOST_RPC.snapshot, () => json(host.snapshot(), "Host snapshot")),
    rpc(HOST_RPC.openExternal, async (params) => {
      const input = exact(params, "Open external", ["url"])
      await host.openExternal(stringValue(input.url, "External URL"))
      return null
    }),
    rpc(HOST_RPC.log, (params) => {
      const input = exact(params, "Host log", ["level", "message"], ["args"])
      const level = stringValue(input.level, "Host log level")
      const message = stringValue(input.message, "Host log message")
      const args = Array.isArray(input.args) ? input.args : []
      if (
        level === "debug"
        || level === "info"
        || level === "warn"
        || level === "error"
      )
        host.logger[level](message, ...args)
      else throw new Error("Host log level is invalid.")
      return null
    }),
  ]
}

/** Install parent-authoritative reverse RPC handlers for one runner. */
export function registerParentBrokers(
  dispatcher: DuplexRpcDispatcher,
  options: ParentBrokerOptions,
): () => void {
  const transactions = new Map<string, PluginSettingsTransaction>()
  const disposers = [
    ...registerSettings(dispatcher, options.state, transactions),
    ...registerProvider(dispatcher, options.provider),
    ...registerHost(dispatcher, options.host),
  ]
  return () => {
    for (const transaction of transactions.values()) transaction.rollback()
    transactions.clear()
    for (const dispose of disposers.reverse()) dispose()
  }
}
