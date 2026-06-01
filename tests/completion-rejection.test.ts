/**
 * Discrimination between auth-fatal (clear token via markAuthFatalAndSignOut)
 * and non-fatal upstream rejections (set state.lastUpstreamRejection sidecar
 * and throw HTTPError) across the three Copilot completion services
 * (createMessages, createChatCompletions, createResponses), plus the
 * route-handler-side forwardError branch.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/anthropic-types"
import type { CopilotAuthFatalError as CopilotAuthFatalErrorType } from "~/lib/error"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

// Stub fs.unlink at module load BEFORE importing forwardError so the
// CopilotAuthFatalError test path doesn't reach the real fs.unlink on
// PATHS.GITHUB_TOKEN_PATH (which would silently delete a signed-in
// user's actual token on dev machines). The auth-controller's signOut
// is ENOENT-tolerant, so the no-op satisfies the contract. afterAll
// restores the real module — Bun's mock.module is process-wide.
const realFsPromisesModule = await import("node:fs/promises")
const unlinkCalls: Array<string> = []
void mock.module("node:fs/promises", () => ({
  ...realFsPromisesModule,
  default: {
    ...(realFsPromisesModule as { default: object }).default,
    unlink: (p: string) => {
      unlinkCalls.push(p)
      return Promise.resolve()
    },
  },
  unlink: (p: string) => {
    unlinkCalls.push(p)
    return Promise.resolve()
  },
}))
afterAll(() => {
  void mock.module("node:fs/promises", () => realFsPromisesModule)
})

const errorMod = await import("~/lib/error")
const { CopilotAuthFatalError, forwardError, HTTPError } = errorMod
const { state } = await import("~/lib/state")
const chatMod = await import("~/services/copilot/create-chat-completions")
const { createChatCompletions } = chatMod
const { createMessages } = await import("~/services/copilot/create-messages")
const { createResponses } = await import("~/services/copilot/create-responses")

const originalFetch = globalThis.fetch
const snapshot = {
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  vsCodeVersion: state.vsCodeVersion,
  accountType: state.accountType,
  lastUpstreamRejection: state.lastUpstreamRejection,
}

function installFetchMock(
  status: number,
  body: string | Record<string, unknown>,
): void {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
    Promise.resolve(
      new Response(text, {
        status,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof fetch
}

beforeEach(() => {
  state.copilotToken = "copilot_test"
  state.githubToken = undefined
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.lastUpstreamRejection = undefined
})

afterEach(() => {
  state.copilotToken = snapshot.copilotToken
  state.githubToken = snapshot.githubToken
  state.vsCodeVersion = snapshot.vsCodeVersion
  state.accountType = snapshot.accountType
  state.lastUpstreamRejection = snapshot.lastUpstreamRejection
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

// --- Fixtures ----------------------------------------------------------------

const messagesPayload: AnthropicMessagesPayload = {
  model: "claude-test",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
}

const chatPayload: ChatCompletionsPayload = {
  model: "gpt-test",
  messages: [{ role: "user", content: "hi" }],
}

const responsesPayload: ResponsesPayload = {
  model: "gpt-test",
  input: "hi",
}

const messagesOpts = { requestId: "rid-1" }
const responsesOpts = {
  vision: false,
  initiator: "user" as const,
  requestId: "rid-1",
}

const authFatalBody = {
  message: "Please accept the terms of service.",
  documentation_url: "https://github.com/site/terms",
}

const quotaBody = {
  message: "You have exceeded your quota.",
  documentation_url: "https://github.com/settings/copilot",
}

const modelDenialBody = {
  message: "Model not available on your plan",
}

// --- createMessages ----------------------------------------------------------

describe("createMessages", () => {
  test("happy path: returns parsed JSON and clears stale rejection", async () => {
    state.lastUpstreamRejection = {
      message: "stale",
      remediationUrl: null,
      status: 429,
      at: new Date(0).toISOString(),
    }
    installFetchMock(200, {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-test",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    const result = await createMessages(
      { ...messagesPayload, stream: false },
      undefined,
      messagesOpts,
    )

    expect((result as { id: string }).id).toBe("msg_1")
    expect(state.lastUpstreamRejection).toBeUndefined()
  })

  test("auth-fatal: throws CopilotAuthFatalError without setting sidecar", async () => {
    installFetchMock(403, authFatalBody)

    let caught: unknown = null
    try {
      await createMessages(messagesPayload, undefined, messagesOpts)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(CopilotAuthFatalError)
    const fatal = caught as CopilotAuthFatalErrorType
    expect(fatal.status).toBe(403)
    expect(fatal.remediationUrl).toBe("https://github.com/site/terms")
    expect(state.lastUpstreamRejection).toBeUndefined()
  })

  test("non-fatal quota (429): throws HTTPError and sets sidecar", async () => {
    installFetchMock(429, quotaBody)

    let caught: unknown = null
    try {
      await createMessages(messagesPayload, undefined, messagesOpts)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(HTTPError)
    expect(caught).not.toBeInstanceOf(CopilotAuthFatalError)
    const rejection = state.lastUpstreamRejection
    expect(rejection).toBeDefined()
    expect(rejection?.status).toBe(429)
    expect(rejection?.message).toBe("You have exceeded your quota.")
    expect(rejection?.remediationUrl).toBe(
      "https://github.com/settings/copilot",
    )
    expect(typeof rejection?.at).toBe("string")
    expect(() => new Date(rejection?.at ?? "").toISOString()).not.toThrow()
  })

  test("non-fatal model-denial (403, no markers): throws HTTPError and sets sidecar", async () => {
    installFetchMock(403, modelDenialBody)

    let caught: unknown = null
    try {
      await createMessages(messagesPayload, undefined, messagesOpts)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(HTTPError)
    expect(caught).not.toBeInstanceOf(CopilotAuthFatalError)
    const rejection = state.lastUpstreamRejection
    expect(rejection?.status).toBe(403)
    expect(rejection?.message).toBe("Model not available on your plan")
    expect(rejection?.remediationUrl).toBeNull()
  })
})

// --- createChatCompletions ---------------------------------------------------

describe("createChatCompletions", () => {
  test("auth-fatal: throws CopilotAuthFatalError without setting sidecar", async () => {
    installFetchMock(403, authFatalBody)

    let caught: unknown = null
    try {
      await createChatCompletions(chatPayload, messagesOpts)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(CopilotAuthFatalError)
    expect((caught as CopilotAuthFatalErrorType).status).toBe(403)
    expect(state.lastUpstreamRejection).toBeUndefined()
  })

  test("non-fatal quota (429): throws HTTPError and sets sidecar", async () => {
    installFetchMock(429, quotaBody)

    let caught: unknown = null
    try {
      await createChatCompletions(chatPayload, messagesOpts)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(HTTPError)
    expect(caught).not.toBeInstanceOf(CopilotAuthFatalError)
    expect(state.lastUpstreamRejection?.status).toBe(429)
    expect(state.lastUpstreamRejection?.message).toBe(
      "You have exceeded your quota.",
    )
  })

  test("non-fatal model-denial (403): throws HTTPError and sets sidecar", async () => {
    installFetchMock(403, modelDenialBody)

    let caught: unknown = null
    try {
      await createChatCompletions(chatPayload, messagesOpts)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(HTTPError)
    expect(caught).not.toBeInstanceOf(CopilotAuthFatalError)
    expect(state.lastUpstreamRejection?.status).toBe(403)
    expect(state.lastUpstreamRejection?.message).toBe(
      "Model not available on your plan",
    )
  })
})

// --- createResponses ---------------------------------------------------------

describe("createResponses", () => {
  test("auth-fatal: throws CopilotAuthFatalError without setting sidecar", async () => {
    installFetchMock(403, authFatalBody)

    let caught: unknown = null
    try {
      await createResponses(responsesPayload, responsesOpts)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(CopilotAuthFatalError)
    expect((caught as CopilotAuthFatalErrorType).status).toBe(403)
    expect(state.lastUpstreamRejection).toBeUndefined()
  })

  test("non-fatal quota (429): throws HTTPError and sets sidecar", async () => {
    installFetchMock(429, quotaBody)

    let caught: unknown = null
    try {
      await createResponses(responsesPayload, responsesOpts)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(HTTPError)
    expect(caught).not.toBeInstanceOf(CopilotAuthFatalError)
    expect(state.lastUpstreamRejection?.status).toBe(429)
    expect(state.lastUpstreamRejection?.remediationUrl).toBe(
      "https://github.com/settings/copilot",
    )
  })

  test("non-fatal model-denial (403): throws HTTPError and sets sidecar", async () => {
    installFetchMock(403, modelDenialBody)

    let caught: unknown = null
    try {
      await createResponses(responsesPayload, responsesOpts)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(HTTPError)
    expect(caught).not.toBeInstanceOf(CopilotAuthFatalError)
    expect(state.lastUpstreamRejection?.status).toBe(403)
  })
})

// --- forwardError ------------------------------------------------------------

interface CapturedResponse {
  body: unknown
  status: number
  headers: Record<string, string>
}

function makeContextStub(): {
  ctx: {
    json: (body: unknown, status?: number) => Response
    header: (name: string, value: string) => void
  }
  captured: CapturedResponse
} {
  const captured: CapturedResponse = {
    body: undefined,
    status: 0,
    headers: {},
  }
  const ctx = {
    json(body: unknown, status?: number): Response {
      captured.body = body
      captured.status = status ?? 200
      return new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      })
    },
    header(name: string, value: string): void {
      captured.headers[name] = value
    },
  }
  return { ctx, captured }
}

describe("forwardError", () => {
  test("CopilotAuthFatalError: clears githubToken and returns auth_fatal body", async () => {
    state.githubToken = "gho_pretend_real"
    const { ctx, captured } = makeContextStub()
    const error = new CopilotAuthFatalError(
      "tos",
      403,
      "https://github.com/site/terms",
    )

    const response = await forwardError(
      ctx as unknown as Parameters<typeof forwardError>[0],
      error,
    )

    expect(state.githubToken).toBeUndefined()
    expect(captured.status).toBe(403)
    expect(response.status).toBe(403)
    expect(captured.body).toEqual({
      error: {
        message: "tos",
        type: "auth_fatal",
        remediation_url: "https://github.com/site/terms",
      },
    })
  })

  test("CopilotAuthFatalError without remediation URL: omits remediation_url field", async () => {
    state.githubToken = "gho_pretend_real"
    const { ctx, captured } = makeContextStub()
    const error = new CopilotAuthFatalError("subscription_lapsed", 401, null)

    await forwardError(
      ctx as unknown as Parameters<typeof forwardError>[0],
      error,
    )

    expect(state.githubToken).toBeUndefined()
    expect(captured.status).toBe(401)
    expect(captured.body).toEqual({
      error: {
        message: "subscription_lapsed",
        type: "auth_fatal",
      },
    })
  })

  test("HTTPError: leaves githubToken untouched and forwards upstream status", async () => {
    state.githubToken = "gho_pretend_real"
    const { ctx, captured } = makeContextStub()
    const upstream = new Response("nope", { status: 429 })
    const error = new HTTPError("nope", upstream)

    const response = await forwardError(
      ctx as unknown as Parameters<typeof forwardError>[0],
      error,
    )

    expect(state.githubToken).toBe("gho_pretend_real")
    expect(captured.status).toBe(429)
    expect(response.status).toBe(429)
    expect((captured.body as { error: { type: string } }).error.type).toBe(
      "error",
    )
  })
})
