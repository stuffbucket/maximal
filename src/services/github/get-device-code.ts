import { getOauthAppConfig, getOauthUrls } from "~/lib/api-config"
import { GITHUB_API_TIMEOUT_MS } from "~/lib/http-timeouts"
import { sendRequestJson } from "~/lib/send-request"

export async function getDeviceCode(): Promise<DeviceCodeResponse> {
  const { clientId, headers, scope } = getOauthAppConfig()
  const { deviceCodeUrl } = getOauthUrls()

  return await sendRequestJson<DeviceCodeResponse>(deviceCodeUrl, {
    credential: { domain: "none" },
    method: "POST",
    headers,
    body: JSON.stringify({
      client_id: clientId,
      scope,
    }),
    timeoutMs: GITHUB_API_TIMEOUT_MS,
    errorMessage: "Failed to get device code",
  })
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  /** RFC 8628 pre-filled URL with user_code in the query string. GitHub
   *  doesn't always populate it; callers should fall back to composing
   *  the URL from `verification_uri` + `user_code`. */
  verification_uri_complete?: string
  expires_in: number
  interval: number
}
