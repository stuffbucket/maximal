import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { authFetchJson } from "~/lib/auth-fetch"
import { state } from "~/lib/state"

export const createEmbeddings = async (payload: EmbeddingRequest) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  // Deliberately unbounded (no timeoutMs): large input arrays can run long,
  // and this is not on the cold-boot critical path the timeout doc guards.
  return await authFetchJson<EmbeddingResponse>(
    `${copilotBaseUrl(state)}/embeddings`,
    {
      method: "POST",
      headers: copilotHeaders(state),
      body: JSON.stringify(payload),
      errorMessage: "Failed to create embeddings",
    },
  )
}

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}
