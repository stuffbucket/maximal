/**
 * The relay specs shared by the HTTP operations and the tools that dispatch
 * the same operations: where each goes upstream and how its usage reads.
 */
import type { RelaySpec } from "@stuffbucket/maximal-plugin-sdk"

import { responsesUsage } from "@stuffbucket/maximal-plugin-sdk"

export const GENERATIONS_PATH = "/v1/images/generations"
export const EDITS_PATH = "/v1/images/edits"

export const GENERATIONS_SPEC: RelaySpec = {
  path: GENERATIONS_PATH,
  errorMessage: "Failed to generate images",
  usage: (reply) => responsesUsage(reply.usage),
}

export const EDITS_SPEC: RelaySpec = {
  path: EDITS_PATH,
  errorMessage: "Failed to edit images",
  usage: (reply) => responsesUsage(reply.usage),
}
