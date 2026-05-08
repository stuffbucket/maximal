import { getOauthAppConfig, getOauthUrls } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"

export async function getDeviceCode(): Promise<DeviceCodeResponse> {
  const { clientId, headers, scope } = getOauthAppConfig()
  const { deviceCodeUrl } = getOauthUrls()

  const response = await fetch(deviceCodeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      client_id: clientId,
      scope,
    }),
  })

  if (!response.ok) throw new HTTPError("Failed to get device code", response)

  return (await response.json()) as DeviceCodeResponse
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
