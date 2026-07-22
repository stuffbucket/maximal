import consola from "consola"
import { z } from "zod"

import { getOauthAppConfig, getOauthUrls } from "~/lib/config/api-config"
import { DEVICE_POLL_TIMEOUT_MS } from "~/lib/http/http-timeouts"
import { sendRequest } from "~/lib/http/send-request"
import { abortableSleep } from "~/lib/platform/utils"

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
 *
 * `deviceCode.interval` / `expires_in` are trusted to be finite, non-negative
 * numbers here — the boundary that produced them (`DeviceCodeResponseSchema` in
 * get-device-code.ts) guarantees it, so the interval/deadline math can't go
 * `NaN` (the bug that let this loop spin). Pass `signal` to make the whole poll
 * cancellable: an aborted flow stops the loop promptly instead of running to its
 * self-expiry deadline.
 */

const SLOW_DOWN_BUMP_SECONDS = 5

/** Give up after this many back-to-back transport failures: a persistently-
 *  unreachable network can't complete the flow, and retrying forever helps no
 *  one. Reset on any response received. */
const MAX_CONSECUTIVE_TRANSPORT_ERRORS = 12

/** The response body of the access-token poll, validated at the boundary.
 *  Every field is optional (GitHub returns different subsets per state) and
 *  unknown fields pass through; `interval` is coerced non-negative so the
 *  `slow_down` bump math stays sound. */
const PollResponseBodySchema = z
  .object({
    access_token: z.string().optional(),
    token_type: z.string().optional(),
    scope: z.string().optional(),
    // Present ONLY when the GitHub App has "expiring user tokens" enabled. When
    // present, access_token is a short-lived ghu_ that must be renewed via
    // refresh_token before expiry (see refresh-access-token.ts). Absent → the
    // token never expires and there's nothing to renew.
    refresh_token: z.string().optional(),
    expires_in: z.number().nonnegative().optional(),
    refresh_token_expires_in: z.number().nonnegative().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
    error_uri: z.string().optional(),
    interval: z.number().nonnegative().optional(),
  })
  .loose()

type PollResponseBody = z.infer<typeof PollResponseBodySchema>

/**
 * The credential material from a device-code grant (or a refresh grant — see
 * refresh-access-token.ts, which returns the same shape). `refreshToken` and the
 * `*ExpiresAt` timestamps are null when GitHub's App does not issue expiring
 * user tokens (the common case today), in which case there is nothing to renew.
 */
export interface DeviceTokenResult {
  accessToken: string
  refreshToken: string | null
  /** Absolute epoch-ms expiry of the access token, or null if non-expiring. */
  accessTokenExpiresAt: number | null
  /** Absolute epoch-ms expiry of the refresh token, or null if none. */
  refreshTokenExpiresAt: number | null
}

/** Build a DeviceTokenResult from a validated token-bearing response body,
 *  converting the relative `expires_in` seconds to absolute epoch-ms. Shared by
 *  the device-code poll and the refresh grant so both persist the same shape. */
export function toDeviceTokenResult(
  body: {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    refresh_token_expires_in?: number
  },
  nowMs: number = Date.now(),
): DeviceTokenResult {
  return {
    accessToken: body.access_token ?? "",
    refreshToken: body.refresh_token ?? null,
    accessTokenExpiresAt:
      typeof body.expires_in === "number" ?
        nowMs + body.expires_in * 1000
      : null,
    refreshTokenExpiresAt:
      typeof body.refresh_token_expires_in === "number" ?
        nowMs + body.refresh_token_expires_in * 1000
      : null,
  }
}

/** What to do after reading one poll response: hand back a token, or keep
 *  polling (optionally at a new interval). Terminal server errors throw. */
type PollOutcome =
  | { kind: "token"; result: DeviceTokenResult }
  | { kind: "retry"; nextInterval?: number }

function abortError(): Error {
  return new DOMException("Device-code poll aborted", "AbortError")
}

/** Abort the in-flight poll request on either the flow's cancel or the
 *  per-request timeout, whichever fires first. */
function pollRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(DEVICE_POLL_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** Map a validated poll body to the next loop action. Throws on the terminal
 *  states (`expired_token`, `access_denied`, unrecognised errors). */
function interpretPollBody(
  body: PollResponseBody,
  intervalSeconds: number,
): PollOutcome {
  if (typeof body.access_token === "string" && body.access_token) {
    return { kind: "token", result: toDeviceTokenResult(body) }
  }

  switch (body.error) {
    case "authorization_pending": {
      return { kind: "retry" }
    }
    case "slow_down": {
      const nextInterval =
        typeof body.interval === "number" && body.interval > intervalSeconds ?
          body.interval + 1
        : intervalSeconds + SLOW_DOWN_BUMP_SECONDS
      consola.debug(`Server asked for slow_down → ${nextInterval}s`)
      return { kind: "retry", nextInterval }
    }
    case "expired_token": {
      throw new Error("Device code expired before authorization. Re-run setup.")
    }
    case "access_denied": {
      throw new Error("Authorization denied by the user.")
    }
    case undefined: {
      consola.warn("Device-code poll: empty response, retrying")
      return { kind: "retry" }
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

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
  signal?: AbortSignal,
): Promise<DeviceTokenResult> {
  const { clientId, headers } = getOauthAppConfig()
  const { accessTokenUrl } = getOauthUrls()

  // Server-told interval, in seconds, plus a 1s buffer for minor clock skew.
  let intervalSeconds = deviceCode.interval + 1
  consola.debug(`Polling access token at ${intervalSeconds}s interval`)

  // Self-expiry guard: bound the whole poll on the device code's own lifetime
  // so `polling` always terminates into a terminal error even if GitHub never
  // returns `expired_token` (a hung/misbehaving upstream can't poll forever).
  const deadlineMs = Date.now() + deviceCode.expires_in * 1000

  // Bound consecutive transport failures (see the constant); reset on any
  // response received, so intermittent blips don't accumulate.
  let consecutiveTransportErrors = 0

  while (true) {
    if (signal?.aborted) throw abortError()
    if (Date.now() >= deadlineMs) throw new Error("expired_token")

    await abortableSleep(intervalSeconds * 1000, signal)
    if (signal?.aborted) throw abortError()

    let response: Response
    try {
      response = await sendRequest(accessTokenUrl, {
        method: "POST",
        headers,
        signal: pollRequestSignal(signal),
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      })
    } catch (err) {
      // A cancel aborts the request too — stop the loop, don't count it as a
      // transport failure or keep retrying.
      if (signal?.aborted) throw abortError()
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

    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      consola.warn(
        `Device-code poll: non-JSON response (HTTP ${response.status}), retrying`,
      )
      continue
    }

    const parsed = PollResponseBodySchema.safeParse(raw)
    if (!parsed.success) {
      consola.warn(
        `Device-code poll: unexpected response shape (HTTP ${response.status}), retrying`,
      )
      continue
    }

    consola.debug("Device-code poll response:", parsed.data)
    const outcome = interpretPollBody(parsed.data, intervalSeconds)
    if (outcome.kind === "token") return outcome.result
    if (outcome.nextInterval !== undefined)
      intervalSeconds = outcome.nextInterval
  }
}
