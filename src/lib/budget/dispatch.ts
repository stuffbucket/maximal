/**
 * Budget around one operation dispatch: hold the call's estimate against
 * every limit that covers it, dispatch, hand the result (with the estimate
 * standing in for a cost the provider didn't report) to `record`, then
 * commit the hold; release it when the dispatch fails.
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

import { estimateOperationNanoAiu } from "./estimate"
import { currentBudgetKey, reserveBudget } from "./runtime"
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
  /** Books the result's usage; runs before the hold is committed. */
  record: (result: OperationResult) => void
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
  try {
    const result = await operations.dispatch(request)
    const booked = bookedResult(result, hold)
    options.record(booked)
    hold.commit({ nanoAiu: result.cost?.amount })
    return booked
  } catch (error) {
    // The provider refused the call or it was abandoned: nothing was billed.
    hold.release(request.signal.aborted ? "aborted" : "upstream-error")
    throw error
  }
}
