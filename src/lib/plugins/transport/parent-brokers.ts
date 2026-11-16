import type { JsonValue } from "@stuffbucket/maximal-plugin-protocol"

import {
  decodeBlobHandle,
  ProtocolError,
  WireRemoteError,
} from "@stuffbucket/maximal-plugin-protocol"
import consola from "consola"

import type { ParentHostServiceBroker } from "~/lib/plugins/host-service-broker"
import type { ParentProviderBroker } from "~/lib/plugins/provider-broker"
import type { GenerationSpoolStore } from "~/lib/plugins/spool/store"
import type { PluginStateBroker } from "~/lib/plugins/state-broker"
import type { DuplexRpcDispatcher } from "~/lib/plugins/transport/dispatcher"
import type { BodyDto } from "~/lib/plugins/transport/gateway-codec"

import { providerInvocationJournal } from "~/lib/plugins/provider-broker"
import { spoolLargeStrings } from "~/lib/plugins/transport/blob-codec"
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
  readonly spool: GenerationSpoolStore
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

function completedProviderTransportError(): WireRemoteError {
  return new WireRemoteError({
    kind: "indeterminate",
    code: "provider_reply_transport_failed",
    message:
      "The provider completed, but its response could not be transported safely.",
    retry: "never",
  })
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
  spool: GenerationSpoolStore,
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
        await decodeBody(bodyDto(input.body ?? null), { store: spool }),
        options,
      )
      let cost: ReturnType<ParentProviderBroker["cost"]>
      try {
        cost =
          reply !== null && typeof reply === "object" && !Array.isArray(reply) ?
            provider.cost(reply, {
              operation: invocation.operation,
              model: invocation.model,
            })
          : undefined
      } catch {
        providerInvocationJournal.observeSuccess(invocation, provider.id)
        throw completedProviderTransportError()
      }
      providerInvocationJournal.observeSuccess(invocation, provider.id, cost)
      try {
        const transported = await spoolLargeStrings(
          json(reply, "Provider reply body"),
          {
            store: spool,
            callId: invocation.invocationId,
            signal: context.signal,
          },
        )
        return json(
          { reply: transported, ...(cost === undefined ? {} : { cost }) },
          "Provider reply",
        )
      } catch {
        throw completedProviderTransportError()
      }
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
  spool: GenerationSpoolStore,
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
    rpc(HOST_RPC.blobStage, async (params, context) => {
      const input = exact(
        params,
        "Blob stage",
        ["callId", "byteLength"],
        ["filename", "mediaType"],
      )
      if (context.signal.aborted)
        throw context.signal.reason ?? new Error("Aborted")
      return json(
        await spool.stageUpload({
          callId: stringValue(input.callId, "Blob call id"),
          byteLength: integerValue(input.byteLength, "Blob byte length"),
          ...(input.filename === undefined ?
            {}
          : { filename: stringValue(input.filename, "Blob filename") }),
          ...(input.mediaType === undefined ?
            {}
          : { mediaType: stringValue(input.mediaType, "Blob media type") }),
          signal: context.signal,
        }),
        "Blob stage result",
      )
    }),
    rpc(HOST_RPC.blobCommit, async (params) => {
      const input = exact(params, "Blob commit", ["id"])
      return json(
        await spool.commitUpload(stringValue(input.id, "Blob upload id")),
        "Blob handle",
      )
    }),
    rpc(HOST_RPC.blobAbort, async (params) => {
      const input = exact(params, "Blob abort", ["id"])
      await spool.abortUpload(stringValue(input.id, "Blob upload id"))
      return null
    }),
    rpc(HOST_RPC.blobPath, async (params) => {
      const input = exact(params, "Blob path", ["handle"])
      return await spool.resolvePath(
        decodeBlobHandle(input.handle, spool.generation),
      )
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
    ...registerProvider(dispatcher, options.provider, options.spool),
    ...registerHost(dispatcher, options.host, options.spool),
  ]
  return () => {
    for (const transaction of transactions.values()) transaction.rollback()
    transactions.clear()
    for (const dispose of disposers.reverse()) dispose()
  }
}
