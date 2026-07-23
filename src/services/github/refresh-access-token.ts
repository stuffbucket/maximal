import consola from "consola"
import { z } from "zod"

import { getOauthAppConfig, getOauthUrls } from "~/lib/config/api-config"
import { GITHUB_API_TIMEOUT_MS } from "~/lib/http/http-timeouts"
import { sendRequest } from "~/lib/http/send-request"

import {
  type DeviceTokenResult,
  toDeviceTokenResult,
} from "./poll-access-token"

/** The refresh-grant response mirrors the device-code token response — GitHub
 *  ROTATES the refresh token on each grant, so callers must persist the NEW
 *  `refresh_token`, not the one they sent. Unknown fields pass through. */
const RefreshResponseSchema = z
  .object({
    access_token: z.string().optional(),
    refresh_token: z.string().optional(),
    expires_in: z.number().nonnegative().optional(),
    refresh_token_expires_in: z.number().nonnegative().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .loose()

/**
 * Exchange a GitHub refresh token (`ghr_`) for a fresh access token via the
 * OAuth `refresh_token` grant. Only meaningful when the App issues expiring user
 * tokens; the `refreshToken` comes from a stored AccountRecord.
 *
 * Throws when the refresh token is invalid/expired (GitHub replies with an
 * `error` and no `access_token`) or the response is malformed — the caller
 * treats that as "renewal impossible, degrade / needs-reauth". Returns the same
 * `DeviceTokenResult` shape the device-code grant does, so the store persists it
 * identically (including the rotated refresh token + new expiries).
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<DeviceTokenResult> {
  const { clientId, headers } = getOauthAppConfig()
  const { accessTokenUrl } = getOauthUrls()

  const response = await sendRequest(accessTokenUrl, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    body: JSON.stringify({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  })

  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    throw new Error(
      `GitHub refresh-token grant returned a non-JSON response (HTTP ${response.status})`,
    )
  }

  const parsed = RefreshResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error("GitHub refresh-token grant: unexpected response shape")
  }
  if (!parsed.data.access_token) {
    const reason =
      parsed.data.error_description ?? parsed.data.error ?? "no access_token"
    throw new Error(`GitHub refresh-token grant failed: ${reason}`)
  }

  consola.debug("GitHub access token renewed via the refresh grant")
  return toDeviceTokenResult(parsed.data)
}
