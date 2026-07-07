import { randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/services/copilot/get-models"

import type { AccountType, CopilotHost } from "./auth-types"

import { SingletonCache } from "./cache"
import { emitAuthChanged } from "./settings-events"

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

  accountType: AccountType
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

  copilotApiUrl?: CopilotHost

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

// ── Token trio: single owner ────────────────────────────────────────────────
// `githubToken`, `copilotToken`, and `userName` are the "token trio" — the
// identity/credential fields that describe the current sign-in. They move
// together (a sign-in populates them, a sign-out/eviction clears them), so this
// module is their single owner: every write goes through the setters/clear
// below and every presence check goes through the accessors below. Callers must
// not assign `state.githubToken` / `state.copilotToken` / `state.userName`
// directly. (Token *attachment* to upstream requests still lives only in
// send-request.ts per ADR-0001 — this owner governs the in-memory trio, not the
// wire.)

export function setGithubToken(token: string): void {
  state.githubToken = token
}

export function setCopilotToken(token: string): void {
  // Skip the metric refresh when the upstream returned the same token —
  // otherwise the refresh counter inflates with no-op rotations.
  if (state.copilotToken === token) return
  state.copilotToken = token
  copilotTokenCache.set(token)
}

export function setUserName(name: string): void {
  state.userName = name
}

/**
 * Clear the whole token trio. Behaviour-preserving replacement for the
 * scattered three-line `state.githubToken = state.copilotToken =
 * state.userName = undefined` blocks in signOut / markAuthFatalAndSignOut /
 * auto-recovery. Does NOT touch the Copilot-token metric mirror (the previous
 * code didn't either — the mirror is a monotonic refresh counter, not a live
 * presence flag) and does NOT stop the refresh loop or emit auth events; those
 * remain the caller's responsibility so refresh/eviction semantics are
 * unchanged.
 *
 * `fields` selects which of the three to clear (default: all). This lets the
 * callers that intentionally clear only a subset (e.g. bootstrap's
 * github+copilot degrade, or the test reset that only resets userName) express
 * that without re-introducing direct assignment.
 */
export function clearTokenTrio(
  fields: { github?: boolean; copilot?: boolean; userName?: boolean } = {
    github: true,
    copilot: true,
    userName: true,
  },
): void {
  if (fields.github) state.githubToken = undefined
  if (fields.copilot) state.copilotToken = undefined
  if (fields.userName) state.userName = undefined
}

// ── Shared presence accessors ────────────────────────────────────────────────
// The "is a token present?" predicate was re-derived inline at 4+ HTTP surfaces
// (`status.ts`, `settings/api.ts`, `debug/route.ts`) and gated internal call
// sites. Route them all through these so the notion of "present" has one
// definition. Matches the prior `!== undefined` semantics exactly.

export function hasGithubToken(): boolean {
  return state.githubToken !== undefined
}

export function hasCopilotToken(): boolean {
  return state.copilotToken !== undefined
}

/** Unified presence snapshot for the diagnostics/status surfaces. */
export function tokenPresence(): { github: boolean; copilot: boolean } {
  return { github: hasGithubToken(), copilot: hasCopilotToken() }
}

/** Number of models currently cached (0 before the first `setModels`).
 *  Replaces the `state.models?.data.length ?? 0` re-derived at 3 sites. */
export function modelsCached(): number {
  return state.models?.data.length ?? 0
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
  // The rejection sidecar rides on the auth status (getAuthStatus folds it
  // in). Push the change so a shell on the live SSE channel updates the
  // banner immediately, rather than waiting for the next auth transition or
  // a focus refresh. Reached only on an actual change (same-content updates
  // returned above), so the hot request path doesn't spam the stream.
  emitAuthChanged()
}

/** Clear the upstream-rejection sidecar. Called from each create-*.ts on
 *  successful upstream response, and via signOut. */
export function clearLastUpstreamRejection(): void {
  // Guard the emit on an actual change: clears run on EVERY successful
  // completion, but only the first one after a rejection should fan out an
  // auth.changed (the rest are no-ops). Without this the SSE stream would
  // get an event per successful request.
  const hadRejection = state.lastUpstreamRejection !== undefined
  state.lastUpstreamRejection = undefined
  if (hadRejection) {
    emitAuthChanged()
  }
}

/** When the models cache was last populated, in epoch ms. `null`
 *  before the first successful `setModels`. Exported as an accessor
 *  rather than the cache itself so the staleness checker can't poke
 *  at the cache's other internals. */
export function getModelsLoadedAtMs(): number | null {
  return modelsCache.metrics().loaded_at_ms
}
