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

import consola from "consola"

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
  makeAccountRecord,
  removeActiveFromDefaultRegistry as defaultRemoveActiveAccount,
} from "./github-token-store"
import { PATHS } from "./paths"
import { registerProcessCleanup } from "./process-cleanup"
import { clearLastUpstreamRejection, state } from "./state"
import { setupCopilotToken } from "./token"

// Dependency-injection shim for tests. Process-wide `mock.module` for
// these modules leaks into sibling test files (poll-access-token.test.ts,
// github-token-store.test.ts), so the test suite overrides these
// references via __setAuthControllerDepsForTests instead — keeping the
// module registry untouched. Production callers don't see this layer.
let pollAccessToken: typeof defaultPollAccessToken = defaultPollAccessToken
let addAccount: typeof defaultAddAccount = defaultAddAccount
let removeActiveAccount: typeof defaultRemoveActiveAccount =
  defaultRemoveActiveAccount

export interface AuthControllerTestDeps {
  pollAccessToken?: typeof defaultPollAccessToken
  addAccount?: typeof defaultAddAccount
  removeActiveAccount?: typeof defaultRemoveActiveAccount
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
  if (overrides.removeActiveAccount !== undefined) {
    removeActiveAccount = overrides.removeActiveAccount
  }
}

function resetAuthControllerDeps(): void {
  pollAccessToken = defaultPollAccessToken
  addAccount = defaultAddAccount
  removeActiveAccount = defaultRemoveActiveAccount
}

interface ActiveFlow {
  deviceCode: DeviceCodeResponse
  expiresAt: number
  abort: AbortController
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
  | { kind: "signed-in"; login: string | null }
  | ({ kind: "error" } & ParsedCopilotError)

let authState: AuthState = { kind: "signed-out" }

/** The active device-code flow, if the current state has one. */
function currentFlow(): ActiveFlow | null {
  return authState.kind === "device-issued" || authState.kind === "polling" ?
      authState.flow
    : null
}

function isFlowExpired(flow: ActiveFlow, nowMs: number = Date.now()): boolean {
  return flow.expiresAt <= nowMs
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
      // On cold boot logUser() populated state.userName; fall back to it
      // so the Account section never renders an empty avatar after a
      // restart. Final fallback to the literal "unknown" preserves the
      // type contract (account_login is required on the authenticated
      // variant — see settings-types.ts) when getGitHubUser failed
      // best-effort during the device flow.
      const login = authState.login ?? state.userName ?? "unknown"
      return {
        state: "authenticated",
        account_login: login,
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
        // race). Treat as unauthenticated for reporting.
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

  // Cancel any stale flow before requesting a fresh code so the status
  // reporter never sees a half-cleared state.
  if (existing) {
    existing.abort.abort()
  }
  authState = { kind: "signed-out" }

  const deviceCode = await getDeviceCode()
  const abort = new AbortController()
  const flow: ActiveFlow = {
    deviceCode,
    expiresAt: Date.now() + deviceCode.expires_in * 1000,
    abort,
  }
  authState = { kind: "device-issued", flow }

  // Fire-and-forget poller. Errors are captured into authState so the
  // next getAuthStatus call surfaces them; never rethrown.
  runPoller(flow).catch((err: unknown) => {
    consola.error("Auth-controller poller crashed unexpectedly:", err)
  })

  return {
    state: "device_code_issued",
    user_code: deviceCode.user_code,
    verification_uri: deviceCode.verification_uri,
    expires_at: new Date(flow.expiresAt).toISOString(),
  }
}

// Single-flight by construction: this is only invoked from
// startDeviceFlow() after a fresh AbortController is installed on a
// fresh ActiveFlow. The "race condition" the linter flags is the
// intentional single-flight + cancellation pattern — abort() is the
// only thing that signals cancellation, and we re-read it after each
// await before touching shared state.
/* eslint-disable @typescript-eslint/no-unnecessary-condition -- TS can't see that abort.signal.aborted may flip during an await. */
async function runPoller(flow: ActiveFlow): Promise<void> {
  if (flow.abort.signal.aborted) return
  authState = { kind: "polling", flow }

  try {
    // pollAccessToken loops internally with the server-told interval,
    // honouring slow_down and authorization_pending. It resolves on
    // success and throws on expired_token / access_denied.
    const token = await pollAccessToken(flow.deviceCode)

    if (flow.abort.signal.aborted) return

    // Resolve the login BEFORE persisting so the account is keyed by its real
    // `login@host` rather than "unknown". Best-effort: a failure here does NOT
    // invalidate the token — we still persist (under "unknown"), the avatar
    // falls back to a neutral placeholder, and cold-boot logUser() repopulates
    // the login next start. Populating it before flipping to signed-in also
    // keeps the Account UI from latching "(unknown)" — it stops polling the
    // instant it sees `authenticated` and only re-fetches on re-navigation.
    let login: string | null = null
    try {
      const user = await getGitHubUser(token)
      login = user.login
      state.userName = user.login
    } catch (err) {
      consola.warn("Auth-controller: failed to fetch GitHub user:", err)
    }

    // Re-check abort: getGitHubUser is an awaited round-trip during which
    // signOut() may have fired. Don't persist/expose a token the user cleared.
    if (flow.abort.signal.aborted) return

    await addAccount(
      makeAccountRecord({
        login: login ?? "unknown",
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
      consola.warn(
        "Auth-controller: failed to mint Copilot token after sign-in:",
        err,
      )
    }

    // Re-check abort: setupCopilotToken is an awaited round-trip during which
    // signOut() may have fired and wiped the token. Don't latch signed-in over
    // a just-cleared session.
    if (flow.abort.signal.aborted) return
    authState = { kind: "signed-in", login }
  } catch (err) {
    if (flow.abort.signal.aborted) return
    const message = err instanceof Error ? err.message : String(err)
    authState = { kind: "error", message, remediationUrl: null }
    consola.warn("Auth-controller: device-code poll terminated:", message)
  }
}
/* eslint-enable @typescript-eslint/no-unnecessary-condition */

/**
 * Mark the session signed-in from a token resolved OUTSIDE the device
 * flow (cold boot / `--github-token` / CLI `auth`). The completion host,
 * Copilot token, and models are populated by the caller (bootstrapUpstream
 * → logUser/setupCopilotToken/cacheModels); this only records the auth
 * status so getAuthStatus reports `authenticated` after a restart.
 */
export function markSignedIn(login: string | null): void {
  authState = { kind: "signed-in", login }
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
  authState = { kind: "signed-out" }
}

export async function signOut(): Promise<void> {
  // Cancel any active poller first so it can't race the token wipe.
  const flow = currentFlow()
  if (flow) {
    flow.abort.abort()
  }
  authState = { kind: "signed-out" }
  state.githubToken = undefined
  state.copilotToken = undefined
  state.userName = undefined
  // A signed-out session has no upstream activity to surface a banner
  // about. Clear here so the sidecar doesn't outlive the token that
  // produced it.
  clearLastUpstreamRejection()

  // Drop the active account from the registry (any other persisted accounts
  // remain available for quick-switch). Behaviour-neutral for the single
  // account case: the registry empties → next boot is unauthenticated.
  try {
    await removeActiveAccount()
  } catch (err) {
    consola.warn("Auth-controller: failed to update account registry:", err)
  }

  // Also delete the legacy single-record file so a slice-2 rollback doesn't
  // resurrect the signed-out account. Tolerant of "already gone".
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
      consola.warn("Auth-controller: failed to delete token file:", err)
    }
  }
}

/**
 * Treat a CopilotAuthFatalError (GHCP 401/403) identically to a user-
 * initiated sign-out — clear all token state and the on-disk file —
 * but preserve the upstream message and remediation URL so the Sign
 * In screen can render them as a banner. Anything that can throw a
 * CopilotAuthFatalError (setupCopilotToken, the refresh loop) routes
 * through here.
 */
export async function markAuthFatalAndSignOut(
  error: CopilotAuthFatalError,
): Promise<void> {
  await signOut()
  authState = {
    kind: "error",
    message: error.message,
    remediationUrl: error.remediationUrl,
  }
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
  // getAuthStatus falls back to state.userName for a signed-in session
  // (so cold-boot from a stored token populates the Account UI). Tests
  // reset state.githubToken between cases; reset the cached userName here
  // too so the fallback doesn't leak across them.
  state.userName = undefined
}
