import { afterEach, describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { sendRequest, sendRequestJson } from "~/lib/send-request"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function captureFetch(response?: Response): {
  calls: Array<{ url: string; init: RequestInit }>
  request: () => Request
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    return Promise.resolve(response ?? new Response("{}"))
  }) as unknown as typeof fetch
  return {
    calls,
    request: () => new Request(calls[0].url, calls[0].init),
  }
}

describe("sendRequest — credential attachment happens inside the mechanism", () => {
  test("attaches a Copilot bearer the caller never supplied", async () => {
    const cap = captureFetch()
    await sendRequest("https://api.example/x", {
      credential: { domain: "copilot" },
    })
    // The caller passed NO headers; the mechanism attached the token.
    expect(cap.request().headers.get("authorization")).toStartWith("Bearer ")
  })

  test("github uses the caller-provided override token via the legacy scheme", async () => {
    const cap = captureFetch()
    await sendRequest("https://api.example/user", {
      credential: { domain: "github", token: "gho_test" },
    })
    expect(cap.request().headers.get("authorization")).toBe("token gho_test")
  })

  test("domain 'none' attaches no auth header", async () => {
    const cap = captureFetch()
    await sendRequest("https://api.example/device", {
      credential: { domain: "none" },
    })
    expect(cap.request().headers.get("authorization")).toBeNull()
    expect(cap.request().headers.get("x-api-key")).toBeNull()
  })

  test("provider (x-api-key) attaches the configured key as x-api-key", async () => {
    const cap = captureFetch()
    await sendRequest("https://provider.example/v1/models", {
      credential: {
        domain: "provider",
        config: {
          name: "c",
          type: "anthropic",
          baseUrl: "https://provider.example",
          apiKey: "prov-key",
          authType: "x-api-key",
        },
      },
    })
    expect(cap.request().headers.get("x-api-key")).toBe("prov-key")
  })

  test("forwards caller non-secret headers and body unchanged", async () => {
    const cap = captureFetch()
    await sendRequest("https://api.example/x", {
      credential: { domain: "none" },
      method: "POST",
      headers: { "x-initiator": "agent" },
      body: "hi",
    })
    expect(cap.request().headers.get("x-initiator")).toBe("agent")
    expect(cap.calls[0].init.method).toBe("POST")
    expect(cap.calls[0].init.body).toBe("hi")
  })

  test("attaches an AbortSignal when timeoutMs is set", async () => {
    const cap = captureFetch()
    await sendRequest("https://api.example/x", {
      credential: { domain: "none" },
      timeoutMs: 5000,
    })
    expect(cap.calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  test("leaves signal undefined when timeoutMs is omitted", async () => {
    const cap = captureFetch()
    await sendRequest("https://api.example/x", {
      credential: { domain: "none" },
    })
    expect(cap.calls[0].init.signal).toBeUndefined()
  })

  test("an explicit signal wins over timeoutMs", async () => {
    const cap = captureFetch()
    const controller = new AbortController()
    await sendRequest("https://api.example/x", {
      credential: { domain: "none" },
      signal: controller.signal,
      timeoutMs: 5000,
    })
    expect(cap.calls[0].init.signal).toBe(controller.signal)
  })
})

describe("sendRequestJson", () => {
  test("returns parsed JSON on ok", async () => {
    captureFetch(
      new Response(JSON.stringify({ login: "octocat" }), { status: 200 }),
    )
    const result = await sendRequestJson<{ login: string }>(
      "https://api.example/user",
      { credential: { domain: "none" }, errorMessage: "boom" },
    )
    expect(result.login).toBe("octocat")
  })

  test("throws HTTPError with the given message on non-ok", async () => {
    captureFetch(new Response("nope", { status: 500 }))
    let caught: unknown
    try {
      await sendRequestJson("https://api.example/user", {
        credential: { domain: "none" },
        errorMessage: "boom",
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(HTTPError)
    expect((caught as Error).message).toBe("boom")
  })
})
