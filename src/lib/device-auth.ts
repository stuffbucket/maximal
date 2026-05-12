/**
 * Device-code OAuth lifecycle split into two HTTP-callable primitives.
 *
 * The CLI path (`maximal auth`) and the HTTP routes (`/auth/start`,
 * `/auth/poll`) both drive the same in-memory session through these
 * functions. The CLI uses {@link pollUntilReady} to block in-process;
 * the HTTP layer calls {@link pollOnce} per request so the client
 * controls cadence.
 *
 * Storage is module-level — a single concurrent setup session at a
 * time. Process restart clears it; callers must call {@link startDeviceAuth}
 * again. The Tauri shell's setup window is the only practical caller
 * of the HTTP path today.
 *
 * See docs/first-run-setup-prd.md, §"State 2 — Waiting for GitHub approval".
 */

import clipboard from "clipboardy"
import consola from "consola"

import { getOauthAppConfig, getOauthUrls } from "~/lib/api-config"
import { getDeviceCode } from "~/services/github/get-device-code"

import { sleep } from "./utils"

export interface DeviceAuthSession {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
  startedAtMs: number
  interval: number
  copiedToClipboard: boolean
}

export type DeviceAuthPollOutcome =
  | { status: "pending"; expiresIn: number }
  | { status: "slow_down"; expiresIn: number; interval: number }
  | { status: "ready"; accessToken: string }
  | { status: "expired" }
  | { status: "error"; reason: string }

let currentSession: DeviceAuthSession | null = null

export function getCurrentDeviceAuthSession(): DeviceAuthSession | null {
  return currentSession
}

export function clearDeviceAuthSession(): void {
  currentSession = null
}

/**
 * Begin a new device-code flow. Hits GitHub for a fresh code, writes
 * the user code to the OS clipboard (best effort), and stashes a new
 * in-memory session. Any prior session is replaced.
 */
export async function startDeviceAuth(): Promise<DeviceAuthSession> {
  const response = await getDeviceCode()
  consola.debug("Device code response:", response)

  let copiedToClipboard = false
  try {
    clipboard.writeSync(response.user_code)
    copiedToClipboard = true
  } catch {
    // Clipboard unavailable — headless Linux, sandbox, etc. The CLI
    // prints the code; the HTTP client can show it inline.
  }

  const session: DeviceAuthSession = {
    deviceCode: response.device_code,
    userCode: response.user_code,
    verificationUri: response.verification_uri,
    verificationUriComplete: response.verification_uri_complete,
    expiresIn: response.expires_in,
    startedAtMs: Date.now(),
    interval: response.interval,
    copiedToClipboard,
  }
  currentSession = session
  return session
}

export function deviceCodeRemainingSeconds(
  session: DeviceAuthSession,
  nowMs: number = Date.now(),
): number {
  const elapsed = Math.floor((nowMs - session.startedAtMs) / 1000)
  return Math.max(0, session.expiresIn - elapsed)
}

interface PollResponseBody {
  access_token?: string
  token_type?: string
  scope?: string
  error?: string
  error_description?: string
  error_uri?: string
  interval?: number
}

/**
 * Single upstream poll. Translates GitHub's RFC 8628 response into a
 * normalized outcome. Does NOT sleep — the caller (CLI loop or HTTP
 * handler) decides the cadence.
 */
export async function pollOnce(
  session: DeviceAuthSession,
): Promise<DeviceAuthPollOutcome> {
  if (deviceCodeRemainingSeconds(session) <= 0) {
    return { status: "expired" }
  }

  const { clientId, headers } = getOauthAppConfig()
  const { accessTokenUrl } = getOauthUrls()

  let response: Response
  try {
    response = await fetch(accessTokenUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_id: clientId,
        device_code: session.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })
  } catch (err) {
    return {
      status: "error",
      reason: `network error: ${(err as Error).message}`,
    }
  }

  let body: PollResponseBody
  try {
    body = (await response.json()) as PollResponseBody
  } catch {
    return {
      status: "error",
      reason: `non-JSON response (HTTP ${response.status})`,
    }
  }

  if (typeof body.access_token === "string" && body.access_token) {
    return { status: "ready", accessToken: body.access_token }
  }

  switch (body.error) {
    case "authorization_pending":
    case undefined: {
      return {
        status: "pending",
        expiresIn: deviceCodeRemainingSeconds(session),
      }
    }
    case "slow_down": {
      const nextInterval =
        typeof body.interval === "number" && body.interval > session.interval ?
          body.interval
        : session.interval + 5
      session.interval = nextInterval
      return {
        status: "slow_down",
        expiresIn: deviceCodeRemainingSeconds(session),
        interval: nextInterval,
      }
    }
    case "expired_token": {
      return { status: "expired" }
    }
    case "access_denied": {
      return { status: "error", reason: "access_denied" }
    }
    default: {
      return {
        status: "error",
        reason:
          body.error
          + (body.error_description ? ` — ${body.error_description}` : ""),
      }
    }
  }
}

/**
 * CLI-friendly wrapper: poll in a loop, sleeping `session.interval + 1`
 * seconds between attempts, until ready or terminal failure. Resolves
 * with the access token. Throws on expiry or error.
 *
 * Behaviour matches the legacy `pollAccessToken` so existing CLI
 * tests and prompts don't change.
 */
export async function pollUntilReady(
  session: DeviceAuthSession,
): Promise<string> {
  while (true) {
    // Server-told interval is in seconds. Add 1s safety buffer for clock skew.
    await sleep((session.interval + 1) * 1000)
    const outcome = await pollOnce(session)
    switch (outcome.status) {
      case "pending": {
        continue
      }
      case "slow_down": {
        consola.debug(
          `Server asked for slow_down → ${session.interval}s interval`,
        )
        continue
      }
      case "ready": {
        return outcome.accessToken
      }
      case "expired": {
        throw new Error(
          "Device code expired before authorization. Re-run setup.",
        )
      }
      case "error": {
        if (outcome.reason === "access_denied") {
          throw new Error("Authorization denied by the user.")
        }
        // Transient network or non-JSON. Retry, matching legacy behavior.
        consola.warn(`Device-code poll: ${outcome.reason}, retrying`)
        continue
      }
      default: {
        // Exhaustiveness — DeviceAuthPollOutcome is a discriminated
        // union; the cases above cover every status.
        const _exhaustive: never = outcome
        void _exhaustive
        continue
      }
    }
  }
}

/**
 * Test-only shim. The HTTP routes reuse the module-level session, so
 * tests need to reset it between cases.
 * @internal
 */
export function _setSessionForTests(session: DeviceAuthSession | null): void {
  currentSession = session
}

export { type DeviceCodeResponse } from "~/services/github/get-device-code"
