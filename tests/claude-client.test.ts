/**
 * Claude's agent clients all send `claude-cli/<version> (external,
 * <entrypoint>[, ...])`; the entrypoint says which app is calling. These
 * strings are what Claude Code, Claude Desktop and Cowork actually send.
 */

import { describe, expect, test } from "bun:test"

import { classifyClaudeClient } from "~/lib/http/claude-client"

describe("classifyClaudeClient", () => {
  test.each([
    ["claude-cli/2.1.278 (external, cli)", "claude-code"],
    ["claude-cli/2.1.278 (external, sdk-ts)", "claude-code"],
    ["claude-cli/2.1.278", "claude-code"],
    ["claude-cli/2.1.278 (external, claude-desktop)", "claude-desktop"],
    ["claude-cli/2.1.278 (external, claude-desktop-3p)", "claude-desktop"],
    [
      "claude-cli/2.1.278 (external, claude-desktop, agent-sdk/0.2.1)",
      "claude-desktop",
    ],
    ["claude-cli/2.1.278 (external, local-agent)", "cowork"],
    ["Claude-Code/2.1.0", "claude-code"],
    ["claude-code/1.0.0 (external, cli)", "claude-code"],
    ["claude-cli/2.1.278 (external, constructor)", "claude-code"],
  ] as const)("%s → %s", (ua, expected) => {
    expect(classifyClaudeClient(ua)).toBe(expected)
  })

  test.each([
    "Anthropic/Python 0.8",
    "curl/8.0",
    "claude-desktop/1.0",
    "my-claude-cli/1.0",
    "",
  ])("%p is not a Claude agent client", (ua) => {
    expect(classifyClaudeClient(ua)).toBeNull()
  })
})
