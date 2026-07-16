import consola from "consola"

import { getOauthAppConfig, getOauthUrls } from "~/lib/config/api-config"
import { DEVICE_POLL_TIMEOUT_MS } from "~/lib/http/http-timeouts"
import { sendRequest } from "~/lib/http/send-request"
import { sleep } from "~/lib/platform/utils"

import type { DeviceCodeResponse } from "./get-device-code"

/**
 * RFC 8628 §3.5 device-code polling.
 *
 * GitHub returns auth-flow status with HTTP 200 and an `error` field in the
 * JSON body, *not* a non-2xx status. Recognised values:
 *
 *   - `authorization_pending` → user hasn't approved yet; continue polling.
 *   - `slow_down` → bump the interval by ≥5 seconds (RFC requirement).
 *     GitHub may include a fresh `interval` field; honour the larger.
 *   - `expired_token` / `access_denied` → terminal errors; throw.
 *
 * The previous implementation treated non-2xx as "keep waiting" and silently
 * dropped `slow_down`, which on a heavily-rate-limited account could lead to
 * GitHub revoking the device-code mid-flow.
 */

const SLOW_DOWN_BUMP_SECONDS = 5

/** RFC 8628 §3.5 default client poll interval (seconds) when the server omits
 *  one. Also the fallback that keeps a malformed response from producing a
 *  zero/NaN sleep that would spin the loop. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5

/** Fallback device-code lifetime (seconds) when `expires_in` is absent, so the
 *  deadline guard can never be NaN (which would never fire). GitHub codes
 *  typically live ~15 min. */
const DEFAULT_EXPIRES_IN_SECONDS = 900

/** Give up after this many back-to-back transport failures: a persistently-
 *  unreachable network can't complete the flow, and retrying forever (or, on an
 *  instantaneous failure, spinning) helps no one. Reset on any response. */
const MAX_CONSECUTIVE_TRANSPORT_ERRORS = 12

/** The value if it's a finite number, else the fallback. Guards malformed
 *  device-code fields (`undefined`/`NaN`) from poisoning the interval/deadline
 *  math. A literal `0` is finite and preserved (callers use it to mean
 *  "already expired"). */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
): Promise<string> {
  const { clientId, headers } = getOauthAppConfig()
  const { accessTokenUrl } = getOauthUrls()

  // Server-told interval, in seconds, plus a 1s buffer for minor clock skew.
  let intervalSeconds =
    finiteOr(deviceCode.interval, DEFAULT_POLL_INTERVAL_SECONDS) + 1
  consola.debug(`Polling access token at ${intervalSeconds}s interval`)

  // Self-expiry guard: bound the whole poll on the device code's own lifetime
  // so `polling` always terminates into a terminal error even if GitHub never
  // returns `expired_token` (a hung/misbehaving upstream can't poll forever).
  const deadlineMs =
    Date.now()
    + finiteOr(deviceCode.expires_in, DEFAULT_EXPIRES_IN_SECONDS) * 1000

  // Bound consecutive transport failures (see the constant); reset on any
  // response received, so intermittent blips don't accumulate.

  let consecutiveTransportErrors = 0

  while (true) {
    if (Date.now() >= deadlineMs) throw new Error("expired_token")

    await sleep(intervalSeconds * 1000)

    let response: Response
    try {
      response = await sendRequest(accessTokenUrl, {
        method: "POST",
        headers,
        timeoutMs: DEVICE_POLL_TIMEOUT_MS,
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      })
    } catch (err) {
      consecutiveTransportErrors++
      if (consecutiveTransportErrors >= MAX_CONSECUTIVE_TRANSPORT_ERRORS) {
        throw new Error(
          "Device-code poll: network unreachable after repeated attempts. Check your connection and re-run setup.",
        )
      }
      consola.warn("Device-code poll: network error, retrying", err)
      continue
    }
    // A response arrived — the transport is working; reset the failure streak.
    consecutiveTransportErrors = 0

    let body: PollResponseBody
    try {
      body = (await response.json()) as PollResponseBody
    } catch {
      consola.warn(
        `Device-code poll: non-JSON response (HTTP ${response.status}), retrying`,
      )
      continue
    }

    consola.debug("Device-code poll response:", body)

    if (typeof body.access_token === "string" && body.access_token) {
      return body.access_token
    }

    switch (body.error) {
      case "authorization_pending": {
        continue
      }
      case "slow_down": {
        intervalSeconds =
          typeof body.interval === "number" && body.interval > intervalSeconds ?
            body.interval + 1
          : intervalSeconds + SLOW_DOWN_BUMP_SECONDS
        consola.debug(`Server asked for slow_down → ${intervalSeconds}s`)
        continue
      }
      case "expired_token": {
        throw new Error(
          "Device code expired before authorization. Re-run setup.",
        )
      }
      case "access_denied": {
        throw new Error("Authorization denied by the user.")
      }
      case undefined: {
        consola.warn("Device-code poll: empty response, retrying")
        continue
      }
      default: {
        throw new Error(
          `Device-code poll failed: ${body.error}${
            body.error_description ? ` — ${body.error_description}` : ""
          }`,
        )
      }
    }
  }
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
