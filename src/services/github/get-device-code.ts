import { z } from "zod"

import { getOauthAppConfig, getOauthUrls } from "~/lib/config/api-config"
import { GITHUB_API_TIMEOUT_MS } from "~/lib/http/http-timeouts"
import { sendRequestJson } from "~/lib/http/send-request"

/**
 * The device/code response, validated at the boundary (RFC 8628 §3.2).
 *
 * `expires_in` and `interval` are load-bearing: they drive the poll loop's
 * self-expiry deadline and inter-poll delay. A cast (`as DeviceCodeResponse`)
 * let a malformed/absent value reach the loop as `undefined` → `NaN`, which
 * disabled the deadline guard and made `sleep(NaN)` spin. Here they are coerced
 * with `.catch()` to RFC-default finite values (any non-finite input — missing,
 * null, `NaN`, wrong type — falls back), so the loop can trust them as numbers.
 * Everything else is passed through; only the strings we actually need are
 * required (a response without them can't drive a device flow at all).
 */
export const DeviceCodeResponseSchema = z
  .object({
    device_code: z.string(),
    user_code: z.string(),
    verification_uri: z.string(),
    /** RFC 8628 pre-filled URL with user_code in the query string. GitHub
     *  doesn't always populate it; callers fall back to composing the URL from
     *  `verification_uri` + `user_code`. */
    verification_uri_complete: z.string().optional(),
    expires_in: z.number().nonnegative().catch(900),
    interval: z.number().nonnegative().catch(5),
  })
  .loose()

export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>

export async function getDeviceCode(): Promise<DeviceCodeResponse> {
  const { clientId, headers, scope } = getOauthAppConfig()
  const { deviceCodeUrl } = getOauthUrls()

  return await sendRequestJson(
    deviceCodeUrl,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_id: clientId,
        scope,
      }),
      timeoutMs: GITHUB_API_TIMEOUT_MS,
      errorMessage: "Failed to get device code",
    },
    DeviceCodeResponseSchema,
  )
}
