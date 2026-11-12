/**
 * Budget around one operation dispatch: hold the call's estimate against
 * every limit that covers it, dispatch, prepare the provider's observed usage,
 * then settle usage and the hold atomically when cost is authoritative. A
 * missing cost or failure after dispatch starts leaves the
 * estimate unreconciled rather than assuming the provider billed nothing.
 *
 * Shared by the pass-through routes and by anything else that dispatches an
 * operation on a caller's behalf (a server tool's origin is
 * `{ kind: "server-tool" }`).
 */

import type {
  ModelOperation,
  OperationRequest,
  OperationResult,
  PreparedOperation,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { randomUUID } from "node:crypto"

import type { PersistedTokenUsageEvent } from "~/lib/token-usage/store"

import {
  ProviderInvocationError,
  providerInvocationJournal,
  type ProviderCallObservation,
  type ProviderInvocationJournal,
} from "~/lib/plugins/provider-broker"

import { estimateOperationNanoAiu } from "./estimate"
import {
  currentBudgetKey,
  reserveBudget,
  settleBudgetUsage,
  unreconcileBudgetUsage,
} from "./runtime"
import { type BudgetService, type ObservedBudgetTokens } from "./service"

/** The built-in capability whose usage rows (`plugin_id`) an operation counts
 *  under, so a `plugin:images` limit covers what it spent. */
export const OPERATION_PLUGINS = {
  "images.generations": "images",
  "images.edits": "images",
  decisions: "decisions",
  systemone: "systemone",
} as const satisfies Record<ModelOperation, string>

export interface BudgetedDispatchOptions {
  /** The provider the operation resolved to. */
  provider: string
  /** Prepare the result's usage for atomic settlement. */
  record: (
    result: Pick<OperationResult, "usage" | "cost">,
  ) => PersistedTokenUsageEvent | null
  /** Defaults to the app's service. */
  budget?: BudgetService
  /** Defaults to the parent provider journal. */
  journal?: ProviderInvocationJournal
}

/**
 * The result as it is booked: a reply that reports no cost is returned with
 * the hold's estimate (there is none when no limit covers the call). Durable
 * accounting still marks that estimate unreconciled rather than authoritative.
 */
export function bookedResult<T extends Pick<OperationResult, "usage" | "cost">>(
  result: T,
  hold: { readonly estimateNanoAiu: number },
): T {
  if (result.cost?.amount !== undefined || hold.estimateNanoAiu <= 0) {
    return result
  }
  return {
    ...result,
    cost: { unit: "nano_aiu", amount: hold.estimateNanoAiu, estimated: true },
  }
}

interface CollectedUsage {
  readonly events: Array<PersistedTokenUsageEvent>
  readonly observedTokens: ObservedBudgetTokens
  billedNanoAiu: number
  completeBill: boolean
  observedSuccess: boolean
}

function collectResult(
  usage: CollectedUsage,
  result: Pick<OperationResult, "usage" | "cost">,
  record: BudgetedDispatchOptions["record"],
): void {
  const event = record(result)
  if (event) usage.events.push(event)
  usage.observedTokens.input ||=
    typeof result.usage.input_tokens === "number"
    || typeof result.usage.cache_read_input_tokens === "number"
  usage.observedTokens.output ||= typeof result.usage.output_tokens === "number"
  usage.observedSuccess = true
  if (result.cost?.amount === undefined) usage.completeBill = false
  else usage.billedNanoAiu += result.cost.amount
}

function observationResult(
  observation: ProviderCallObservation,
): Pick<OperationResult, "usage" | "cost"> | undefined {
  if (observation.outcome !== "success") return undefined
  return {
    usage: {},
    ...(observation.cost === undefined ? {} : { cost: observation.cost }),
  }
}

async function settleCollected(
  hold: Awaited<ReturnType<typeof reserveBudget>>,
  usage: CollectedUsage,
): Promise<void> {
  if (usage.observedSuccess && usage.completeBill) {
    await settleBudgetUsage(hold, usage.events, usage.billedNanoAiu)
    return
  }
  await unreconcileBudgetUsage(hold, usage.events, {
    reason: "usage-missing",
    observedTokens: usage.observedTokens,
  })
}

interface ObservationMatch {
  readonly journal: ProviderInvocationJournal
  readonly invocationId: string
  readonly providerCallId: string
  readonly sequence: number
  readonly prepared: PreparedOperation
  readonly provider: string
}

function requireMatchingObservation(
  match: ObservationMatch,
): ProviderCallObservation {
  const observation = match.journal
    .unacknowledged(match.invocationId)
    .find(
      (candidate) =>
        candidate.invocation.providerCallId === match.providerCallId,
    )
  if (
    !observation
    || observation.outcome !== "success"
    || observation.invocation.sequence !== match.sequence
    || observation.invocation.operation !== match.prepared.operation
    || observation.invocation.model !== match.prepared.binding.upstreamModel
    || observation.provider !== match.provider
  ) {
    throw new ProviderInvocationError(
      "Operation result did not match an observed provider call.",
    )
  }
  return observation
}

interface OutstandingCollection {
  readonly journal: ProviderInvocationJournal
  readonly invocationId: string
  readonly usage: CollectedUsage
  readonly record: BudgetedDispatchOptions["record"]
  readonly skipProviderCallId?: string
}

function collectOutstanding(collection: OutstandingCollection): void {
  for (const observation of collection.journal.unacknowledged(
    collection.invocationId,
  )) {
    if (observation.invocation.providerCallId === collection.skipProviderCallId)
      continue
    const observed = observationResult(observation)
    if (observed) collectResult(collection.usage, observed, collection.record)
    else collection.usage.completeBill = false
  }
}

export async function dispatchWithBudget(
  prepared: PreparedOperation,
  request: Omit<
    OperationRequest,
    | "operation"
    | "model"
    | "binding"
    | "invocationId"
    | "providerCallId"
    | "sequence"
  >,
  options: BudgetedDispatchOptions,
): Promise<OperationResult> {
  const hold = await reserveBudget(
    {
      operation: prepared.operation,
      provider: options.provider,
      plugin: OPERATION_PLUGINS[prepared.operation],
      model: prepared.model,
      key: currentBudgetKey(),
      estimateNanoAiu: estimateOperationNanoAiu(
        prepared.operation,
        request.body,
      ),
    },
    options.budget,
  )
  if (request.signal.aborted) {
    await hold.release("aborted")
    throw request.signal.reason ?? new Error("Request aborted")
  }

  const journal = options.journal ?? providerInvocationJournal
  const invocationId = randomUUID()
  const providerCallId = randomUUID()
  const sequence = 1
  const usage: CollectedUsage = {
    events: [],
    observedTokens: { input: false, output: false },
    billedNanoAiu: 0,
    completeBill: true,
    observedSuccess: false,
  }
  let terminalResult!: OperationResult
  try {
    const result = await prepared.execute({
      ...request,
      invocationId,
      providerCallId,
      sequence,
    })
    if (
      result.invocationId !== invocationId
      || result.providerCallId !== providerCallId
      || result.sequence !== sequence
    ) {
      throw new ProviderInvocationError(
        "Operation result did not match its provider invocation identity.",
      )
    }
    const observation = requireMatchingObservation({
      journal,
      invocationId,
      providerCallId,
      sequence,
      prepared,
      provider: options.provider,
    })
    terminalResult =
      observation.cost === undefined ?
        result
      : { ...result, cost: observation.cost }
    collectResult(usage, terminalResult, options.record)
  } catch (error) {
    collectOutstanding({ journal, invocationId, usage, record: options.record })
    await settleCollected(hold, usage)
    journal.finish(invocationId)
    throw error
  }

  collectOutstanding({
    journal,
    invocationId,
    usage,
    record: options.record,
    skipProviderCallId: providerCallId,
  })
  await settleCollected(hold, usage)
  journal.acknowledge(invocationId, providerCallId, sequence)
  journal.finish(invocationId)
  return bookedResult(terminalResult, hold)
}
