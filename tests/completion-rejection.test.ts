/**
 * Auth-fatal vs non-fatal-sidecar discrimination across the three Copilot
 * completion services (createMessages, createChatCompletions, createResponses).
 *
 * The route-handler-side forwardError branch lives in a sibling file
 * (tests/forward-error-auth-fatal.test.ts) so that file can stub
 * node:fs/promises via mock.module without dragging the service tests
 * through a dynamic-import chain that misbehaves on CI Linux (the create-
 * responses module specifically returned a successful object instead of
 * throwing on 4xx — symptom of stale module bindings under mock.module).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/anthropic-types"
import type { CopilotAuthFatalError as CopilotAuthFatalErrorType } from "~/lib/error"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { CopilotAuthFatalError, HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import { createResponses } from "~/services/copilot/create-responses"

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

const okBody = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  model: "claude-test",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}

// --- createMessages ----------------------------------------------------------

describe("createMessages", () => {
  test("happy path: returns parsed JSON and clears stale rejection", async () => {
    state.lastUpstreamRejection = {
      message: "stale",
      remediationUrl: null,
      status: 429,
      at: new Date().toISOString(),
    }
    installFetchMock(200, okBody)

    const result = await createMessages(
      messagesPayload,
      undefined,
      messagesOpts,
    )

    expect(result).toBeDefined()
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
    expect((caught as CopilotAuthFatalErrorType).status).toBe(403)
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
    expect(state.lastUpstreamRejection?.status).toBe(429)
    expect(state.lastUpstreamRejection?.remediationUrl).toBe(
      "https://github.com/settings/copilot",
    )
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
    expect(state.lastUpstreamRejection?.status).toBe(403)
    expect(state.lastUpstreamRejection?.message).toBe(
      "Model not available on your plan",
    )
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
      await createResponses({ ...responsesPayload }, { ...responsesOpts })
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
      await createResponses({ ...responsesPayload }, { ...responsesOpts })
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
      await createResponses({ ...responsesPayload }, { ...responsesOpts })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(HTTPError)
    expect(caught).not.toBeInstanceOf(CopilotAuthFatalError)
    expect(state.lastUpstreamRejection?.status).toBe(403)
  })
})
