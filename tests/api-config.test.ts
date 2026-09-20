import { afterEach, expect, test } from "bun:test"

import {
  copilotHeaders,
  prepareForCompact,
  prepareMessageProxyHeaders,
} from "../src/lib/config/api-config"
import { getConfig, writeConfig } from "../src/lib/config/config"
import {
  COMPACT_AUTO_CONTINUE,
  COMPACT_REQUEST,
} from "../src/lib/models/compact"
import { cacheVSCodeVersion } from "../src/lib/platform/utils"
import { state } from "../src/lib/runtime-state/state"

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
    "vscode_claude_code/2.1.278 (external, sdk-ts, agent-sdk/0.2.278)",
  )
  expect(headers["x-request-id"]).toBeDefined()
  expect(headers["x-agent-task-id"]).toBe(headers["x-request-id"])
})

test("copilotHeaders emits the current Copilot client profile", () => {
  delete process.env.COPILOT_API_OAUTH_APP

  const headers = copilotHeaders({
    accountType: "individual",
    manualApprove: false,
    rateLimitWait: false,
    showToken: false,
    verbose: false,
    vsCodeDeviceId: "device-1",
    vsCodeVersion: "1.138.0",
  })

  expect(headers["editor-version"]).toBe("vscode/1.138.0")
  expect(headers["editor-plugin-version"]).toBe("copilot-chat/0.48.1")
  expect(headers["user-agent"]).toBe("GitHubCopilotChat/0.48.1")
  expect(headers["x-github-api-version"]).toBe("2026-08-01")
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

test("cacheVSCodeVersion defaults to the current stable editor identity", async () => {
  const originalConfig = getConfig()
  const originalVersion = state.vsCodeVersion
  try {
    writeConfig({ ...originalConfig, editorVersion: undefined })
    await cacheVSCodeVersion()
    expect(state.vsCodeVersion).toBe("1.138.0")
  } finally {
    writeConfig(originalConfig)
    state.vsCodeVersion = originalVersion
  }
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
