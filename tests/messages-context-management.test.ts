import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import { state } from "~/lib/runtime-state/state"
import { createMessages } from "~/services/copilot/create-messages"

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
  copilotToken: state.copilotToken,
  userName: state.userName,
  vsCodeVersion: state.vsCodeVersion,
  models: state.models,
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

type ContextManagementPayload = AnthropicMessagesPayload & {
  context_management: {
    edits: Array<{ type: string }>
  }
}

function payload(model: string): ContextManagementPayload {
  return {
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
    context_management: {
      edits: [{ type: "clear_thinking_20251015" }],
    },
  }
}

function parseRequestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new TypeError("Expected JSON body")
  return JSON.parse(init.body) as Record<string, unknown>
}

beforeEach(() => {
  state.accountType = "individual"
  state.copilotApiUrl = undefined
  state.copilotToken = "copilot_test"
  state.userName = "context-test-user"
  state.vsCodeVersion = "1.0.0"
})

afterEach(() => {
  state.accountType = originalState.accountType
  state.copilotApiUrl = originalState.copilotApiUrl
  state.copilotToken = originalState.copilotToken
  state.userName = originalState.userName
  state.vsCodeVersion = originalState.vsCodeVersion
  state.models = originalState.models
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

describe("Messages context-management compatibility", () => {
  test("retries a context-specific 400 without context editing and remembers the rejection", async () => {
    const sentBodies: Array<Record<string, unknown>> = []
    const sentBetaHeaders: Array<string | null> = []
    let call = 0
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      sentBodies.push(parseRequestBody(init))
      sentBetaHeaders.push(new Headers(init?.headers).get("anthropic-beta"))
      call += 1
      if (call === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message:
                  "context_management.edits.0: Extra inputs are not permitted",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify(okBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch

    const request = payload("claude-context-rejected-test")
    await createMessages(
      request,
      "context-management-2025-06-27,advanced-tool-use-2025-11-20",
      { requestId: "rid-1" },
    )
    await createMessages(
      request,
      "context-management-2025-06-27,advanced-tool-use-2025-11-20",
      { requestId: "rid-2" },
    )

    expect(sentBodies).toHaveLength(3)
    expect(sentBodies[0].context_management).toBeDefined()
    expect("context_management" in sentBodies[1]).toBe(false)
    expect("context_management" in sentBodies[2]).toBe(false)
    expect(sentBetaHeaders).toEqual([
      "context-management-2025-06-27,advanced-tool-use-2025-11-20",
      "advanced-tool-use-2025-11-20",
      "advanced-tool-use-2025-11-20",
    ])
  })

  test("does not retry a 400 unrelated to context management", async () => {
    let calls = 0
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (() => {
      calls += 1
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: "max_tokens must be greater than zero",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      )
    }) as unknown as typeof fetch

    let caught: unknown = null
    try {
      await createMessages(
        payload("claude-unrelated-rejection-test"),
        "context-management-2025-06-27",
        { requestId: "rid-unrelated" },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeDefined()
    expect(calls).toBe(1)
  })

  test("omits context editing when the catalog explicitly declares it unsupported", async () => {
    const sentBodies: Array<Record<string, unknown>> = []
    const sentBetaHeaders: Array<string | null> = []
    state.models = {
      object: "list",
      data: [
        {
          id: "claude-advertised-unsupported-test",
          name: "Test",
          object: "model",
          vendor: "Anthropic",
          version: "1",
          preview: false,
          model_picker_enabled: true,
          supported_endpoints: ["/v1/messages"],
          capabilities: {
            family: "claude",
            type: "chat",
            tokenizer: "o200k_base",
            object: "model_capabilities",
            limits: {},
            supports: { context_editing: false },
          },
        },
      ],
    }
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      sentBodies.push(parseRequestBody(init))
      sentBetaHeaders.push(new Headers(init?.headers).get("anthropic-beta"))
      return Promise.resolve(
        new Response(JSON.stringify(okBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch

    await createMessages(
      payload("claude-advertised-unsupported-test"),
      "context-management-2025-06-27,advanced-tool-use-2025-11-20",
      { requestId: "rid-advertised" },
    )

    expect(sentBodies).toHaveLength(1)
    expect("context_management" in sentBodies[0]).toBe(false)
    expect(sentBetaHeaders).toEqual(["advanced-tool-use-2025-11-20"])
  })
})
