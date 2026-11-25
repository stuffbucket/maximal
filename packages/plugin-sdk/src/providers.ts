/**
 * Upstream providers: what a provider supplies (auth and transport, model
 * catalog, error advice, cost, quota windows) and the `providers` service that
 * holds them. Interfaces only; the registry is `runtime/providers.ts`.
 */
import type { ModelOperation, ProviderCost } from "./operations"
import type { PluginDisposer } from "./types"

/** The provider call an upstream error answered. */
export interface ProviderCall {
  provider?: string
  /** The endpoint path as the provider's catalog spells it. */
  endpoint: string
  model?: string
}

/** One model of a provider's catalog, as the provider reports it. */
export interface ProviderModelInfo {
  id: string
  /** The provider's own model type (`chat`, `image`, `decisions`, ...). */
  type: string
  /** Endpoint paths the model serves; empty when the catalog doesn't say. */
  endpoints: ReadonlyArray<string>
  preview: boolean
  /** Advertised per-token rates, when the provider has a price sheet. */
  prices?: Readonly<Record<string, number>>
}

/** An allowance a provider reports (cordis-free mirror of the budget window). */
export interface ProviderQuotaWindow {
  provider: string
  id: string
  label: string
  /** `credits`, `requests`, `tokens`, `percent`, or the provider's own. */
  unit: string
  used?: number
  limit?: number
  percentRemaining?: number
  /** ISO 8601; absent when the window never resets or the reset is unknown. */
  resetsAt?: string
  kind?: "fixed" | "rolling"
  durationMs?: number
  scope?: { models?: Array<string>; modelClass?: string }
  overage?: { used?: number; permitted?: boolean }
  observedAt: string
  source: "header" | "endpoint"
}

export interface ProviderInvocation {
  /** One logical operation from admission through terminal accounting. */
  invocationId: string
  /** Idempotency key for this particular provider call. */
  providerCallId: string
  /** Monotonic order within the invocation. */
  sequence: number
  operation: ModelOperation
  model: string
}

export interface ProviderRequestOptions {
  signal?: AbortSignal
  errorMessage: string
  /** Parent-issued accounting context. Provider-backed calls require it. */
  invocation: ProviderInvocation
}

export interface UpstreamProvider {
  /** `"copilot"`: namespaces model ids and usage/budget rows. */
  id: string
  displayName: string
  /**
   * Auth and transport: POST JSON (or a multipart form) to a provider path
   * and return the parsed reply. A refusal throws the app's `HTTPError` with
   * `call: { provider, endpoint, model }`, so the error rewrites and advice
   * keep working.
   */
  postJson<T>(
    path: string,
    body: Record<string, unknown> | FormData,
    options: ProviderRequestOptions,
  ): Promise<T>
  /** The catalog entry for `id`; undefined when the account/plan doesn't offer it. */
  model(id: string): ProviderModelInfo | undefined
  /** Called when the catalog is replaced. Returns an unsubscribe. */
  onCatalogChange(listener: () => void): PluginDisposer
  /** Signed in / configured right now. */
  available(): boolean
  /**
   * Provider-specific advice for a refused call: the framed message, or
   * undefined when nothing recognizes it. `text` is the upstream body as sent.
   */
  adviseError?(upstream: {
    status: number
    text: string
    call?: ProviderCall
  }): string | undefined
  /** The cost a reply reports, in the budget unit; undefined when it reports none. */
  cost(
    reply: Record<string, unknown>,
    request: { operation: string; model: string },
  ): ProviderCost | undefined
  /** The allowances the provider reports. Optional: not every provider has any. */
  quotaWindows?(): Promise<ReadonlyArray<ProviderQuotaWindow>>
  /**
   * Ask the provider for its allowances now, rather than reading what its
   * last reply carried, and return what it says (the host records it). A
   * provider with nothing to ask leaves this out; one that can't be reached
   * rejects. The host calls it at most once in 30 seconds.
   */
  refreshQuotaWindows?(): Promise<ReadonlyArray<ProviderQuotaWindow>>
}

/**
 * cordis service `providers`. The host supplies the first providers (Copilot);
 * a plugin may register more, bound to its fiber. A duplicate id throws
 * `PluginContractError`.
 */
export interface ProviderRegistry {
  register(provider: UpstreamProvider): PluginDisposer
  get(id: string): UpstreamProvider | undefined
  list(): ReadonlyArray<Pick<UpstreamProvider, "id" | "displayName">>
}

declare module "./types" {
  interface AppServices {
    providers: ProviderRegistry
  }
}
