import { afterEach, describe, expect, test } from "bun:test"

import { CopilotAuthFatalError, HTTPError } from "~/lib/errors/error"
import {
  getCopilotToken,
  parseCopilotAuthFailure,
} from "~/services/github/get-copilot-token"

describe("parseCopilotAuthFailure", () => {
  test("structured message + documentation_url", () => {
    const body = JSON.stringify({
      message: "hi",
      documentation_url: "https://github.com/settings/copilot",
    })
    expect(parseCopilotAuthFailure(body)).toEqual({
      message: "hi",
      remediationUrl: "https://github.com/settings/copilot",
    })
  })

  test("notification.message + notification.url", () => {
    const body = JSON.stringify({
      notification: {
        message: "tos",
        url: "https://github.com/site/terms",
      },
    })
    expect(parseCopilotAuthFailure(body)).toEqual({
      message: "tos",
      remediationUrl: "https://github.com/site/terms",
    })
  })

  test("falls back to regex sweep when no structured URL field", () => {
    // Embed a github.com URL in a JSON string field that the structured
    // extractors don't look at, so only the raw-text regex sweep can find it.
    const body = JSON.stringify({
      message: "x",
      detail: "see https://github.com/copilot/signup for details",
    })
    expect(parseCopilotAuthFailure(body)).toEqual({
      message: "x",
      remediationUrl: "https://github.com/copilot/signup",
    })
  })

  test("error wins over error_description when both present and no message", () => {
    const body = JSON.stringify({
      error: "forbidden",
      error_description: "detail",
    })
    const result = parseCopilotAuthFailure(body)
    expect(result.message).toBe("forbidden")
    expect(result.remediationUrl).toBeNull()
  })

  test("empty JSON object falls back to canned message", () => {
    expect(parseCopilotAuthFailure("{}")).toEqual({
      message: "Copilot rejected this token.",
      remediationUrl: null,
    })
  })

  test("plain text body with github.com URL — text becomes message, URL extracted", () => {
    const body = "You must accept new terms at https://github.com/site/terms"
    expect(parseCopilotAuthFailure(body)).toEqual({
      message: "You must accept new terms at https://github.com/site/terms",
      remediationUrl: "https://github.com/site/terms",
    })
  })

  test("plain text body with no URL", () => {
    expect(parseCopilotAuthFailure("nope")).toEqual({
      message: "nope",
      remediationUrl: null,
    })
  })

  test("empty string body", () => {
    expect(parseCopilotAuthFailure("")).toEqual({
      message: "Copilot rejected this token.",
      remediationUrl: null,
    })
  })

  test("malformed JSON falls through to plain-text branch", () => {
    expect(parseCopilotAuthFailure("{not json")).toEqual({
      message: "{not json",
      remediationUrl: null,
    })
  })

  test("non-http URL in documentation_url is rejected by the regex guard", () => {
    const body = JSON.stringify({ documentation_url: "ftp://not-http" })
    expect(parseCopilotAuthFailure(body)).toEqual({
      message: "Copilot rejected this token.",
      remediationUrl: null,
    })
  })
})

describe("getCopilotToken", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const stubFetch = (response: Response) => {
    globalThis.fetch = (() =>
      Promise.resolve(response)) as unknown as typeof fetch
  }

  test("200 OK returns parsed JSON body", async () => {
    const payload = {
      expires_at: 1_700_000_000,
      refresh_in: 1500,
      token: "tok_abc",
    }
    stubFetch(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const result = await getCopilotToken()
    expect(result).toEqual(payload)
  })

  test("401 throws a friendly auth-fatal message, not the raw upstream body", async () => {
    // Raw gRPC-style body that we must NOT surface verbatim to the user.
    const body = "unauthorized: AuthenticateToken authentication failed"
    stubFetch(new Response(body, { status: 401 }))

    try {
      await getCopilotToken()
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(CopilotAuthFatalError)
      const e = err as CopilotAuthFatalError
      expect(e.status).toBe(401)
      expect(e.message).not.toContain("AuthenticateToken")
      expect(e.message).toContain("expired or revoked")
      expect(e.message).toContain("gh auth login")
    }
  })

  test("401 still propagates the remediation URL from the upstream body", async () => {
    const body = JSON.stringify({
      message: "unauthorized: AuthenticateToken authentication failed",
      documentation_url: "https://github.com/settings/copilot",
    })
    stubFetch(new Response(body, { status: 401 }))

    try {
      await getCopilotToken()
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(CopilotAuthFatalError)
      const e = err as CopilotAuthFatalError
      expect(e.message).not.toContain("AuthenticateToken")
      expect(e.remediationUrl).toBe("https://github.com/settings/copilot")
    }
  })

  test("403 throws a friendly no-access message and propagates the URL", async () => {
    const body =
      "Please accept the updated Copilot terms at https://github.com/site/terms"
    stubFetch(new Response(body, { status: 403 }))

    try {
      await getCopilotToken()
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(CopilotAuthFatalError)
      const e = err as CopilotAuthFatalError
      expect(e.status).toBe(403)
      expect(e.message).not.toContain("Copilot terms")
      expect(e.message).toContain("doesn't have access to GitHub Copilot")
      expect(e.remediationUrl).toBe("https://github.com/site/terms")
    }
  })

  test("500 throws HTTPError, not CopilotAuthFatalError", async () => {
    stubFetch(new Response("upstream boom", { status: 500 }))

    try {
      await getCopilotToken()
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPError)
      expect(err).not.toBeInstanceOf(CopilotAuthFatalError)
      expect((err as HTTPError).response.status).toBe(500)
    }
  })

  test("network error (fetch rejects) propagates", async () => {
    const boom = new Error("ECONNREFUSED")
    globalThis.fetch = (() => Promise.reject(boom)) as unknown as typeof fetch

    let caught: unknown
    try {
      await getCopilotToken()
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(boom)
  })
})
