import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/anthropic-types"

import {
  mergeToolResultForClaude,
  prepareMessagesApiPayload,
  stripToolReferenceTurnBoundary,
} from "../src/routes/messages/preprocess"

describe("mergeToolResultForClaude", () => {
  test("removes tool reference turn boundaries before merging", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
            {
              type: "text",
              text: "Tool loaded.",
            },
          ],
        },
      ],
    }

    stripToolReferenceTurnBoundary(payload)
    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
        },
      ],
    })
  })

  test("keeps Tool loaded text when the message has no tool_reference", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Launching skill: foo",
            },
            {
              type: "text",
              text: "Tool loaded.",
            },
          ],
        },
      ],
    }

    stripToolReferenceTurnBoundary(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo",
        },
        {
          type: "text",
          text: "Tool loaded.",
        },
      ],
    })
  })

  test("merges text blocks into matching tool_result blocks", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Launching skill: foo",
            },
            {
              type: "text",
              text: "Follow-up details",
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo\n\nFollow-up details",
        },
      ],
    })
  })

  test("appends all text blocks to the last tool_result when counts differ", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "first",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: "second",
            },
            {
              type: "text",
              text: "extra one",
            },
            {
              type: "text",
              text: "extra two",
            },
            {
              type: "text",
              text: "extra three",
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "first",
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: "second\n\nextra one\n\nextra two\n\nextra three",
        },
      ],
    })
  })
})

describe("mergeToolResultForClaude attachments", () => {
  test("merges attachments into matching tool_result blocks when counts match", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "first output",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: "second output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
            },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "pdf-data",
              },
              title: "report.pdf",
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "text",
              text: "first output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
            },
          ],
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: [
            {
              type: "text",
              text: "second output",
            },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "pdf-data",
              },
              title: "report.pdf",
            },
          ],
        },
      ],
    })
  })

  test("appends image and document blocks to the last tool_result", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "binary output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
            },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "pdf-data",
              },
              title: "report.pdf",
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "text",
              text: "binary output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
            },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "pdf-data",
              },
              title: "report.pdf",
            },
          ],
        },
      ],
    })
  })
})

describe("mergeToolResultForClaude attachments fallback", () => {
  test("appends all attachments to the last tool_result when counts differ", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "first output",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: "second output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data-1",
              },
            },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "pdf-data",
              },
              title: "report.pdf",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "image-data-2",
              },
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "first output",
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: [
            {
              type: "text",
              text: "second output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data-1",
              },
            },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "pdf-data",
              },
              title: "report.pdf",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "image-data-2",
              },
            },
          ],
        },
      ],
    })
  })

  test("keeps text merging and appends attachments to the last tool_result", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "first",
            },
            {
              type: "text",
              text: "first detail",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: "second",
            },
            {
              type: "text",
              text: "second detail",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "first\n\nfirst detail",
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: [
            {
              type: "text",
              text: "second\n\nsecond detail",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
            },
          ],
        },
      ],
    })
  })
})

describe("mergeToolResultForClaude attachments with tool_reference", () => {
  test("falls back to the last tool_result without tool_reference", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "binary output",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "text",
              text: "binary output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
            },
          ],
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
        },
      ],
    })
  })
})

describe("prepareMessagesApiPayload", () => {
  test("strips cache_control scope, filters thinking blocks, and enables adaptive thinking", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      system: [
        {
          type: "text",
          text: "system prompt",
          cache_control: {
            type: "ephemeral",
            scope: "user",
          },
        } as AnthropicMessagesPayload["system"] extends Array<infer T> ? T
        : never,
      ],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Thinking...",
              signature: "sig-1",
            },
            {
              type: "thinking",
              thinking: "Keep this",
              signature: "sig-2",
            },
            {
              type: "thinking",
              thinking: "Drop this too",
              signature: "bad@sig",
            },
            {
              type: "text",
              text: "Visible text",
            },
          ],
        },
        {
          role: "user",
          content: "hello",
        },
      ],
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    const systemBlock = (
      payload.system as unknown as Array<Record<string, unknown>>
    )[0]
    expect(systemBlock).toEqual({
      type: "text",
      text: "system prompt",
      cache_control: {
        type: "ephemeral",
      },
    })
    expect(payload.messages[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Keep this",
          signature: "sig-2",
        },
        {
          type: "text",
          text: "Visible text",
        },
      ],
    })
    expect(payload.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    })
    expect(payload.output_config).toEqual({ effort: "xhigh" })
  })

  test("does not enable adaptive thinking when tool choice forces tool use", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tool_choice: {
        type: "tool",
        name: "apply_patch",
      },
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.thinking).toBeUndefined()
    expect(payload.output_config).toBeUndefined()
  })

  test("drops top_p when temperature and top_p are both present on a non-adaptive model", () => {
    // Reproduces the Claude Code <= 2.1.159 400: clients send both temperature
    // and top_p, which api.anthropic.com accepts but Copilot's Bedrock-backed
    // Claude rejects. sonnet-4.5 / opus-4.5 have adaptive_thinking: false, so the
    // capability-gated strip never fired and both params reached Copilot.
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      temperature: 1,
      top_p: 0.95,
      messages: [{ role: "user", content: "hello" }],
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: false,
        },
      },
    } as never)

    // temperature kept, top_p dropped — never both together.
    expect(payload.temperature).toBe(1)
    expect(payload.top_p).toBeUndefined()
  })

  test("keeps temperature alone untouched on a non-adaptive model", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      temperature: 0.7,
      messages: [{ role: "user", content: "hello" }],
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: false,
        },
      },
    } as never)

    expect(payload.temperature).toBe(0.7)
    expect(payload.top_p).toBeUndefined()
  })

  test("keeps top_p alone untouched on a non-adaptive model", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      top_p: 0.9,
      messages: [{ role: "user", content: "hello" }],
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: false,
        },
      },
    } as never)

    expect(payload.top_p).toBe(0.9)
    expect(payload.temperature).toBeUndefined()
  })
})
