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
  OperationDispatch,
  OperationRequest,
  OperationResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import type { PersistedTokenUsageEvent } from "~/lib/token-usage/store"

import { estimateOperationNanoAiu } from "./estimate"
import {
  currentBudgetKey,
  reserveBudget,
  settleBudgetUsage,
  unreconcileBudgetUsage,
} from "./runtime"
import { type BudgetService } from "./service"

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
  record: (result: OperationResult) => PersistedTokenUsageEvent | null
  /** Defaults to the app's service. */
  budget?: BudgetService
}

/**
 * The result as it is booked: a reply that reports no cost is booked at the
 * hold's estimate (there is none when no limit covers the call).
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

export async function dispatchWithBudget(
  operations: OperationDispatch,
  request: Omit<OperationRequest, "binding">,
  options: BudgetedDispatchOptions,
): Promise<OperationResult> {
  const hold = await reserveBudget(
    {
      operation: request.operation,
      provider: options.provider,
      plugin: OPERATION_PLUGINS[request.operation],
      model: request.model,
      key: currentBudgetKey(),
      estimateNanoAiu: estimateOperationNanoAiu(
        request.operation,
        request.body,
      ),
    },
    options.budget,
  )
  if (request.signal.aborted) {
    await hold.release("aborted")
    throw request.signal.reason ?? new Error("Request aborted")
  }

  let result: OperationResult
  try {
    result = await operations.dispatch(request)
  } catch (error) {
    // Dispatch began, so a disconnect or provider failure without usage is
    // ambiguous. Keep the estimate rather than silently treating it as free.
    await hold.unreconcile("usage-missing")
    throw error
  }

  const booked = bookedResult(result, hold)
  const event = options.record(result)
  const events = event ? [event] : []
  await (result.cost?.amount === undefined ?
    unreconcileBudgetUsage(hold, events, {
      reason: "usage-missing",
      observedTokens: {
        input:
          typeof result.usage.input_tokens === "number"
          || typeof result.usage.cache_read_input_tokens === "number",
        output: typeof result.usage.output_tokens === "number",
      },
    })
  : settleBudgetUsage(hold, events, result.cost.amount))
  return booked
}
