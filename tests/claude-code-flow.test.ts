import { describe, expect, it } from "bun:test"

import { buildClaudeCodeEnv } from "~/lib/start/claude-code-flow"

describe("buildClaudeCodeEnv", () => {
  it("disables the unsupported Auto mode server request", () => {
    expect(
      buildClaudeCodeEnv("http://127.0.0.1:4141", "primary", "small"),
    ).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4141",
      ANTHROPIC_MODEL: "primary",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "small",
      CLAUDE_CODE_AUTO_MODE_SERVER: "0",
    })
  })
})
