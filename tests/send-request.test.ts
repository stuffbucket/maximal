import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"

import { HTTPError } from "~/lib/errors/error"
import { requestContext } from "~/lib/http/request-context"
import {
  sendProviderRequest,
  sendRequest,
  sendRequestJson,
} from "~/lib/http/send-request"
import { PATHS } from "~/lib/platform/paths"
import { state } from "~/lib/runtime-state/state"

const realFetch = globalThis.fetch

// The router infers the credential from the destination host, so tests hit the
// real first-party hosts. In standard (non-enterprise, non-opencode) mode these
// resolve to fixed constants.
const COPILOT_HOST = "https://api.githubcopilot.com"
const GITHUB_API_HOST = "https://api.github.com"

const originalTokens = {
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
}

beforeEach(() => {
  state.copilotToken = "copilot-tok"
  state.githubToken = "gh-tok"
  state.accountType = "individual"
  state.copilotApiUrl = undefined
})

afterEach(() => {
  globalThis.fetch = realFetch
  Object.assign(state, originalTokens)
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

describe("sendRequest — credential inferred from the destination host", () => {
  test("Copilot host gets the Copilot bearer, no caller input", async () => {
    const cap = captureFetch()
    await sendRequest(`${COPILOT_HOST}/v1/messages`)
    expect(cap.request().headers.get("authorization")).toBe(
      "Bearer copilot-tok",
    )
  })

  test("GitHub API host gets the github token via the legacy scheme", async () => {
    const cap = captureFetch()
    await sendRequest(`${GITHUB_API_HOST}/user`)
    expect(cap.request().headers.get("authorization")).toBe("token gh-tok")
  })

  test("GitHub API host honors a per-request token override (sign-in flow)", async () => {
    const cap = captureFetch()
    await sendRequest(`${GITHUB_API_HOST}/user`, { githubToken: "candidate" })
    expect(cap.request().headers.get("authorization")).toBe("token candidate")
  })

  test("an unrecognized host gets NO credential (safe default)", async () => {
    const cap = captureFetch()
    await sendRequest("https://github.com/login/oauth/access_token", {
      method: "POST",
    })
    expect(cap.request().headers.get("authorization")).toBeNull()
    expect(cap.request().headers.get("x-api-key")).toBeNull()
  })

  test("a lookalike host that PREFIXES a real host gets NO credential", async () => {
    // Regression: host matching must compare origin, not string prefix.
    // `https://api.githubcopilot.com.evil.com` startsWith the Copilot base URL
    // but is a different origin — it must NOT receive the Copilot token.
    const cap = captureFetch()
    await sendRequest(`${COPILOT_HOST}.evil.com/v1/messages`)
    expect(cap.request().headers.get("authorization")).toBeNull()
    expect(cap.request().headers.get("x-api-key")).toBeNull()
  })

  test("the real host still matches even with a path/query", async () => {
    const cap = captureFetch()
    await sendRequest(`${COPILOT_HOST}/v1/messages?x=1`)
    expect(cap.request().headers.get("authorization")).toBe(
      "Bearer copilot-tok",
    )
  })

  test("forwards caller non-secret headers and body unchanged", async () => {
    const cap = captureFetch()
    await sendRequest(`${COPILOT_HOST}/x`, {
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
    await sendRequest(`${COPILOT_HOST}/x`, { timeoutMs: 5000 })
    expect(cap.calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  test("leaves signal undefined when timeoutMs is omitted", async () => {
    const cap = captureFetch()
    await sendRequest(`${COPILOT_HOST}/x`)
    expect(cap.calls[0].init.signal).toBeUndefined()
  })

  test("an explicit signal wins over timeoutMs", async () => {
    const cap = captureFetch()
    const controller = new AbortController()
    await sendRequest(`${COPILOT_HOST}/x`, {
      signal: controller.signal,
      timeoutMs: 5000,
    })
    expect(cap.calls[0].init.signal).toBe(controller.signal)
  })
})

const getFailure = (request: Promise<Response>) =>
  request.catch((error: unknown) => error)

test("persists only safe metadata for pre-header Copilot socket failures", async () => {
  const reset = Object.assign(new TypeError("private error details"), {
    code: "ECONNRESET",
  })
  const legacyClose = new Error(
    "The socket connection was closed unexpectedly. private error details",
  )
  const aborted = AbortSignal.abort(reset)
  const traceId = "copilot-transport-test"
  const log = Bun.file(
    path.join(
      PATHS.APP_DIR,
      "logs",
      `copilot-transport-${new Date().toLocaleDateString("sv-SE")}.log`,
    ),
  )

  await requestContext.run(
    {
      traceId,
      startTime: Date.now(),
      userAgent: "",
      sessionAffinity: undefined,
      parentSessionId: undefined,
      usage: {},
    },
    async () => {
      let attempts = 0
      const rejectFetch = (error: Error) => {
        globalThis.fetch = Object.assign(
          () => {
            attempts++
            return Promise.reject(error)
          },
          { preconnect: realFetch.preconnect },
        )
      }

      rejectFetch(reset)
      expect(
        await getFailure(
          sendRequest(`${COPILOT_HOST}/responses?private-query`, {
            method: "POST",
            body: "private prompt",
          }),
        ),
      ).toBe(reset)
      expect(
        await getFailure(
          sendRequest(`${COPILOT_HOST}/responses`, { signal: aborted }),
        ),
      ).toBe(reset)
      expect(
        await getFailure(sendRequest(`${GITHUB_API_HOST}/responses`)),
      ).toBe(reset)
      expect(
        await getFailure(sendRequest(`${COPILOT_HOST}/private-path`)),
      ).toBe(reset)
      rejectFetch(legacyClose)
      expect(await getFailure(sendRequest(`${COPILOT_HOST}/v1/messages`))).toBe(
        legacyClose,
      )
      const otherError = new Error("unrelated failure")
      rejectFetch(otherError)
      expect(await getFailure(sendRequest(`${COPILOT_HOST}/responses`))).toBe(
        otherError,
      )
      expect(attempts).toBe(6)
    },
  )

  // The shared logger flushes file writes asynchronously.
  await Bun.sleep(1300)
  const lines = (await log.text())
    .split("\n")
    .filter((line) => line.includes(`[${traceId}]`))
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatch(
    /endpoint=\/responses code=ECONNRESET elapsed_ms=\d+/,
  )
  expect(lines[1]).toMatch(
    /endpoint=\/v1\/messages code=unknown elapsed_ms=\d+/,
  )
  expect(lines.join("\n")).not.toMatch(/private|copilot-tok/)
})

describe("sendProviderRequest — credential from the config object", () => {
  test("attaches x-api-key by default", async () => {
    const cap = captureFetch()
    await sendProviderRequest(
      {
        name: "c",
        type: "anthropic",
        baseUrl: "https://provider.example",
        apiKey: "prov-key",
        authType: "x-api-key",
      },
      "https://provider.example/v1/models",
    )
    expect(cap.request().headers.get("x-api-key")).toBe("prov-key")
  })

  test("attaches Authorization bearer when configured", async () => {
    const cap = captureFetch()
    await sendProviderRequest(
      {
        name: "c",
        type: "anthropic",
        baseUrl: "https://provider.example",
        apiKey: "prov-key",
        authType: "authorization",
      },
      "https://provider.example/v1/models",
    )
    expect(cap.request().headers.get("authorization")).toBe("Bearer prov-key")
  })
})

describe("sendRequestJson", () => {
  test("returns parsed JSON on ok", async () => {
    captureFetch(
      new Response(JSON.stringify({ login: "octocat" }), { status: 200 }),
    )
    const result = await sendRequestJson<{ login: string }>(
      `${GITHUB_API_HOST}/user`,
      { errorMessage: "boom" },
    )
    expect(result.login).toBe("octocat")
  })

  test("throws HTTPError with the given message on non-ok", async () => {
    captureFetch(new Response("nope", { status: 500 }))
    let caught: unknown
    try {
      await sendRequestJson(`${GITHUB_API_HOST}/user`, { errorMessage: "boom" })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(HTTPError)
    expect((caught as Error).message).toBe("boom")
  })
})
