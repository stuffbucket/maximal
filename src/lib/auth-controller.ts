/**
 * In-memory state machine for the GitHub device-code auth flow,
 * driven on-demand by the Settings UI via /settings/api/auth/github/*.
 *
 * Distinct from `src/lib/token.ts`'s `setupGitHubToken`, which is the
 * legacy boot-time path: it opens the browser, copies to clipboard,
 * and blocks the calling promise until the poll completes. The
 * controller below does none of those — it returns immediately,
 * exposes the user_code/verification_uri to the client, and runs a
 * non-blocking poller in the background. The shell renders whatever
 * UI it likes with that data; nothing here decides for it.
 *
 * State model (boundary D3): the controller holds ONE `AuthState`
 * discriminated union — the set of representable states equals the set
 * of valid states. `getAuthStatus()` is an exhaustive switch over it,
 * not a reconstruction from independent nullables. Phase 3 will add a
 * single `transition(state, event)` reducer + effect-runner on top of
 * this; for now the writers below set the union directly.
 *
 *   signed-out
 *       │ startDeviceFlow()
 *       ▼
 *   device-issued ──poll started──▶ polling
 *                                     │
 *                   ┌─────────────────┼─────────────┐
 *                   ▼                 ▼             ▼
 *               signed-in          error      (signOut)
 *                   │                 │             │
 *                   └──── signOut ────┴─────────────┘
 *                                ▼
 *                            signed-out
 *
 * Single-flight guarantee: at most one poller runs at any moment.
 * Calling startDeviceFlow() while a non-expired flow is active is
 * idempotent — same code returned, no second poller spawned.
 */

import type { DeviceCodeResponse } from "~/services/github/get-device-code"

import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken as defaultPollAccessToken } from "~/services/github/poll-access-token"

import type { ParsedCopilotError } from "./copilot-error-parser"
import type { AuthStatus } from "./settings-types"

import { CopilotAuthFatalError } from "./error"
import { currentGitHubHost } from "./github-host"
import {
  addAccountToDefaultRegistry as defaultAddAccount,
  deactivateActiveInDefaultRegistry as defaultDeactivateActive,
  makeAccountRecord,
  markActiveNeedsReauthInDefaultRegistry as defaultMarkActiveNeedsReauth,
} from "./github-token-store"
import { createTeeLogger } from "./logger"
import { PATHS } from "./paths"
import { registerProcessCleanup } from "./process-cleanup"
import { emitAuthChanged, registerAuthStatusProjector } from "./settings-events"
import { clearLastUpstreamRejection, state } from "./state"
import { setupCopilotToken, stopCopilotRefreshLoop } from "./token"

// Auth events go to the console AND a dated `auth-*.log` so they're observable
// after the fact (sign-in, degrade, refresh failures, sign-out) instead of
// vanishing into the dev terminal's stderr.
const log = createTeeLogger("auth")

// Dependency-injection shim for tests. Process-wide `mock.module` for
// these modules leaks into sibling test files (poll-access-token.test.ts,
// github-token-store.test.ts), so the test suite overrides these
// references via __setAuthControllerDepsForTests instead — keeping the
// module registry untouched. Production callers don't see this layer.
let pollAccessToken: typeof defaultPollAccessToken = defaultPollAccessToken
let addAccount: typeof defaultAddAccount = defaultAddAccount
let deactivateActiveAccount: typeof defaultDeactivateActive =
  defaultDeactivateActive
let markActiveNeedsReauth: typeof defaultMarkActiveNeedsReauth =
  defaultMarkActiveNeedsReauth

export interface AuthControllerTestDeps {
  pollAccessToken?: typeof defaultPollAccessToken
  addAccount?: typeof defaultAddAccount
  deactivateActiveAccount?: typeof defaultDeactivateActive
  markActiveNeedsReauth?: typeof defaultMarkActiveNeedsReauth
}

export function __setAuthControllerDepsForTests(
  overrides: AuthControllerTestDeps,
): void {
  if (overrides.pollAccessToken !== undefined) {
    pollAccessToken = overrides.pollAccessToken
  }
  if (overrides.addAccount !== undefined) {
    addAccount = overrides.addAccount
  }
  if (overrides.deactivateActiveAccount !== undefined) {
    deactivateActiveAccount = overrides.deactivateActiveAccount
  }
  if (overrides.markActiveNeedsReauth !== undefined) {
    markActiveNeedsReauth = overrides.markActiveNeedsReauth
  }
}

function resetAuthControllerDeps(): void {
  pollAccessToken = defaultPollAccessToken
  addAccount = defaultAddAccount
  deactivateActiveAccount = defaultDeactivateActive
  markActiveNeedsReauth = defaultMarkActiveNeedsReauth
}

/**
 * The signed-in identity a device flow should fall back to if it is
 * cancelled or expires WITHOUT completing. Captured when a flow starts
 * while already authenticated ("sign in as a different account"), so an
 * abandoned attempt never drops the user from their current account.
 * `null` when the flow started from a signed-out / error / first-run state.
 */
type ResumeTarget = {
  login: string
  avatarUrl?: string
  connectedSinceMs?: number
} | null

interface ActiveFlow {
  deviceCode: DeviceCodeResponse
  expiresAt: number
  abort: AbortController
  resume: ResumeTarget
}

/**
 * The resume identity a newly-started flow should carry. Restarting an
 * expired flow inherits the prior flow's resume; otherwise we remember the
 * currently signed-in account (if any). A flow started from signed-out /
 * error / first-run carries no resume.
 */
function captureResumeTarget(existing: ActiveFlow | null): ResumeTarget {
  if (existing) return existing.resume
  return authState.kind === "signed-in" ?
      {
        login: authState.login,
        avatarUrl: authState.avatarUrl,
        connectedSinceMs: authState.connectedSinceMs,
      }
    : null
}

/**
 * The auth lifecycle as a closed set of states (boundary D3). Each
 * variant carries exactly the data valid in that state, so impossible
 * combinations (e.g. a user_code while authenticated, or polling with
 * no flow) are unrepresentable. `device-issued` vs `polling` is the
 * variant itself — not a boolean on a shared struct. The `error`
 * variant covers both a terminal poll failure (expired/denied) and a
 * Copilot auth-fatal rejection; both report as `state: "error"`.
 */
type AuthState =
  | { kind: "signed-out" }
  | { kind: "device-issued"; flow: ActiveFlow }
  | { kind: "polling"; flow: ActiveFlow }
  | {
      kind: "signed-in"
      login: string
      /** GitHub profile photo URL (`avatar_url`) when known. */
      avatarUrl?: string
      /** Epoch ms when this session became authenticated, for the uptime line. */
      connectedSinceMs?: number
    }
  | ({ kind: "error" } & ParsedCopilotError)

let authState: AuthState = { kind: "signed-out" }

/**
 * The single writer for `authState`. Assigns the new union value, then
 * publishes the projected wire status on the settings event bus so the
 * SSE route (ADR-0007) can push it to the shell the instant it changes —
 * no poll latency. Every transition routes through here so a new state
 * can't be added that silently fails to notify the UI; that omission was
 * the polling era's core fragility. Publishing is synchronous and
 * best-effort: a bus with no subscriber (cold boot, CLI-only) is a no-op.
 *
 * Test reset (`__resetAuthControllerForTests`) assigns directly, on
 * purpose — resetting fixtures must not fan out to real subscribers.
 */
function setAuthState(next: AuthState): void {
  authState = next
  emitAuthChanged()
}

/** The active device-code flow, if the current state has one. */
function currentFlow(): ActiveFlow | null {
  return authState.kind === "device-issued" || authState.kind === "polling" ?
      authState.flow
    : null
}

function isFlowExpired(flow: ActiveFlow, nowMs: number = Date.now()): boolean {
  return flow.expiresAt <= nowMs
}

/** Build the optional `account_avatar_url` / `connected_since` fields shared by
 *  the two authenticated emit sites (live session + expired-flow resume). Each
 *  is omitted when unknown so the contract stays clean rather than carrying
 *  empty strings. */
function authenticatedExtras(source: {
  avatarUrl?: string
  connectedSinceMs?: number
}): { account_avatar_url?: string; connected_since?: string } {
  return {
    ...(source.avatarUrl ? { account_avatar_url: source.avatarUrl } : {}),
    ...(source.connectedSinceMs ?
      { connected_since: new Date(source.connectedSinceMs).toISOString() }
    : {}),
  }
}

export function getAuthStatus(): AuthStatus {
  // The upstream-rejection sidecar rides along on the two states where a
  // completion attempt is meaningful: `unauthenticated` (banner persists
  // across a stale sign-out so the user can see why) and `authenticated`
  // (the live banner). The pending and error variants don't carry it —
  // the token-state issue takes precedence in the UI. signOut() and a
  // fresh sign-in both clear it.
  const rejection = state.lastUpstreamRejection
  const rejectionPayload =
    rejection ?
      {
        last_upstream_rejection: {
          message: rejection.message,
          status: rejection.status,
          at: rejection.at,
          ...(rejection.remediationUrl ?
            { remediation_url: rejection.remediationUrl }
          : {}),
        },
      }
    : {}

  switch (authState.kind) {
    case "signed-in": {
      // `login` is required on the signed-in variant — the only writers
      // (runPoller and markSignedIn) take a real string. No fallback,
      // no "unknown" sentinel: by construction we know who the user is.
      return {
        state: "authenticated",
        account_login: authState.login,
        ...authenticatedExtras(authState),
        ...rejectionPayload,
      }
    }

    case "error": {
      return {
        state: "error",
        error: authState.message,
        ...(authState.remediationUrl ?
          { remediation_url: authState.remediationUrl }
        : {}),
      }
    }

    case "device-issued":
    case "polling": {
      const flow = authState.flow
      if (isFlowExpired(flow)) {
        // Stale flow the poller hasn't cleared yet (terminal path lost a
        // race). Fall back to the resume identity if this flow was started
        // over an existing session, so we don't flash "unauthenticated" at a
        // still-signed-in user; otherwise report unauthenticated.
        if (flow.resume) {
          return {
            state: "authenticated",
            account_login: flow.resume.login,
            ...authenticatedExtras(flow.resume),
            ...rejectionPayload,
          }
        }
        return { state: "unauthenticated", ...rejectionPayload }
      }
      return {
        state: authState.kind === "polling" ? "polling" : "device_code_issued",
        user_code: flow.deviceCode.user_code,
        verification_uri: flow.deviceCode.verification_uri,
        expires_at: new Date(flow.expiresAt).toISOString(),
      }
    }

    case "signed-out": {
      return { state: "unauthenticated", ...rejectionPayload }
    }

    default: {
      // Exhaustive: every AuthState.kind is handled above. `satisfies never`
      // makes a newly-added variant a compile error rather than a silent
      // fall-through.
      authState satisfies never
      return { state: "unauthenticated", ...rejectionPayload }
    }
  }
}

// Wire the controller's status projection into the settings event bus so any
// producer — including state.ts, when the upstream-rejection sidecar changes
// mid-session — can publish the canonical auth.changed snapshot without
// importing this module (which would form a cycle through `state`).
registerAuthStatusProjector(getAuthStatus)

export async function startDeviceFlow(): Promise<AuthStatus> {
  const existing = currentFlow()
  if (existing && !isFlowExpired(existing)) {
    // Idempotent: re-return the in-flight code. No new poller — the
    // existing one is still running.
    return {
      state: "device_code_issued",
      user_code: existing.deviceCode.user_code,
      verification_uri: existing.deviceCode.verification_uri,
      expires_at: new Date(existing.expiresAt).toISOString(),
    }
  }

  // Capture the identity to fall back to if this flow is cancelled or
  // expires. If we're restarting an expired flow, carry its resume forward;
  // otherwise remember the current signed-in account. Issuing a code must
  // NOT sign the user out — the existing session (token + on-disk record)
  // stays intact and keeps serving until this flow SUCCEEDS, the user cancels
  // (→ resume restored), or they explicitly sign out.
  const resume = captureResumeTarget(existing)

  // Cancel any stale flow before requesting a fresh code so the status
  // reporter never sees a half-cleared state. Note: we do NOT reset
  // authState to signed-out here — that was the bug that dropped a
  // signed-in user the moment they asked for a new code.
  if (existing) {
    existing.abort.abort()
  }

  const deviceCode = await getDeviceCode()
  const abort = new AbortController()
  const flow: ActiveFlow = {
    deviceCode,
    expiresAt: Date.now() + deviceCode.expires_in * 1000,
    abort,
    resume,
  }
  // Single-flight: startDeviceFlow is serialized by the idempotency guard
  // above; no concurrent caller mutates authState between the await and here.

  authState = { kind: "device-issued", flow }

  // Fire-and-forget poller. Errors are captured into authState so the
  // next getAuthStatus call surfaces them; never rethrown.
  runPoller(flow).catch((err: unknown) => {
    log.error("Auth-controller poller crashed unexpectedly:", err)
  })

  // Emit once the flow is fully installed (code + poller live), so the
  // first event the shell sees is a complete device_code_issued status.
  emitAuthChanged()

  return {
    state: "device_code_issued",
    user_code: deviceCode.user_code,
    verification_uri: deviceCode.verification_uri,
    expires_at: new Date(flow.expiresAt).toISOString(),
  }
}

/**
 * Cancel an in-flight device-code flow WITHOUT signing out. Aborts the
 * poller and returns to wherever the flow started from: the prior signed-in
 * account if there was one (so "sign in as a different account" → Cancel
 * keeps you on your current account), otherwise signed-out (first-run
 * cancel → the sign-in screen). The existing token/registry were never
 * touched by starting the flow, so the restored session is fully live.
 *
 * No-op (returns the current status) when there is no active flow.
 */
export function cancelDeviceFlow(): AuthStatus {
  const flow = currentFlow()
  if (!flow) return getAuthStatus()
  flow.abort.abort()
  setAuthState(
    flow.resume ?
      {
        kind: "signed-in",
        login: flow.resume.login,
        avatarUrl: flow.resume.avatarUrl,
        connectedSinceMs: flow.resume.connectedSinceMs,
      }
    : { kind: "signed-out" },
  )
  return getAuthStatus()
}

// Single-flight by construction: this is only invoked from
// startDeviceFlow() after a fresh AbortController is installed on a
// fresh ActiveFlow. The "race condition" the linter flags is the
// intentional single-flight + cancellation pattern — abort() is the
// only thing that signals cancellation, and we re-read it after each
// await before touching shared state.

/**
 * Where a failed or abandoned flow lands. If the flow was started over an
 * existing session (resume set), restore that account — an additional
 * sign-in that didn't pan out must never sign the user out. Otherwise fall
 * through to the supplied error state (first-run / signed-out origin).
 */
function flowFailureState(
  flow: ActiveFlow,
  fallbackError: ParsedCopilotError,
): AuthState {
  return flow.resume ?
      {
        kind: "signed-in",
        login: flow.resume.login,
        avatarUrl: flow.resume.avatarUrl,
        connectedSinceMs: flow.resume.connectedSinceMs,
      }
    : { kind: "error", ...fallbackError }
}

/* eslint-disable @typescript-eslint/no-unnecessary-condition -- TS can't see that abort.signal.aborted may flip during an await. */
async function runPoller(flow: ActiveFlow): Promise<void> {
  if (flow.abort.signal.aborted) return
  setAuthState({ kind: "polling", flow })

  try {
    // pollAccessToken loops internally with the server-told interval,
    // honouring slow_down and authorization_pending. It resolves on
    // success and throws on expired_token / access_denied.
    const token = await pollAccessToken(flow.deviceCode)

    if (flow.abort.signal.aborted) return

    // Resolve the login BEFORE persisting so the account is keyed by its real
    // `login@host` and the user sees who they signed in as. A failure here
    // means we have a working token but can't verify whose token it is —
    // persisting and claiming `authenticated` under that state is incoherent
    // (the registry would gain an `unknown@github.com` row, future sign-ins
    // would duplicate it, and the UI would say "Signed in as ?" forever).
    //
    // Surface as an error and let the user retry. The token is dropped from
    // memory (we never wrote it to state.githubToken or disk); a retry runs
    // the device flow fresh. UX cost: one repeat of the code-copy step on a
    // transient github.com blip — recoverable in seconds. The alternative
    // (a `verifying` state with bounded retries) is the natural extension if
    // this turns out to fire too often in practice; see ADR-0006 carve-out.
    let login: string
    let avatarUrl: string | undefined
    try {
      const user = await getGitHubUser(token)
      login = user.login
      avatarUrl = user.avatar_url
      state.userName = user.login
    } catch (err) {
      if (flow.abort.signal.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      log.warn(
        "Auth-controller: failed to verify GitHub account after sign-in:",
        message,
      )
      setAuthState(
        flowFailureState(flow, {
          message: "Couldn't verify your GitHub account. Try signing in again.",
          remediationUrl: null,
        }),
      )
      return
    }

    // Re-check abort: getGitHubUser is an awaited round-trip during which
    // signOut() may have fired. Don't persist/expose a token the user cleared.
    if (flow.abort.signal.aborted) return

    await addAccount(
      makeAccountRecord({
        login,
        host: currentGitHubHost(),
        token,
        addedVia: "device-code",
      }),
    )
    state.githubToken = token

    // Best-effort: proactively mint the Copilot token so Diagnostics
    // doesn't surface the intermediate "github present, copilot absent"
    // state. Failure (no Copilot license, network down, upstream 5xx)
    // must NOT fail sign-in — the lazy path in token.ts retries on the
    // first /v1/messages request via setupCopilotToken's TTL refresh.
    try {
      await setupCopilotToken()
    } catch (err) {
      if (err instanceof CopilotAuthFatalError) {
        // The account authenticated with GitHub but has no usable Copilot
        // (license revoked, TOS not accepted, 401/403). setupCopilotToken
        // already routed this through markAuthFatalAndSignOut, which wiped
        // the token + on-disk record and set authState to the fatal error
        // (with its remediation URL). Returning preserves that — falling
        // through to signed-in would paper a "signed in" UI over a wiped
        // token and bury the reason the user needs to act on.
        return
      }
      log.warn(
        "Auth-controller: failed to mint Copilot token after sign-in:",
        err,
      )
    }

    // Re-check abort: setupCopilotToken is an awaited round-trip during which
    // signOut() may have fired and wiped the token. Don't latch signed-in over
    // a just-cleared session.
    if (flow.abort.signal.aborted) return
    setAuthState({
      kind: "signed-in",
      login,
      avatarUrl,
      connectedSinceMs: Date.now(),
    })
  } catch (err) {
    if (flow.abort.signal.aborted) return
    const message = err instanceof Error ? err.message : String(err)
    setAuthState(flowFailureState(flow, { message, remediationUrl: null }))
    log.warn("Auth-controller: device-code poll terminated:", message)
  }
}
/* eslint-enable @typescript-eslint/no-unnecessary-condition */

/**
 * Mark the session signed-in from a token resolved OUTSIDE the device
 * flow (cold boot / `--github-token` / CLI `auth`). The completion host,
 * Copilot token, and models are populated by the caller (bootstrapUpstream
 * → logUser/setupCopilotToken/cacheModels); this only records the auth
 * status so getAuthStatus reports `authenticated` after a restart. The
 * caller MUST have already resolved a real GitHub login (e.g. via
 * logUser()) — there is no "unknown" sentinel; an unknown identity is
 * an error state, not an authenticated one.
 */
export function markSignedIn(login: string, avatarUrl?: string): void {
  noteAuthSuccess()
  setAuthState({
    kind: "signed-in",
    login,
    avatarUrl,
    connectedSinceMs: Date.now(),
  })
}

/**
 * Mark the session signed-out WITHOUT touching the operational token state
 * or the on-disk record (unlike `signOut`). For the cold-boot degrade path:
 * Copilot bootstrap failed transiently, the in-memory token was cleared, but
 * the on-disk token is kept for a next-restart retry. Makes that bootstrap
 * exit set the union explicitly, like the success (`markSignedIn`) and fatal
 * (`markAuthFatalAndSignOut`) exits do, rather than relying on the union
 * still sitting at its initial value.
 */
export function markSignedOut(): void {
  setAuthState({ kind: "signed-out" })
}

export async function signOut(): Promise<void> {
  // Cancel any active poller first so it can't race the token wipe.
  const flow = currentFlow()
  if (flow) {
    flow.abort.abort()
  }
  state.githubToken = undefined
  state.copilotToken = undefined
  state.userName = undefined
  // A signed-out session has no upstream activity to surface a banner
  // about. Clear here so the sidecar doesn't outlive the token that
  // produced it.
  clearLastUpstreamRejection()
  // Set the union LAST, after the token + rejection are cleared, so the
  // auth.changed snapshot the shell receives reflects the fully signed-out
  // state (no stale rejection riding along on the unauthenticated event).
  setAuthState({ kind: "signed-out" })

  // Deactivate the active account but RETAIN its record (gh-CLI rule: a sign-
  // out should not erase the identity). Dropping the active pointer makes the
  // next boot unauthenticated, while the retained record lets the signed-out UI
  // name the account and offer reconnect. True deletion is the explicit
  // "forget account" action (/accounts/remove), never an implicit side effect.
  try {
    await deactivateActiveAccount()
  } catch (err) {
    log.warn("Auth-controller: failed to update account registry:", err)
  }

  // Delete the legacy single-record file. readDefaultRecord falls back to it
  // when the registry has no ACTIVE account (which is exactly our just-
  // deactivated state), so leaving a token here would resurrect the session on
  // the next boot. Tolerant of "already gone".
  try {
    const fs = await import("node:fs/promises")
    await fs.unlink(PATHS.GITHUB_TOKEN_PATH)
  } catch (err) {
    if (
      typeof err === "object"
      && err !== null
      && "code" in err
      && (err as { code: string }).code !== "ENOENT"
    ) {
      log.warn("Auth-controller: failed to delete token file:", err)
    }
  }
}

// Auto-recovery hook. DORMANT by default: bootstrap registers a sweep only when
// config.autoRecoverAccount is enabled (auto-switching identity needs prior user
// consent). null otherwise → markAuthDegraded falls through to the error state.
let autoRecover: (() => Promise<boolean>) | null = null
// Single-flight + grace-window state for markAuthDegraded.
let degradeInFlight: Promise<void> | null = null
let lastAuthSuccessMs = 0
const RECOVERY_GRACE_MS = 3000

/** Register an auto-recovery sweep to run before markAuthDegraded gives up.
 *  Called by bootstrap only when config.autoRecoverAccount is enabled. */
export function registerAutoRecovery(fn: () => Promise<boolean>): void {
  autoRecover = fn
}

/** Record that a credential just worked (sign-in / live switch / boot mint), so
 *  a stale 401 from a request that was in flight under the OLD token doesn't
 *  tear the fresh session down (see the grace window in markAuthDegraded). */
export function noteAuthSuccess(): void {
  lastAuthSuccessMs = Date.now()
}

/**
 * React to a CopilotAuthFatalError (GHCP 401/403) WITHOUT destroying the
 * GitHub credential. This is the load-bearing fix: the old behaviour ran a
 * full `signOut()` here — deleting the on-disk account — so a single transient
 * rejection on ANY completion, refresh, or first-mint forced a fresh device-
 * code login. Per the gh-CLI rule (failure ≠ deletion):
 *
 *   - stop the refresh loop + drop the LIVE Copilot/GitHub tokens, so we fail
 *     fast instead of hammering a known-bad token;
 *   - FLAG the active account `needsReauth` on disk (record + token RETAINED),
 *     so the UI can name it and offer reconnect, and a restart re-attempts the
 *     same credential (a transient rejection self-heals);
 *   - surface the upstream message + remediation URL via the error state.
 *
 * Genuine, non-transient rejections are handled by zero-click auto-recovery
 * (Phase 2 — try another known-good account live) and, failing that, the UI;
 * none of those paths delete the credential either. Only an explicit user
 * "forget account" removes a record.
 */
export function markAuthDegraded(error: CopilotAuthFatalError): Promise<void> {
  // Single-flight: forwardError fires one of these per failing completion, so a
  // burst of concurrent auth-fatals must coalesce into ONE degrade+recovery
  // sweep rather than each clearing tokens / racing a recovery.
  if (degradeInFlight) return degradeInFlight
  // Grace window: a 401 arriving right after a successful (re)auth is almost
  // certainly the response to a request that was in flight under the OLD token.
  // Don't tear down the freshly-recovered/just-signed-in session for it.
  if (Date.now() - lastAuthSuccessMs < RECOVERY_GRACE_MS)
    return Promise.resolve()
  degradeInFlight = runDegrade(error).finally(() => {
    degradeInFlight = null
  })
  return degradeInFlight
}

async function runDegrade(error: CopilotAuthFatalError): Promise<void> {
  // Cancel any in-flight device-code poller so it can't latch signed-in over
  // the degraded state after this returns (the old signOut() path did this).
  const flow = currentFlow()
  if (flow) {
    flow.abort.abort()
  }

  stopCopilotRefreshLoop()
  state.copilotToken = undefined
  state.githubToken = undefined
  state.userName = undefined

  // Idempotency: once we're already in the matching error state the account is
  // flagged and the UI notified — skip the redundant accounts.json write + SSE
  // emission. (In-memory tokens are cleared above on every call.)
  if (authState.kind === "error" && authState.message === error.message) {
    return
  }

  // Flag the (currently-active) account needs-reauth, RETAINING its credential.
  try {
    await markActiveNeedsReauth({
      status: error.status,
      message: error.message,
      at: new Date().toISOString(),
    })
  } catch (err) {
    log.warn(
      "Auth-controller: failed to flag account needs-reauth (credential retained):",
      err,
    )
  }

  // Optional recovery sweep before giving up. Registered only when the user
  // opted into config.autoRecoverAccount; otherwise `autoRecover` is null and we
  // fall straight through to the error state and surface the reason.
  if (autoRecover) {
    try {
      const recovered = await autoRecover()
      if (recovered) {
        log.info(
          "Auto-recovered onto a known-good account; no sign-out required.",
        )
        return
      }
    } catch (err) {
      log.warn("Auth-controller: auto-recovery sweep failed:", err)
    }
  }

  setAuthState({
    kind: "error",
    message: error.message,
    remediationUrl: error.remediationUrl,
  })
}

/** Cancel any active poller. Wired into process-cleanup at module
 *  load so SIGINT/SIGTERM unblocks the runtime even when a device-code
 *  poll is mid-sleep. (pollAccessToken's internal sleep doesn't accept
 *  a signal, so the loop continues until the next iteration — but the
 *  abort flag prevents the resolved/rejected branch from writing token
 *  state after the process has begun shutting down.) */
function stopAuthController(): void {
  const flow = currentFlow()
  if (flow) {
    flow.abort.abort()
  }
}

registerProcessCleanup(stopAuthController)

/** Test-only reset. NOT exported from a barrel — keep import paths
 *  long-tail so production code doesn't reach for it. */
export function __resetAuthControllerForTests(): void {
  const flow = currentFlow()
  if (flow) {
    flow.abort.abort()
  }
  authState = { kind: "signed-out" }
  resetAuthControllerDeps()
  // Reset the degrade single-flight / grace-window / recovery-hook state so it
  // can't leak across cases (a prior markSignedIn must not let the grace window
  // suppress a fresh test's degrade).
  degradeInFlight = null
  lastAuthSuccessMs = 0
  autoRecover = null
  // getAuthStatus falls back to state.userName for a signed-in session
  // (so cold-boot from a stored token populates the Account UI). Tests
  // reset state.githubToken between cases; reset the cached userName here
  // too so the fallback doesn't leak across them.
  state.userName = undefined
}
