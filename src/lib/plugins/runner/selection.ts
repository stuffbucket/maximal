import {
  PLUGIN_GENERATION_SELECTION_SCHEMA,
  RUNNER_REVERIFY_CONTRACT,
} from "@stuffbucket/maximal-plugin-loader"
import { z } from "zod"

import type { GenerationSelection } from "./contracts"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const generationSelectionSchema = z
  .object({
    token: z
      .object({
        $schema: z.literal(PLUGIN_GENERATION_SELECTION_SCHEMA),
        reverify: z.literal(RUNNER_REVERIFY_CONTRACT),
        directory: z.string().min(1),
        generationId: digest,
        manifestSha256: digest,
        artifacts: z.array(
          z
            .object({
              artifact: z.string().min(1),
              sha256: digest,
              bytes: z.number().int().nonnegative(),
            })
            .strict(),
        ),
        seal: digest,
      })
      .strict(),
    controlEpoch: z.number().int().nonnegative(),
    inventoryDigest: digest,
  })
  .strict()

export function encodeGenerationSelection(
  selection: GenerationSelection,
): string {
  return Buffer.from(JSON.stringify(selection), "utf8").toString("base64url")
}

export function decodeGenerationSelection(
  encoded: string,
): GenerationSelection {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  } catch (cause) {
    throw new Error("Runner generation selection is malformed.", { cause })
  }
  const parsed = generationSelectionSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error("Runner generation selection is malformed.", {
      cause: parsed.error,
    })
  }
  return parsed.data
}
