import { afterEach, describe, expect, test } from "bun:test"

import type { ResolvedProviderConfig } from "~/lib/config"

import { sendProviderRequest } from "~/lib/send-request"

import { buildProviderUpstreamHeaders } from "../src/services/providers/anthropic-proxy"

function createProviderConfig(
  overrides: Partial<ResolvedProviderConfig> = {},
): ResolvedProviderConfig {
  return {
    name: "custom",
    type: "anthropic",
    baseUrl: "https://example.com",
    apiKey: "provider-key",
    authType: "x-api-key",
    ...overrides,
  }
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Capture the Request the mechanism actually sends to the network. */
function captureRequest(): { last: () => Request } {
  let captured: Request | undefined
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    captured = new Request(url, init)
    return Promise.resolve(new Response("{}"))
  }) as unknown as typeof fetch
  return {
    last: () => {
      if (!captured) throw new Error("fetch was not called")
      return captured
    },
  }
}

describe("buildProviderUpstreamHeaders", () => {
  // The builder now emits ONLY non-secret headers; the provider credential is
  // attached inside the mechanism (see the sendRequest tests below).
  test("carries no auth header — only content/accept + forwarded headers", () => {
    const headers = buildProviderUpstreamHeaders(
      new Headers({
        accept: "application/json",
        "anthropic-version": "2023-06-01",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      "anthropic-version": "2023-06-01",
    })
    expect("authorization" in headers).toBe(false)
    expect("x-api-key" in headers).toBe(false)
  })
})

describe("provider credential attachment (inside the mechanism)", () => {
  test("attaches x-api-key by default", async () => {
    const cap = captureRequest()
    await sendProviderRequest(
      createProviderConfig(),
      "https://example.com/v1/models",
      { headers: buildProviderUpstreamHeaders(new Headers()) },
    )
    expect(cap.last().headers.get("x-api-key")).toBe("provider-key")
    expect(cap.last().headers.get("authorization")).toBeNull()
  })

  test("attaches Authorization bearer when configured", async () => {
    const cap = captureRequest()
    await sendProviderRequest(
      createProviderConfig({ authType: "authorization" }),
      "https://example.com/v1/models",
      { headers: buildProviderUpstreamHeaders(new Headers()) },
    )
    expect(cap.last().headers.get("authorization")).toBe("Bearer provider-key")
    expect(cap.last().headers.get("x-api-key")).toBeNull()
  })
})
