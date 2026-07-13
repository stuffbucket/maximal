import type { ResolvedProviderConfig } from "~/lib/config/config"
import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import { sendProviderRequest } from "~/lib/http/send-request"

const FORWARDABLE_HEADERS = [
  "anthropic-version",
  "anthropic-beta",
  "accept",
  "user-agent",
] as const

const STRIPPED_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const

// Non-secret headers only. The provider credential is attached by the single
// mechanism in `send-request.ts` (`sendProviderRequest`); see ADR-0001.
export function buildProviderUpstreamHeaders(
  requestHeaders: Headers,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  }

  for (const headerName of FORWARDABLE_HEADERS) {
    const headerValue = requestHeaders.get(headerName)
    if (headerValue) {
      headers[headerName] = headerValue
    }
  }

  return headers
}

export function createProviderProxyResponse(
  upstreamResponse: Response,
): Response {
  const headers = new Headers(upstreamResponse.headers)

  for (const headerName of STRIPPED_RESPONSE_HEADERS) {
    headers.delete(headerName)
  }

  return new Response(upstreamResponse.body, {
    headers,
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
  })
}

export async function forwardProviderMessages(
  providerConfig: ResolvedProviderConfig,
  payload: AnthropicMessagesPayload,
  requestHeaders: Headers,
): Promise<Response> {
  return await sendProviderRequest(
    providerConfig,
    `${providerConfig.baseUrl}/v1/messages`,
    {
      method: "POST",
      headers: buildProviderUpstreamHeaders(requestHeaders),
      body: JSON.stringify(payload),
    },
  )
}

export async function forwardProviderModels(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
): Promise<Response> {
  return await sendProviderRequest(
    providerConfig,
    `${providerConfig.baseUrl}/v1/models`,
    {
      method: "GET",
      headers: buildProviderUpstreamHeaders(requestHeaders),
    },
  )
}
