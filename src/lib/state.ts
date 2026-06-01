import { randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { SingletonCache } from "./cache"

// Module-private metric mirrors of the matching `state.*` fields.
// Surfaced via allCacheMetrics() (registered on construction); writes
// flow through setCopilotToken / setModels below so callers can't
// forget the mirror.
const modelsCache = new SingletonCache<ModelsResponse>({ name: "models" })
const copilotTokenCache = new SingletonCache<string>({ name: "copilot_token" })

export interface State {
  githubToken?: string
  userName?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  macMachineId?: string
  vsCodeSessionId?: string
  vsCodeDeviceId: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number
  verbose: boolean

  copilotApiUrl?: string

  /**
   * Set by the Tauri shell at sidecar spawn (env var MAXIMAL_SHELL_KEY).
   * When a request carries this exact key, auth always succeeds — even
   * if the user has flipped "Block unknown connections" on. Lets the
   * shell webview talk to its own backend without locking the user out.
   * Empty/undefined when the sidecar runs standalone (CLI).
   */
  shellApiKey?: string

  /**
   * Last non-fatal upstream rejection from a Copilot completion endpoint
   * (/v1/messages, /v1/chat/completions, /responses). Set when a 4xx/5xx
   * comes back from upstream that ISN'T an auth-fatal (auth-fatal is
   * routed through `markAuthFatalAndSignOut` and clears the token). Cleared
   * on the next successful completion. Surfaced to the Settings UI via
   * `/settings/api/auth/github/status` so the user can see "your quota is
   * exhausted" / "this model isn't on your plan" without the proxy
   * pretending the token is dead.
   *
   * The shape mirrors what the Settings UI shows — `at` is the wall-clock
   * timestamp of the rejection so a future request that succeeds (and
   * clears this) can be distinguished from a stale entry by inspection.
   */
  lastUpstreamRejection?: {
    message: string
    remediationUrl: string | null
    status: number
    at: string
  }
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  verbose: false,
  vsCodeDeviceId: randomUUID(),
  shellApiKey: process.env.MAXIMAL_SHELL_KEY?.trim() || undefined,
}

export function setCopilotToken(token: string): void {
  // Skip the metric refresh when the upstream returned the same token —
  // otherwise the refresh counter inflates with no-op rotations.
  if (state.copilotToken === token) return
  state.copilotToken = token
  copilotTokenCache.set(token)
}

export function setModels(models: ModelsResponse): void {
  state.models = models
  modelsCache.set(models)
}

/**
 * Set the upstream-rejection sidecar after a non-fatal upstream failure.
 * Called from each create-*.ts service when the response is non-OK and
 * the body doesn't match auth-fatal markers. Idempotent on same-content
 * updates (avoids needlessly bumping `at` when the same rejection keeps
 * arriving, which would re-fire UI transitions).
 */
export function setLastUpstreamRejection(rejection: {
  message: string
  remediationUrl: string | null
  status: number
}): void {
  const existing = state.lastUpstreamRejection
  if (
    existing
    && existing.message === rejection.message
    && existing.remediationUrl === rejection.remediationUrl
    && existing.status === rejection.status
  ) {
    return
  }
  state.lastUpstreamRejection = {
    ...rejection,
    at: new Date().toISOString(),
  }
}

/** Clear the upstream-rejection sidecar. Called from each create-*.ts on
 *  successful upstream response, and via signOut. */
export function clearLastUpstreamRejection(): void {
  state.lastUpstreamRejection = undefined
}

/** When the models cache was last populated, in epoch ms. `null`
 *  before the first successful `setModels`. Exported as an accessor
 *  rather than the cache itself so the staleness checker can't poke
 *  at the cache's other internals. */
export function getModelsLoadedAtMs(): number | null {
  return modelsCache.metrics().loaded_at_ms
}
