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
 * State machine (one-line diagram):
 *
 *   unauthenticated
 *       │ startDeviceFlow()
 *       ▼
 *   device_code_issued ──poll started──▶ polling
 *                                         │
 *                       ┌─────────────────┼─────────────┐
 *                       ▼                 ▼             ▼
 *                  authenticated        error      (signOut)
 *                       │                 │             │
 *                       └──── signOut ────┴─────────────┘
 *                                  ▼
 *                            unauthenticated
 *
 * Single-flight guarantee: at most one poller runs at any moment.
 * Calling startDeviceFlow() while a non-expired flow is active is
 * idempotent — same code returned, no second poller spawned.
 */

import consola from "consola"

import type { DeviceCodeResponse } from "~/services/github/get-device-code"

import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import type { AuthStatus } from "./settings-types"

import { makeRecord, writeDefaultRecord } from "./github-token-store"
import { PATHS } from "./paths"
import { registerProcessCleanup } from "./process-cleanup"
import { state } from "./state"
import { setupCopilotToken } from "./token"

interface ActiveFlow {
  deviceCode: DeviceCodeResponse
  expiresAt: number
  abort: AbortController
  isPolling: boolean
}

interface ControllerState {
  // Active device-code flow (issued or being polled).
  flow: ActiveFlow | null
  // Last terminal error from a poll attempt, surfaced via getAuthStatus.
  lastError: string | null
  // GitHub login of the authenticated account.
  accountLogin: string | null
}

const controllerState: ControllerState = {
  flow: null,
  lastError: null,
  accountLogin: null,
}

// Module-load init: if a token is already in state (loaded by boot
// path or future boot-decouple) and we don't yet know the login, do
// nothing — the status endpoint reports `authenticated` based on
// state.githubToken; the login is populated lazily by ensureAccountLogin().

function isFlowExpired(flow: ActiveFlow, nowMs: number = Date.now()): boolean {
  return flow.expiresAt <= nowMs
}

export function getAuthStatus(): AuthStatus {
  if (state.githubToken) {
    // On device-flow completion we record the login on controllerState.
    // On cold boot with a stored token, logUser() in src/lib/token.ts
    // populated state.userName via the GitHub /user fetch — use that
    // as the fallback so the Account section doesn't render "(unknown)".
    const login = controllerState.accountLogin ?? state.userName
    return {
      state: "authenticated",
      ...(login ? { account_login: login } : {}),
    }
  }

  if (controllerState.lastError && !controllerState.flow) {
    return { state: "error", error: controllerState.lastError }
  }

  const flow = controllerState.flow
  if (!flow) {
    return { state: "unauthenticated" }
  }

  if (isFlowExpired(flow)) {
    // Stale flow that the poller hasn't cleared yet (e.g. terminal
    // path lost a race). Treat as unauthenticated for reporting.
    return { state: "unauthenticated" }
  }

  return {
    state: flow.isPolling ? "polling" : "device_code_issued",
    user_code: flow.deviceCode.user_code,
    verification_uri: flow.deviceCode.verification_uri,
    expires_at: new Date(flow.expiresAt).toISOString(),
  }
}

export async function startDeviceFlow(): Promise<AuthStatus> {
  const existing = controllerState.flow
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

  // Clear any stale flow / error before requesting a fresh code so the
  // status reporter never sees a half-cleared state.
  if (existing) {
    existing.abort.abort()
  }
  controllerState.flow = null
  controllerState.lastError = null

  const deviceCode = await getDeviceCode()
  const abort = new AbortController()
  const flow: ActiveFlow = {
    deviceCode,
    expiresAt: Date.now() + deviceCode.expires_in * 1000,
    abort,
    isPolling: false,
  }
  // eslint-disable-next-line require-atomic-updates -- single-flight by construction: startDeviceFlow is the only writer.
  controllerState.flow = flow

  // Fire-and-forget poller. Errors are captured into controllerState
  // so the next getAuthStatus call surfaces them; never rethrown.
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
// only thing that mutates the flag, and we re-read it after each
// await before touching shared state.
/* eslint-disable require-atomic-updates, @typescript-eslint/no-unnecessary-condition */
async function runPoller(flow: ActiveFlow): Promise<void> {
  if (flow.abort.signal.aborted) return
  flow.isPolling = true

  try {
    // pollAccessToken loops internally with the server-told interval,
    // honouring slow_down and authorization_pending. It resolves on
    // success and throws on expired_token / access_denied.
    const token = await pollAccessToken(flow.deviceCode)

    if (flow.abort.signal.aborted) return

    await writeDefaultRecord(makeRecord(token))
    state.githubToken = token

    // Best-effort: proactively mint the Copilot token so Diagnostics
    // doesn't surface the intermediate "github present, copilot absent"
    // state. Failure (no Copilot license, network down, upstream 5xx)
    // must NOT fail sign-in — the lazy path in token.ts retries on the
    // first /v1/messages request via setupCopilotToken's TTL refresh.
    try {
      await setupCopilotToken()
    } catch (err) {
      consola.warn(
        "Auth-controller: failed to mint Copilot token after sign-in:",
        err,
      )
    }

    // Best-effort: populate account_login. Failure here doesn't
    // invalidate the token — the user is still authenticated.
    try {
      const user = await getGitHubUser(token)
      controllerState.accountLogin = user.login
      state.userName = user.login
    } catch (err) {
      consola.warn("Auth-controller: failed to fetch GitHub user:", err)
    }

    controllerState.flow = null
    controllerState.lastError = null
  } catch (err) {
    if (flow.abort.signal.aborted) return
    const message = err instanceof Error ? err.message : String(err)
    controllerState.lastError = message
    controllerState.flow = null
    consola.warn("Auth-controller: device-code poll terminated:", message)
  } finally {
    flow.isPolling = false
  }
}
/* eslint-enable require-atomic-updates, @typescript-eslint/no-unnecessary-condition */

export async function signOut(): Promise<void> {
  // Cancel any active poller first so it can't race the token wipe.
  if (controllerState.flow) {
    controllerState.flow.abort.abort()
    controllerState.flow = null
  }
  controllerState.lastError = null
  controllerState.accountLogin = null
  state.githubToken = undefined
  state.copilotToken = undefined
  state.userName = undefined

  // Delete the on-disk token. Tolerant of "already gone".
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

/** Cancel any active poller. Wired into process-cleanup at module
 *  load so SIGINT/SIGTERM unblocks the runtime even when a device-code
 *  poll is mid-sleep. (pollAccessToken's internal sleep doesn't accept
 *  a signal, so the loop continues until the next iteration — but the
 *  abort flag prevents the resolved/rejected branch from writing token
 *  state after the process has begun shutting down.) */
function stopAuthController(): void {
  if (controllerState.flow) {
    controllerState.flow.abort.abort()
    controllerState.flow = null
  }
}

registerProcessCleanup(stopAuthController)

/** Test-only reset. NOT exported from a barrel — keep import paths
 *  long-tail so production code doesn't reach for it. */
export function __resetAuthControllerForTests(): void {
  if (controllerState.flow) {
    controllerState.flow.abort.abort()
  }
  controllerState.flow = null
  controllerState.lastError = null
  controllerState.accountLogin = null
  // getAuthStatus falls back to state.userName when accountLogin is
  // null (so cold-boot from a stored token populates the Account UI).
  // Tests reset state.githubToken between cases; reset the cached
  // userName here too so the fallback doesn't leak across them.
  state.userName = undefined
}
