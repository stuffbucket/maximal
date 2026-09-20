import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/models/anthropic-types"

import { state } from "~/lib/runtime-state/state"
import { createMessages } from "~/services/copilot/create-messages"

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
}

beforeEach(() => {
  state.accountType = "individual"
  state.copilotApiUrl = undefined
  state.copilotToken = "copilot_test"
  state.vsCodeVersion = "1.0.0"
})

afterEach(() => {
  state.accountType = originalState.accountType
  state.copilotApiUrl = originalState.copilotApiUrl
  state.copilotToken = originalState.copilotToken
  state.vsCodeVersion = originalState.vsCodeVersion
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

describe("native Messages wire preservation", () => {
  test("passes safeguards through and returns safeguard_results unchanged", async () => {
    const safeguards = {
      mode: "auto",
      classifier_version: "test-version",
      nested: { preserve: true },
    }
    const safeguardResults = {
      safe: true,
      reason: "test-verdict",
      nested: { preserve: true },
    }
    let sentBody: Record<string, unknown> | undefined
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      let requestUrl: string
      if (typeof url === "string") requestUrl = url
      else if (url instanceof URL) requestUrl = url.href
      else requestUrl = url.url
      expect(requestUrl).toEndWith("/v1/messages")
      if (typeof init?.body !== "string") {
        throw new TypeError("Expected JSON request body")
      }
      sentBody = JSON.parse(init.body) as Record<string, unknown>
      return Promise.resolve(
        Response.json({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-test",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
          safeguard_results: safeguardResults,
        }),
      )
    }) as unknown as typeof fetch

    const payload: AnthropicMessagesPayload & {
      safeguards: Record<string, unknown>
    } = {
      model: "claude-test",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
      safeguards,
    }

    const result = (await createMessages(payload, undefined, {
      requestId: "rid-safeguards",
    })) as AnthropicResponse & { safeguard_results: Record<string, unknown> }

    expect(sentBody?.safeguards).toEqual(safeguards)
    expect(result.safeguard_results).toEqual(safeguardResults)
  })
})
