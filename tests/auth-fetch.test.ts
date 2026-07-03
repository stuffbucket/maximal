import { afterEach, describe, expect, test } from "bun:test"

import { authFetch, authFetchJson } from "~/lib/auth-fetch"
import { HTTPError } from "~/lib/error"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function captureFetch(response?: Response): {
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    return Promise.resolve(response ?? new Response("{}"))
  }) as unknown as typeof fetch
  return { calls }
}

describe("authFetch", () => {
  test("forwards headers and body unchanged to fetch", async () => {
    const { calls } = captureFetch()
    await authFetch("https://api.example/x", {
      method: "POST",
      headers: { "x-initiator": "agent" },
      body: "hi",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://api.example/x")
    expect(calls[0].init.method).toBe("POST")
    expect(
      (calls[0].init.headers as Record<string, string>)["x-initiator"],
    ).toBe("agent")
    expect(calls[0].init.body).toBe("hi")
  })

  test("attaches an AbortSignal when timeoutMs is set", async () => {
    const { calls } = captureFetch()
    await authFetch("https://api.example/x", { timeoutMs: 5000 })
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  test("leaves signal undefined when timeoutMs is omitted", async () => {
    const { calls } = captureFetch()
    await authFetch("https://api.example/x")
    expect(calls[0].init.signal).toBeUndefined()
  })

  test("an explicit signal wins over timeoutMs", async () => {
    const { calls } = captureFetch()
    const controller = new AbortController()
    await authFetch("https://api.example/x", {
      signal: controller.signal,
      timeoutMs: 5000,
    })
    expect(calls[0].init.signal).toBe(controller.signal)
  })

  test("does not leak timeoutMs into the fetch init", async () => {
    const { calls } = captureFetch()
    await authFetch("https://api.example/x", { timeoutMs: 5000 })
    expect("timeoutMs" in (calls[0].init as object)).toBe(false)
  })
})

describe("authFetchJson", () => {
  test("returns parsed JSON on ok", async () => {
    captureFetch(
      new Response(JSON.stringify({ login: "octocat" }), { status: 200 }),
    )
    const result = await authFetchJson<{ login: string }>(
      "https://api.example/user",
      { errorMessage: "boom" },
    )
    expect(result.login).toBe("octocat")
  })

  test("throws HTTPError with the given message on non-ok", async () => {
    captureFetch(new Response("nope", { status: 500 }))
    let caught: unknown
    try {
      await authFetchJson("https://api.example/user", { errorMessage: "boom" })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(HTTPError)
    expect((caught as Error).message).toBe("boom")
  })

  test("does not leak errorMessage into the fetch init", async () => {
    const { calls } = captureFetch()
    await authFetchJson("https://api.example/user", { errorMessage: "boom" })
    expect("errorMessage" in (calls[0].init as object)).toBe(false)
  })
})
