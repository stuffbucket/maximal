import { afterEach, expect, test } from "bun:test"

import type { State } from "../src/lib/runtime-state/state"

import {
  copilotHeaders,
  copilotModelsHeaders,
  prepareForCompact,
  prepareMessageProxyHeaders,
} from "../src/lib/config/api-config"
import {
  COMPACT_AUTO_CONTINUE,
  COMPACT_REQUEST,
} from "../src/lib/models/compact"

// The opencode branches of copilotHeaders / copilotModelsHeaders early-return
// without reading State, so a bare cast is sufficient for those assertions.
const fakeState = {} as State

const originalOauthApp = process.env.COPILOT_API_OAUTH_APP

afterEach(() => {
  if (originalOauthApp === undefined) {
    delete process.env.COPILOT_API_OAUTH_APP
    return
  }

  process.env.COPILOT_API_OAUTH_APP = originalOauthApp
})

test("prepareMessageProxyHeaders applies message proxy headers by default", () => {
  delete process.env.COPILOT_API_OAUTH_APP

  const headers: Record<string, string> = {
    "user-agent": "GitHubCopilotChat/0.42.3",
  }

  prepareMessageProxyHeaders(headers)

  expect(headers["x-interaction-type"]).toBe("messages-proxy")
  expect(headers["openai-intent"]).toBe("messages-proxy")
  expect(headers["user-agent"]).toBe(
    "vscode_claude_code/2.1.208 (external, sdk-ts, agent-sdk/0.2.112)",
  )
  expect(headers["x-request-id"]).toBeDefined()
  expect(headers["x-agent-task-id"]).toBe(headers["x-request-id"])
})

test("prepareMessageProxyHeaders leaves opencode headers untouched", () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  const headers: Record<string, string> = {
    "Openai-Intent": "conversation-edits",
    "User-Agent": "opencode/1.0.0",
  }

  prepareMessageProxyHeaders(headers)

  expect(headers).toEqual({
    "Openai-Intent": "conversation-edits",
    "User-Agent": "opencode/1.0.0",
  })
})

test("copilotHeaders sends X-GitHub-Api-Version on the opencode branch", () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  const headers = copilotHeaders(fakeState)

  expect(headers["X-GitHub-Api-Version"]).toBe("2026-06-01")
})

test("copilotModelsHeaders sends X-GitHub-Api-Version on the opencode branch", () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  const headers = copilotModelsHeaders(fakeState)

  expect(headers["X-GitHub-Api-Version"]).toBe("2026-06-01")
})

test("copilot headers do not add the opencode api version on the default branch", () => {
  delete process.env.COPILOT_API_OAUTH_APP

  const completions = copilotHeaders(fakeState)
  const models = copilotModelsHeaders(fakeState)

  // The default (vscode-copilot) branch keeps its own lowercase pin and must
  // not carry the opencode-only 2026-06-01 value.
  expect(completions["X-GitHub-Api-Version"]).toBeUndefined()
  expect(completions["x-github-api-version"]).not.toBe("2026-06-01")
  expect(models["X-GitHub-Api-Version"]).toBeUndefined()
  expect(models["x-github-api-version"]).not.toBe("2026-06-01")
})

test("prepareForCompact marks compact traffic as agent initiated", () => {
  const compactHeaders: Record<string, string> = { "x-initiator": "user" }
  const autoContinueHeaders: Record<string, string> = { "x-initiator": "user" }
  const normalHeaders: Record<string, string> = { "x-initiator": "user" }

  prepareForCompact(compactHeaders, COMPACT_REQUEST)
  prepareForCompact(autoContinueHeaders, COMPACT_AUTO_CONTINUE)
  prepareForCompact(normalHeaders, 0)

  expect(compactHeaders["x-initiator"]).toBe("agent")
  expect(autoContinueHeaders["x-initiator"]).toBe("agent")
  expect(normalHeaders["x-initiator"]).toBe("user")
})
