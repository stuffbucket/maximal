/**
 * Which operation models `/models` lists. A model of an operation type
 * (`decisions`, `image`) that a capability plugin serves is listed only while
 * some enabled plugin serves it, so turning a plugin off takes its models out
 * of the list. Every other model is listed as the catalog has it.
 */

import type { ServedModel } from "@stuffbucket/maximal-plugin-sdk/gateway"

import type { Model } from "~/services/copilot/get-models"

import { COPILOT_PROVIDER_ID } from "~/services/copilot/upstream-request"

/** Catalog model types whose models only a plugin's operation serves. */
const OPERATION_MODEL_TYPES: ReadonlySet<string> = new Set([
  "decisions",
  "image",
])

/**
 * `models` without the operation-type models nothing serves right now.
 * `served` is undefined when no plugin gateway is running (nothing is
 * filtered then: this process doesn't serve plugins).
 */
export function withoutUnservedModels(
  models: Array<Model>,
  served: ReadonlyArray<ServedModel> | undefined,
): Array<Model> {
  if (!served) return models
  const upstreamIds = new Set(
    served
      .filter((entry) => entry.provider === COPILOT_PROVIDER_ID)
      .map((entry) => entry.upstreamModel),
  )
  return models.filter(
    (model) =>
      !OPERATION_MODEL_TYPES.has(model.capabilities.type)
      || upstreamIds.has(model.id),
  )
}
