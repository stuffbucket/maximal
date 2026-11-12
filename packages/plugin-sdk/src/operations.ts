/**
 * Model operations: what a capability plugin serves through `ctx.operations`
 * and what the app core dispatches to through the gateway's `OperationDispatch`.
 * Interfaces only; the registry itself is `runtime/operations.ts`.
 */
import type { PluginDisposer } from "./types"

declare module "./types" {
  interface AppServices {
    operations: OperationRegistry
  }
}

/** The model operations plugins can serve. Chat flows stay in the core. */
export const MODEL_OPERATIONS = [
  "systemone",
  "decisions",
  "images.generations",
  "images.edits",
] as const
export type ModelOperation = (typeof MODEL_OPERATIONS)[number]

/** Which provider serves a capability's model, and under which upstream id. */
export interface ModelBinding {
  provider: string
  upstreamModel: string
}

/**
 * What an upstream provider reports as a call's cost, in the budget unit
 * (nano-AIU for now). `estimated` when the reply carried no cost.
 */
export interface ProviderCost {
  unit: "nano_aiu"
  amount: number
  estimated: boolean
}

/** A request the core route has already parsed and admitted. */
export interface OperationRequest {
  operation: ModelOperation
  /** The model as the client named it (`"gpt-image-2.5-flare"` or `"copilot/gpt-image-2.5-flare"`). */
  model: string
  /** The binding core resolved it to. */
  binding: ModelBinding
  /** JSON body, or the client's multipart form for `images.edits`. Relayed as-is. */
  body: Record<string, unknown> | FormData
  signal: AbortSignal
  /** Who asked (for usage rows and budget scopes). */
  origin:
    | { kind: "http"; client: string }
    | { kind: "server-tool"; tool: string; sessionId?: string }
}

export interface OperationResult {
  /** Relayed to the HTTP client unchanged. */
  json: Record<string, unknown>
  /** Normalized usage plus the provider's cost in the budget unit. */
  usage: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    /** The upstream's own total, when it reports one. */
    total_tokens?: number
  }
  cost?: ProviderCost
}

/** Registered by a capability plugin, for one operation and its bindings. */
export interface OperationHandler {
  operation: ModelOperation
  /** Client-facing model ids served through these bindings. */
  bindings: ReadonlyArray<{ model: string } & ModelBinding>
  handle(request: OperationRequest): Promise<OperationResult>
}

/**
 * cordis service `operations`. Registrations are bound to the calling plugin's
 * fiber and withdrawn when it is disposed (or when the returned disposer runs).
 * A duplicate `(operation, provider, upstreamModel)` throws `PluginContractError`.
 */
export interface OperationRegistry {
  register(handler: OperationHandler): PluginDisposer
}

/** One served model, as `OperationDispatch.servedModels` lists it. */
export type ServedModel = {
  model: string
  operations: ReadonlyArray<ModelOperation>
} & ModelBinding

/** Gateway-side (cordis-free) view of the registry for core routes. */
export interface OperationDispatch {
  /**
   * Resolves `"provider/model"` exactly. A bare model resolves only when
   * exactly one enabled binding serves it.
   */
  resolve(
    operation: ModelOperation,
    model: string,
  ): { pluginId: string; binding: ModelBinding } | undefined
  /** Throws `OperationUnavailableError` when nothing resolves. */
  dispatch(request: Omit<OperationRequest, "binding">): Promise<OperationResult>
  servedModels(): ReadonlyArray<ServedModel>
  /** Called whenever a registration is added or withdrawn. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void
}
