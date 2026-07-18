import { z } from "zod"

import { copilotHeaders, copilotBaseUrl } from "~/lib/config/api-config"
import { sendRequestJson } from "~/lib/http/send-request"
import { hasCopilotToken, state } from "~/lib/runtime-state/state"

export const createEmbeddings = async (
  payload: EmbeddingRequest,
): Promise<EmbeddingResponse> => {
  if (!hasCopilotToken()) throw new Error("Copilot token not found")

  // Deliberately unbounded (no timeoutMs): large input arrays can run long,
  // and this is not on the cold-boot critical path the timeout doc guards.
  return await sendRequestJson(
    `${copilotBaseUrl(state)}/embeddings`,
    {
      method: "POST",
      headers: copilotHeaders(state),
      body: JSON.stringify(payload),
      errorMessage: "Failed to create embeddings",
    },
    EmbeddingResponseSchema,
  )
}

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

// This response is RELAYED verbatim to the client (routes/embeddings/route.ts) —
// only `usage.prompt_tokens` is read here. So the schema is deliberately
// permissive: it documents the expected shape and replaces the old unchecked
// `as T` cast, but every field is optional and unknown fields pass through, so a
// valid-but-varying upstream embeddings response can never throw on this hot path.
const EmbeddingSchema = z
  .object({
    object: z.string(),
    embedding: z.array(z.number()),
    index: z.number(),
  })
  .partial()
  .loose()

const EmbeddingResponseSchema = z
  .object({
    object: z.string(),
    data: z.array(EmbeddingSchema),
    model: z.string(),
    usage: z
      .object({
        prompt_tokens: z.number(),
        total_tokens: z.number(),
      })
      .partial()
      .loose(),
  })
  .partial()
  .loose()

type EmbeddingResponse = z.infer<typeof EmbeddingResponseSchema>
